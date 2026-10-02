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

function registrarVenta(registro) {
  const completo = Object.assign({ id: 'V' + Date.now().toString(36), fecha: ahoraIso() }, registro);
  if (USAR_SHEETS) return completo;
  leerDisco().ventas.push(completo);
  guardarDisco();
  return completo;
}

function registrarConsignacion(registro) {
  const completo = Object.assign({ id: 'C' + Date.now().toString(36), fecha: ahoraIso() }, registro);
  if (USAR_SHEETS) return completo;
  leerDisco().consignaciones.push(completo);
  guardarDisco();
  return completo;
}

function actualizarConsignacion(id, cambios) {
  if (USAR_SHEETS) return null;
  const lista = leerDisco().consignaciones;
  const encontrada = lista.find((c) => c.id === id);
  if (!encontrada) return null;
  Object.assign(encontrada, cambios);
  guardarDisco();
  return encontrada;
}

function eliminarConsignacion(id) {
  if (USAR_SHEETS) return false;
  const datos = leerDisco();
  const antes = datos.consignaciones.length;
  datos.consignaciones = datos.consignaciones.filter((c) => c.id !== id);
  if (datos.consignaciones.length === antes) return false;
  guardarDisco();
  return true;
}

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
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function listarVentas(filtro = {}) {
  let ventas;
  if (USAR_SHEETS) {
    const respuesta = await inventory.escribir({ tipoOperacion: 'REPORTE_VENTAS' });
    ventas = Array.isArray(respuesta) ? respuesta.map(normalizarVenta) : [];
  } else {
    ventas = leerDisco().ventas.slice();
  }

  const vendedor = normalizarTexto(filtro.vendedor);
  return ventas.filter((v) => {
    if (!enRango(v.fecha, filtro.desde, filtro.hasta)) return false;
    if (vendedor && normalizarTexto(v.vendedor).indexOf(vendedor) === -1) return false;
    return true;
  });
}

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
    precioUnitarioBs: num(f.precioUnitarioBs !== undefined ? f.precioUnitarioBs : f.precioUnitario),
    costoTotalBs: num(f.costoTotalBs !== undefined ? f.costoTotalBs : f.costoTotal),
    totalCobradoBs: num(f.totalCobradoBs !== undefined ? f.totalCobradoBs : f.totalCobrado),
    gananciaBs: num(f.gananciaBs !== undefined ? f.gananciaBs : f.gananciaRegistrada),
    comisionBs: num(f.comisionBs !== undefined ? f.comisionBs : f.comision),
  };
}

async function listarConsignaciones(filtro = {}) {
  let lista;
  if (USAR_SHEETS) {
    const respuesta = await inventory.escribir({ tipoOperacion: 'REPORTE_CONSIGNACIONES' });
    lista = Array.isArray(respuesta) ? respuesta : [];
  } else {
    lista = leerDisco().consignaciones.slice();
  }
  return lista.filter((c) => enRango(c.fecha, filtro.desde, filtro.hasta));
}

function acumular(destino, clave, valores) {
  if (!destino[clave]) {
    destino[clave] = {
      ventas: 0,
      unidades: 0,
      ganancia: 0,
      comision: 0,
    };
  }
  const fila = destino[clave];
  fila.ventas += valores.venta;
  fila.unidades += valores.unidades;
  fila.ganancia += valores.ganancia;
  fila.comision += valores.comision;
  return fila;
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

    const valores = { venta: cobrado, unidades: cantidad, ganancia: ganancia, comision: comision };
    acumular(porVendedor, String(v.vendedor || 'Sin nombre'), valores);
    acumular(porModelo, String(v.modelo || 'Sin modelo'), valores);
    acumular(porDia, diaDe(v.fecha), valores);
  }

  const lista = (mapa, campo) =>
    Object.keys(mapa)
      .map((clave) =>
        Object.assign({ clave: clave }, mapa[clave], { [campo]: clave })
      )
      .sort((a, b) => b.ventas - a.ventas);

  return {
    totalVendidoBs: redondear(totalVendido),
    totalGananciaBs: redondear(totalGanancia),
    totalComisionesBs: redondear(totalComisiones),
    unidades: unidades,
    cantidadVentas: ventas.length,
    ticketPromedioBs: ventas.length ? redondear(totalVendido / ventas.length) : 0,
    margenPct: totalVendido > 0 ? redondear((totalGanancia / totalVendido) * 100) : 0,
    porVendedor: lista(porVendedor, 'vendedor').map((f) => ({
      vendedor: f.vendedor,
      ventasBs: redondear(f.ventas),
      unidades: f.unidades,
      gananciaBs: redondear(f.ganancia),
      comisionBs: redondear(f.comision),
    })),
    porModelo: lista(porModelo, 'modelo').map((f) => ({
      modelo: f.modelo,
      ventasBs: redondear(f.ventas),
      unidades: f.unidades,
      gananciaBs: redondear(f.ganancia),
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
  modo,
  esEfimero,
  registrarVenta,
  registrarConsignacion,
  actualizarConsignacion,
  eliminarConsignacion,
  listarVentas,
  listarConsignaciones,
  calcularResumen,
  normalizarVenta,
};