'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');

const inventory = require('./src/inventory');
const ledger = require('./src/ledger');
const money = require('./src/money');
const ai = require('./src/ai');
const auth = require('./src/auth');

const app = express();
const PUERTO = Number(process.env.PORT) || 10000;

const TASA_COMISION = Number(process.env.TASA_COMISION) || 0.3;
const DESCUENTO_MAYOR_PCT = Number(process.env.DESCUENTO_MAYOR_PCT) || 0;
const TRAMOS_MAYOR = money.parseTramos(process.env.MAYOR_TIERS);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

const golpes = new Map();

function limitar(tope, ventanaMs) {
  return function (req, res, next) {
    const ip = req.ip || 'desconocido';
    const ahora = Date.now();
    const lista = (golpes.get(ip) || []).filter((t) => t > ahora - ventanaMs);
    if (lista.length >= tope) {
      return res.status(429).json({ error: 'Demasiadas peticiones seguidas. Espera un momento.' });
    }
    lista.push(ahora);
    golpes.set(ip, lista);
    next();
  };
}

setInterval(() => {
  const limite = Date.now() - 60000;
  for (const [ip, lista] of golpes) {
    const filtrada = lista.filter((t) => t > limite);
    if (filtrada.length === 0) golpes.delete(ip);
    else golpes.set(ip, filtrada);
  }
}, 60000).unref();

