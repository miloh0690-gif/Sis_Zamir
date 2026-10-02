'use strict';

const fs = require('node:fs');
const path = require('node:path');
const inventory = require('./inventory');

const RUTA = path.join(__dirname, '..', 'data', 'ventas.json');
const USAR_SHEETS = String(process.env.REPORTES_DESDE_SHEETS || '').trim() === '1';

let memoria = null;

function estructuraVacia() {
  return { ventas: [], consignaciones: [] };
}

function leerDisco() {
  if (memoria) return memoria;
  try {
    const crudo = fs.readFileSync(RUTA, 'utf8');
    const datos = JSON.parse(crudo);
    memoria = {
      ventas: Array.isArray(datos.ventas) ? datos.ventas : [],
      consignaciones: Array.isArray(datos.consignaciones) ? datos.consignaciones : [],
    };
  } catch (e) {
    memoria = estructuraVacia();
  }
  return memoria;
}

function guardarDisco() {
  try {
    fs.mkdirSync(path.dirname(RUTA), { recursive: true });
    const temporal = RUTA + '.tmp';
    fs.writeFileSync(temporal, JSON.stringify(memoria, null, 2), 'utf8');
    fs.renameSync(temporal, RUTA);
    return true;
  } catch (e) {
    console.error('[ledger] No se pudo guardar en disco: ' + e.message);
    return false;
  }
}

function modo() {
  return USAR_SHEETS ? 'sheets' : 'archivo';
}

function esEfimero() {
  return !USAR_SHEETS;
}

function ahoraIso() {
  return new Date().toISOString();
}

function nuevoId(prefijo) {
  return (
    (prefijo || 'R') +
    Date.now().toString(36) +
    Math.floor(Math.random() * 1679616).toString(36)
  );
}

// -----------------------------------------------------------------
// VENTAS
// -----------------------------------------------------------------

function normalizarVenta(fila) {
  const f = fila || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    id: String(f.id || ''),
    fecha: f.fecha ? new Date(f.fecha).toISOString() : ahoraIso(),
    vendedor: String(f.vendedor || ''),
    modelo: String(f.modelo || ''),
    sucursal: String(f.sucursal || ''),
    tipo: String(f.tipo || 'UNIDAD'),
    cantidad: Math.floor(num(f.cantidad)) || 0,
    tipoCambio: num(f.tipoCambio),
    precioUnitarioBs: num(
      f.precioUnitarioBs !== undefined ? f.precioUnitarioBs : f.precioUnitario
    ),
    costoTotalBs: num(f.costoTotalBs !== undefined ? f.costoTotalBs : f.costoTotal),
    totalCobradoBs: num(
      f.totalCobradoBs !== undefined ? f.totalCobradoBs : f.totalCobrado
    ),
    gananciaBs: num(
      f.gananciaBs !== undefined ? f.gananciaBs : f.gananciaRegistrada
    ),
    comisionBs: num(f.comisionBs !== undefined ? f.comisionBs : f.comision),
  };
}

function registrarVenta(registro) {
  const completo = Object.assign({ id: nuevoId('V'), fecha: ahoraIso() }, registro);
  if (USAR_SHEETS) return completo;
  leerDisco().ventas.push(completo);
  guardarDisco();
  return completo;
}

async function listarVentas(filtro) {
  const f = filtro || {};
  let ventas;

  if (USAR_SHEETS) {
    const respuesta = await inventory.escribir({ tipoOperacion: 'REPORTE_VENTAS' });
    ventas = Array.isArray(respuesta) ? respuesta.map(normalizarVenta) : [];
  } else {
    ventas = leerDisco().ventas.slice();
  }

  const vendedor = normalizarTexto(f.vendedor);
  return ventas.filter((v) => {
    if (!enRango(v.fecha, f.desde, f.hasta)) return false;
    if (vendedor && normalizarTexto(v.vendedor).indexOf(vendedor) === -1) return false;
    return true;
  });
}

// -----------------------------------------------------------------
// CONSIGNACIONES
// -----------------------------------------------------------------
// El historial de consignaciones vive como registro de cambios: cada
// evento escribe una fila con el mismo id y el lector se queda con la
// ultima. El motor de archivo, en cambio, reemplaza en el sitio.

async function registrarConsignacion(registro) {
  const completo = Object.assign({ id: nuevoId('C'), fecha: ahoraIso() }, registro);
  if (USAR_SHEETS) {
    // Apps Script ya escribio la fila del evento.
    return completo;
  }
  leerDisco().consignaciones.push(completo);
  guardarDisco();
  return completo;
}

async function actualizarConsignacion(id, cambios) {
  if (USAR_SHEETS) {
    // Apps Script ya escribio la fila del evento.
    return null;
  }
  const lista = leerDisco().consignaciones;
  const encontrada = lista.find((c) => String(c.id) === id);
  if (!encontrada) return null;
  Object.assign(encontrada, cambios);
  guardarDisco();
  return encontrada;
}

async function listarConsignaciones(filtro) {
  const f = filtro || {};
  let lista;

  if (USAR_SHEETS) {
    const respuesta = await inventory.escribir({
      tipoOperacion: 'REPORTE_CONSIGNACIONES',
    });
    lista = Array.isArray(respuesta) ? respuesta : [];
  } else {
    lista = leerDisco().consignaciones.slice();
  }

  return lista.filter((c) => enRango(c.fecha, f.desde, f.hasta));
}

// -----------------------------------------------------------------
// FILTROS Y RESUMEN
// -----------------------------------------------------------------

function diaDe(fechaIso) {
  return String(fechaIso || '').slice(0, 10);
}

function enRango(fechaIso, desde, hasta) {
  const dia = diaDe(fechaIso);
  if (!dia) return true;
  if (desde && dia < desde) return false;
  if (hasta && dia > hasta) return false;
  return true;
}

function normalizarTexto(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function redondear(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function calcularResumen(ventas) {
  const porVendedor = {};
  const porModelo = {};
  const porDia = {};

  let totalVendido = 0;
  let totalGanancia = 0;
  let totalComisiones = 0;
  let unidades = 0;

  for (const v of ventas) {
    const cantidad = Math.floor(Number(v.cantidad)) || 0;
    const cobrado = Number(v.totalCobradoBs) || 0;
    const ganancia = Number(v.gananciaBs) || 0;
    const comision = Number(v.comisionBs) || 0;

    totalVendido += cobrado;
    totalGanancia += ganancia;
    totalComisiones += comision;
    unidades += cantidad;

    const valores = {
      venta: cobrado,
      unidades: cantidad,
      ganancia: ganancia,
      comision: comision,
    };

    if (!porVendedor[String(v.vendedor || 'Sin nombre')]) {
      porVendedor[String(v.vendedor || 'Sin nombre')] = { ventas: 0, unidades: 0, ganancia: 0, comision: 0 };
    }
    if (!porModelo[String(v.modelo || 'Sin modelo')]) {
      porModelo[String(v.modelo || 'Sin modelo')] = { ventas: 0, unidades: 0, ganancia: 0, comision: 0 };
    }
    if (!porDia[diaDe(v.fecha)]) {
      porDia[diaDe(v.fecha)] = { ventas: 0, unidades: 0, ganancia: 0, comision: 0 };
    }

    porVendedor[String(v.vendedor || 'Sin nombre')].ventas += valores.venta;
    porVendedor[String(v.vendedor || 'Sin nombre')].unidades += valores.unidades;
    porVendedor[String(v.vendedor || 'Sin nombre')].ganancia += valores.ganancia;
    porVendedor[String(v.vendedor || 'Sin nombre')].comision += valores.comision;

    porModelo[String(v.modelo || 'Sin modelo')].ventas += valores.venta;
    porModelo[String(v.modelo || 'Sin modelo')].unidades += valores.unidades;
    porModelo[String(v.modelo || 'Sin modelo')].ganancia += valores.ganancia;

    porDia[diaDe(v.fecha)].ventas += valores.venta;
    porDia[diaDe(v.fecha)].unidades += valores.unidades;
    porDia[diaDe(v.fecha)].ganancia += valores.ganancia;
  }

  const ordenarPorVenta = (mapa) =>
    Object.keys(mapa).sort((a, b) => mapa[b].ventas - mapa[a].ventas);

  return {
    totalVendidoBs: redondear(totalVendido),
    totalGananciaBs: redondear(totalGanancia),
    totalComisionesBs: redondear(totalComisiones),
    unidades: unidades,
    cantidadVentas: ventas.length,
    ticketPromedioBs: ventas.length ? redondear(totalVendido / ventas.length) : 0,
    margenPct: totalVendido > 0 ? redondear((totalGanancia / totalVendido) * 100) : 0,
    porVendedor: ordenarPorVenta(porVendedor).map((clave) => ({
      vendedor: clave,
      ventasBs: redondear(porVendedor[clave].ventas),
      unidades: porVendedor[clave].unidades,
      gananciaBs: redondear(porVendedor[clave].ganancia),
      comisionBs: redondear(porVendedor[clave].comision),
    })),
    porModelo: ordenarPorVenta(porModelo).map((clave) => ({
      modelo: clave,
      ventasBs: redondear(porModelo[clave].ventas),
      unidades: porModelo[clave].unidades,
      gananciaBs: redondear(porModelo[clave].ganancia),
    })),
    porDia: Object.keys(porDia)
      .sort()
      .map((dia) => ({
        dia: dia,
        ventasBs: redondear(porDia[dia].ventas),
        unidades: porDia[dia].unidades,
        gananciaBs: redondear(porDia[dia].ganancia),
      })),
  };
}

module.exports = {
  modo: modo,
  esEfimero: esEfimero,
  nuevoId: nuevoId,
  registrarVenta: registrarVenta,
  registrarConsignacion: registrarConsignacion,
  actualizarConsignacion: actualizarConsignacion,
  listarVentas: listarVentas,
  listarConsignaciones: listarConsignaciones,
  calcularResumen: calcularResumen,
  normalizarVenta: normalizarVenta,
};