function texto(valor, max) {
  return String(valor === undefined || valor === null ? '' : valor)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function entero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function decimal(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function fecha(valor) {
  const s = String(valor === '' || valor === undefined || valor === null ? '' : valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function sinCosto(producto, autorizado) {
  if (autorizado) return producto;
  const copia = Object.assign({}, producto);
  delete copia.costoUsd;
  return copia;
}

function responderError(res, e) {
  const codigo = e && e.codigo ? e.codigo : 500;
  if (codigo >= 500) console.error('[error]', (e && e.message) || e);
  res.status(codigo).json({ error: (e && e.message) || 'Error inesperado en el servidor.' });
}

function exigirSheets(res) {
  if (!inventory.estaConfigurado()) {
    res.status(503).json({
      error: 'Inventario no disponible: falta SHEETS_WEBAPP_URL en el servidor.',
    });
    return false;
  }
  if (!inventory.tieneClave()) {
    res.status(503).json({
      error: 'Inventario no disponible: falta SHEETS_API_KEY en el servidor.',
    });
    return false;
  }
  return true;
}

function construirCalculo(producto, cuerpo) {
  const c = cuerpo || {};
  return money.calcularVenta({
    costoUsd: producto.costoUsd,
    tipo: c.tipo,
    cantidad: entero(c.cantidad),
    tipoCambio: decimal(c.tipoCambio),
    precioManualBs: c.precioManualBs,
    tasaComision: TASA_COMISION,
    descuentoMayorPct: DESCUENTO_MAYOR_PCT,
    tramosMayor: TRAMOS_MAYOR,
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hora: new Date().toISOString(),
    sheets: inventory.completo(),
    sheetsUrl: inventory.estaConfigurado(),
    sheetsClave: inventory.tieneClave(),
    reportes: ledger.modo(),
    ia: ai.habilitado(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    sheets: inventory.completo(),
    sheetsUrl: inventory.estaConfigurado(),
    sheetsClave: inventory.tieneClave(),
    ia: ai.habilitado(),
    iaModelo: ai.habilitado() ? ai.modelo : null,
    tasaComision: TASA_COMISION,
    descuentoMayorPct: DESCUENTO_MAYOR_PCT,
    tramosMayor: TRAMOS_MAYOR,
    reportes: ledger.modo(),
    reportesEfimeros: ledger.esEfimero(),
  });
});

app.post('/api/auth/login', limitar(10, 60000), (req, res) => {
  const pin = texto(req.body && req.body.pin, 20);
  const guardado = process.env.ADMIN_PIN_HASH || '';
  if (!guardado) {
    return res.status(503).json({ error: 'ADMIN_PIN_HASH no esta configurado en el servidor.' });
  }
  if (!auth.verificarPin(pin, guardado)) {
    return res.status(401).json({ error: 'PIN incorrecto.' });
  }
  const token = auth.firmar({ exp: Date.now() + auth.DURACION_MS });
  res.setHeader('Set-Cookie', auth.crearCookie(token));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.borrarCookie());
  res.json({ ok: true });
});

app.get('/api/auth/session', (req, res) => {
  res.json({ autenticado: auth.estaAutenticado(req) });
});

app.get('/api/inventario', limitar(60, 60000), async (req, res) => {
  try {
    if (!exigirSheets(res)) return;
    const lista = await inventory.listar();
    const autorizado = auth.estaAutenticado(req);
    res.json({ productos: lista.map((p) => sinCosto(p, autorizado)) });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas/preview', limitar(120, 60000), async (req, res) => {
  try {
    if (!exigirSheets(res)) return;
    const modelo = texto(req.body && req.body.modelo, 120);
    if (!modelo) return res.json({ encontrado: false, motivo: 'vacio' });
    const producto = await inventory.buscar(modelo);
    if (!producto) return res.json({ encontrado: false, motivo: 'no_existe' });
    res.json({
      encontrado: true,
      modelo: producto.modelo,
      stock: producto.stock,
      sucursal: producto.sucursal,
      calculo: construirCalculo(producto, req.body),
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas', limitar(60, 60000), async (req, res) => {
  try {
    if (!exigirSheets(res)) return;
    const cuerpo = req.body || {};
    const vendedor = texto(cuerpo.vendedor, 80);
    const modeloTexto = texto(cuerpo.modelo, 120);
    const cantidad = entero(cuerpo.cantidad);
    const tipoCambio = decimal(cuerpo.tipoCambio);

    if (!vendedor) return res.status(400).json({ error: 'Ingresa el nombre del vendedor.' });
    if (!modeloTexto) return res.status(400).json({ error: 'Ingresa o selecciona un modelo.' });
    if (cantidad <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
    if (!(tipoCambio > 0)) return res.status(400).json({ error: 'El tipo de cambio debe ser mayor a 0.' });

    const producto = await inventory.buscar(modeloTexto);
    if (!producto) {
      return res.status(400).json({ error: 'Ese modelo no existe en el inventario.' });
    }
    if (producto.stock < cantidad) {
      return res.status(409).json({
        error: 'Stock insuficiente. Solo quedan ' + producto.stock + ' unidades de ' + producto.modelo + '.',
      });
    }

    const calculo = construirCalculo(producto, cuerpo);
    if (!(calculo.precioUnitarioBs > 0)) {
      return res.status(400).json({ error: 'El precio debe ser mayor a 0.' });
    }

    const fechaIso = new Date().toISOString();
    const registro = {
      fecha: fechaIso,
      vendedor: vendedor,
      modelo: producto.modelo,
      sucursal: producto.sucursal,
      tipo: calculo.tipo,
      cantidad: cantidad,
      tipoCambio: calculo.tipoCambio,
      precioUnitarioBs: calculo.precioUnitarioBs,
      costoUnitarioBs: calculo.costoUnitarioBs,
      costoTotalBs: calculo.costoTotalBs,
      totalCobradoBs: calculo.totalCobradoBs,
      gananciaBs: calculo.gananciaBs,
      comisionBs: calculo.comisionBs,
      descuentoAplicadoPct: calculo.descuentoAplicadoPct,
      filaExcel: producto.filaExcel,
    };

    // Si Apps Script rechaza (fila movida, stock racedado) esto lanza y
    // no se toca el historial, asi que no queda una venta fantasma.
    await inventory.escribir({
      tipoOperacion: 'VENTA',
      filaExcel: producto.filaExcel,
      fecha: fechaIso,
      vendedor: vendedor,
      modelo: producto.modelo,
      sucursal: producto.sucursal,
      tipo: calculo.tipo,
      cantidad: cantidad,
      tipoCambio: calculo.tipoCambio,
      precioUnitarioBs: calculo.precioUnitarioBs,
      costoUnitarioBs: calculo.costoUnitarioBs,
      costoTotalBs: calculo.costoTotalBs,
      totalCobrado: calculo.totalCobradoBs,
      gananciaRegistrada: calculo.gananciaBs,
      comision: calculo.comisionBs,
    });

    let advertencia = null;
    try {
      await ledger.registrarVenta(registro);
    } catch (e) {
      advertencia = 'La venta se guardo en Sheets pero no en el historial de reportes.';
      console.error('[ledger]', e.message);
    }

    const lista = await inventory.listar({ forzar: true });
    const actualizado = inventory.buscarEn(lista, producto.modelo);

    res.status(201).json({
      venta: ledger.normalizarVenta(registro),
      calculo: calculo,
      stockRestante: actualizado ? actualizado.stock : Math.max(0, producto.stock - cantidad),
      advertencia: advertencia,
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/consignaciones', limitar(60, 60000), async (req, res) => {
  try {
    const lista = await ledger.listarConsignaciones({
      desde: fecha(req.query.desde),
      hasta: fecha(req.query.hasta),
    });
    res.json({ consignaciones: lista.filter((c) => c.estado !== 'Devuelto') });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/consignaciones', limitar(60, 60000), async (req, res) => {
  try {
    if (!exigirSheets(res)) return;
    const cuerpo = req.body || {};
    const cliente = texto(cuerpo.cliente, 80);
    const modeloTexto = texto(cuerpo.modelo, 120);
    const cantidad = entero(cuerpo.cantidad);

    if (!cliente) return res.status(400).json({ error: 'Ingresa el responsable.' });
    if (!modeloTexto) return res.status(400).json({ error: 'Ingresa o selecciona un modelo.' });
    if (cantidad <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });

    const producto = await inventory.buscar(modeloTexto);
    if (!producto) return res.status(400).json({ error: 'Ese modelo no existe en el inventario.' });
    if (producto.stock < cantidad) {
      return res.status(409).json({
        error: 'Stock insuficiente. Solo quedan ' + producto.stock + ' unidades.',
      });
    }

    const id = ledger.nuevoId('C');
    const fechaIso = new Date().toISOString();

    await inventory.escribir({
      tipoOperacion: 'CONSIGNACION',
      subTipo: 'DESPACHO',
      id: id,
      filaExcel: producto.filaExcel,
      fecha: fechaIso,
      cliente: cliente,
      modelo: producto.modelo,
      cantidad: cantidad,
      sucursal: producto.sucursal,
      estado: 'Pendiente',
    });

    let advertencia = null;
    let consignacion;
    try {
      consignacion = await ledger.registrarConsignacion({
        id: id,
        fecha: fechaIso,
        cliente: cliente,
        modelo: producto.modelo,
        sucursal: producto.sucursal,
        cantidad: cantidad,
        estado: 'Pendiente',
        filaExcel: producto.filaExcel,
      });
    } catch (e) {
      advertencia = 'Se desconto el stock pero no se guardo el registro de consignacion.';
      consignacion = {
        id: id,
        fecha: fechaIso,
        cliente: cliente,
        modelo: producto.modelo,
        sucursal: producto.sucursal,
        cantidad: cantidad,
        estado: 'Pendiente',
        filaExcel: producto.filaExcel,
      };
      console.error('[ledger]', e.message);
    }

    const lista = await inventory.listar({ forzar: true });
    const actualizado = inventory.buscarEn(lista, producto.modelo);

    res.status(201).json({
      consignacion: consignacion,
      stockRestante: actualizado ? actualizado.stock : Math.max(0, producto.stock - cantidad),
      advertencia: advertencia,
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/consignaciones/estado', limitar(60, 60000), async (req, res) => {
  try {
    const id = texto(req.body && req.body.id, 60);
    const todas = await ledger.listarConsignaciones({});
    const actual = todas.find((c) => String(c.id) === id);
    if (!actual) return res.status(404).json({ error: 'No se encontro esa consignacion.' });

    const nuevo = texto(req.body && req.body.estado, 20) === 'Pagado' ? 'Pagado' : 'Pendiente';

    await inventory.escribir({
      tipoOperacion: 'CONSIGNACION',
      subTipo: 'CAMBIO_ESTADO',
      id: id,
      filaExcel: actual.filaExcel,
      fecha: actual.fecha,
      cliente: actual.cliente,
      modelo: actual.modelo,
      cantidad: actual.cantidad,
      sucursal: actual.sucursal,
      estado: nuevo,
    });

    await ledger.actualizarConsignacion(id, { estado: nuevo });

    res.json({ consignacion: Object.assign({}, actual, { estado: nuevo }) });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/consignaciones/devolver', limitar(60, 60000), async (req, res) => {
  try {
    const id = texto(req.body && req.body.id, 60);
    const todas = await ledger.listarConsignaciones({});
    const actual = todas.find((c) => String(c.id) === id);
    if (!actual) return res.status(404).json({ error: 'No se encontro esa consignacion.' });
    if (actual.estado === 'Devuelto') {
      return res.status(400).json({ error: 'Esa consignacion ya fue devuelta.' });
    }

    await inventory.escribir({
      tipoOperacion: 'CONSIGNACION',
      subTipo: 'DEVOLUCION',
      id: id,
      filaExcel: actual.filaExcel,
      fecha: actual.fecha,
      cliente: actual.cliente,
      modelo: actual.modelo,
      cantidad: actual.cantidad,
      sucursal: actual.sucursal,
      estado: 'Devuelto',
    });

    await ledger.actualizarConsignacion(id, { estado: 'Devuelto' });

    const lista = await inventory.listar({ forzar: true });
    const producto = inventory.buscarEn(lista, actual.modelo);

    res.json({
      consignacion: Object.assign({}, actual, { estado: 'Devuelto' }),
      stockRestante: producto ? producto.stock : null,
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/reportes', auth.exigirAuth, async (req, res) => {
  try {
    const desde = fecha(req.query.desde);
    const hasta = fecha(req.query.hasta);
    const vendedor = texto(req.query.vendedor, 80);
    const ventas = await ledger.listarVentas({ desde: desde, hasta: hasta, vendedor: vendedor });
    res.json({
      modo: ledger.modo(),
      efimero: ledger.esEfimero(),
      filtros: { desde: desde, hasta: hasta, vendedor: vendedor || null },
      resumen: ledger.calcularResumen(ventas),
      ventas: ventas.slice().reverse(),
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/ficha-tecnica', limitar(30, 60000), async (req, res) => {
  try {
    const modelo = texto(req.query.modelo, 120);
    if (!modelo) return res.status(400).json({ error: 'Indica el modelo a consultar.' });
    const resultado = await ai.fichaTecnica(modelo, req.ip || 'desconocido');
    res.json({ modelo: modelo, cache: resultado.cache, ficha: resultado.datos });
  } catch (e) {
    responderError(res, e);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((req, res) => {
  if (req.path.indexOf('/api/') === 0) {
    return res.status(404).json({ error: 'Ruta no encontrada.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalido en la peticion.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Peticion demasiado grande.' });
  }
  responderError(res, err);
});

app.listen(PUERTO, '0.0.0.0', () => {
  console.log('MooN ERP escuchando en el puerto ' + PUERTO);
  console.log('Sheets URL: ' + inventory.estaConfigurado());
  console.log('Sheets clave: ' + inventory.tieneClave());
  console.log('Reportes: ' + ledger.modo() + (ledger.esEfimero() ? ' (efimero)' : ''));
  console.log('IA habilitada: ' + ai.habilitado());
  if (!process.env.SESSION_SECRET) {
    console.error('AVISO: SESSION_SECRET no esta definido. Las sesiones no funcionaran.');
  }
});