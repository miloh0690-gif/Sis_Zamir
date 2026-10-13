'use strict';

require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const inventory = require('./src/inventory');
const ledger = require('./src/ledger');
const money = require('./src/money');
const ficha = require('./src/ficha');
const auth = require('./src/auth');

const app = express();
const PUERTO = Number(process.env.PORT) || 10000;

const TASA_COMISION = Number(process.env.TASA_COMISION) || 0.3;
const DESCUENTO_MAYOR_PCT = Number(process.env.DESCUENTO_MAYOR_PCT) || 0;
const TRAMOS_MAYOR = money.parseTramos(process.env.MAYOR_TIERS);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Vercel proxea /api hacia este servidor y respeta el Cache-Control del
  // origen. Sin esto serviria respuestas viejas: stock, precios y sesiones.
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const golpes = new Map();

// ---------------------------------------------------------------------------
// Código de tienda.
//
// Por diseño el POS es abierto: el vendedor teclea su nombre y cobra. Eso
// está bien dentro del local, pero la app vive en una URL pública y cualquiera
// puede POSTear /api/ventas o /api/consignaciones y descontar stock de verdad.
// El rate limit (60/min) limita el volumen, no el acceso.
//
// La corrección es un código compartido de la tienda, que el vendedor escribe
// una vez por turno. Se activa poniendo STORE_KEY en el entorno: si no está
// definida, TODO sigue como antes. Un solo número en el dashboard de Render
// decide si el POS es público o no.
//
// No es fail-closed: si STORE_KEY no está definida el sistema queda abierto, y eso
// es una decisión consciente — defaults que rompen el POS en el deploy son
// peores que un riesgo conocido y documentado.
// ---------------------------------------------------------------------------
const STORE_KEY = String(process.env.STORE_KEY || '').trim();

function exigirLlaveTienda(req, res, siguiente) {
  if (!STORE_KEY) return siguiente();
  const enviada = String(req.get('X-Tienda') || '');
  const a = crypto.createHash('sha256').update(enviada).digest();
  const b = crypto.createHash('sha256').update(STORE_KEY).digest();
  // Comparación de tiempo constante: con === la comparación se corta en el primer
  // caracter distinto y el tiempo de respuesta filtra la llave.
  if (enviada.length === 0 || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Código de tienda incorrecto. Recargá la página e ingresalo de nuevo.' });
  }
  siguiente();
}

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

// -----------------------------------------------------------------
// IDEMPOTENCIA
// -----------------------------------------------------------------
// El navegador manda una clave distinta por cada intento de cobro, y la
// REUTILIZA si reintenta. Si la misma clave vuelve a llegar, se devuelve
// la respuesta que ya se dio, sin volver a escribir en la hoja.
//
// Por que hace falta: el boton se deshabilita en el navegador, pero eso
// no protege el dinero. Render free se duerme tras inactividad (la
// primera peticion del dia tarda ~20 s), asi que un timeout del vendedor
// tocando "cobrar" otra vez registraba DOS ventas y descontaba el stock
// DOS veces. El disable del boton evita el doble toque; esto evita el
// resto.
//
// Esta es la capa rapida, en memoria. La capa lenta es la columna
// ClaveIdempotencia de la hoja, que cubre el caso en que el servidor de
// Render reinicia entre el intento y el reintento: la clave quedo escrita
// en la hoja y ahi se la busca.

const CLAVE_VIGENCIA_MS = 30 * 60 * 1000;
const CLAVE_MAXIMO = 500;

// Prefijo por tipo de operacion: una consignacion y una venta no pueden
// compartir clave, asi que viven en mapas separados.
const CLAVE_VENTA = 'venta:';
const CLAVE_CONSIGNACION = 'consignacion:';

const ventasPorClave = new Map();

function claveValida(valor) {
  const s = String(valor === undefined || valor === null ? '' : valor).trim();
  // Solo caracteres seguros: la clave se escribe en una hoja y se
  // compara al releerla, no tiene por que admitir nada raro.
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : '';
}

function operacionRecordada(clave) {
  if (!clave) return null;
  const guardado = ventasPorClave.get(clave);
  if (!guardado) return null;
  if (guardado.expira < Date.now()) {
    ventasPorClave.delete(clave);
    return null;
  }
  return guardado.respuesta;
}

function recordarOperacion(clave, respuesta) {
  if (!clave) return;
  if (ventasPorClave.size >= CLAVE_MAXIMO) {
    // El mapa es chico y las claves duran 30 minutos. Si se llena (no
    // deberia: serian 500 operaciones en media hora) se pisa la mas vieja.
    const masVieja = ventasPorClave.keys().next();
    if (!masVieja.done) ventasPorClave.delete(masVieja.value);
  }
  ventasPorClave.set(clave, { expira: Date.now() + CLAVE_VIGENCIA_MS, respuesta: respuesta });
}

setInterval(() => {
  const ahora = Date.now();
  for (const [clave, guardado] of ventasPorClave) {
    if (guardado.expira < ahora) ventasPorClave.delete(clave);
  }
}, 5 * 60 * 1000).unref();

// La foto llega del navegador como data URL. Solo se acepta una imagen real
// (jpeg o png) y de tamaño acotado; cualquier otra cosa se descarta y la
// venta se guarda igual. La foto es evidencia: nunca puede tumbar la venta.
const FOTO_BASE64_MAXIMO = 1.5 * 1024 * 1024;
function fotoBase64De(valor) {
  if (typeof valor !== 'string') return '';
  const datos = valor.trim();
  if (!/^data:image\/(?:jpeg|png);base64,/i.test(datos)) return '';
  return datos.length <= FOTO_BASE64_MAXIMO ? datos : '';
}

function construirCalculo(producto, cuerpo) {
  const c = cuerpo || {};
  // El costo lo escribe el vendedor y es 100% editable: el inventario solo
  // aporta el costo cuando el vendedor no escribio ninguno, y el resultado
  // automatico queda como sugerencia al lado, nunca pisando lo escrito.
  const costoEscrito = c.costoUsd === undefined || c.costoUsd === null || c.costoUsd === ''
    ? NaN
    : Number(c.costoUsd);
  const costoDelInventario = producto && Number.isFinite(Number(producto.costoUsd))
    ? Number(producto.costoUsd)
    : NaN;
  return money.calcularVenta({
    costoUsd: Number.isFinite(costoEscrito) && costoEscrito >= 0 ? costoEscrito : costoDelInventario,
    tipo: c.tipo,
    cantidad: entero(c.cantidad),
    tipoCambio: decimal(c.tipoCambio),
    precioManualBs: c.precioManualBs,
    tasaComision: TASA_COMISION,
    descuentoMayorPct: DESCUENTO_MAYOR_PCT,
    tramosMayor: TRAMOS_MAYOR,
    accesorios: Array.isArray(c.accesorios)
      ? c.accesorios
        .filter((a) => a && String(a.nombre || '').trim())
        .map((a) => ({
          nombre: String(a.nombre).slice(0, 300),
          precioBs: Number(a.precioBs) || 0,
          costoBs: Number(a.costoBs) || 0,
        }))
      : [],
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
    fichaTecnica: ficha.habilitado(),
    argumentosVenta: ficha.hayArgumentos(),
  });
});

app.get('/api/diagnostico', async (req, res) => {
  try {
    res.json(await inventory.diagnostico());
  } catch (e) {
    responderError(res, e);
  }
});

// Presencia de cada variable sensible, NUNCA su valor. Solo booleano y
// longitud: alcanza para distinguir "no esta", "esta vacia" y "esta
// truncada", y no sirve para reconstruir la llave.
//
// Existe porque el nombre importa y no se puede ver desde afuera: si la
// llave de Groq se guarda en Render como GROQ_KEY en vez de GROQ_API_KEY,
// el servidor la ignora en silencio y la IA queda dead sin avisar.
const SENSIBLES = [
  'GROQ_API_KEY',
  'GROQ_KEY',
  'GROQ_API',
  'GROQ_TOKEN',
  'GROQ',
  'GROQ_MODEL',
  'GITHUB_TOKEN',
  'SESSION_SECRET',
  'ADMIN_PIN_HASH',
  'SHEETS_WEBAPP_URL',
  'SHEETS_API_KEY',
];

// Diagnóstico de variables. Antes era público: cualquiera que abriera la URL
// recibía el mapa de qué variables tiene el servidor y de qué largo. No filtra
// valores, pero es reconocimiento gratis y no lo necesita nadie más que el
// dueño. Se puso abierto para diagnosticar la llave de Groq el 2026-10-03 y
// nunca se cerró.
app.get('/api/claves', auth.exigirAuth, (req, res) => {
  const variables = {};
  for (const nombre of SENSIBLES) {
    const valor = String(process.env[nombre] || '').trim();
    variables[nombre] = { presente: Boolean(valor), longitud: valor.length };
  }
  const groq = Object.keys(variables).filter(
    (n) => n.indexOf('GROQ') === 0 && n !== 'GROQ_MODEL' && variables[n].presente
  );
  res.json({
    ok: true,
    variables: variables,
    groqEncontradaEn: groq,
    laIaLee: 'GROQ_API_KEY',
    coincide: groq.indexOf('GROQ_API_KEY') !== -1,
    accion: groq.indexOf('GROQ_API_KEY') !== -1
      ? null
      : groq.length
        ? 'La llave esta en Render como "' + groq[0] + '" pero src/ia.js solo lee GROQ_API_KEY. Renombrala en Render > Environment.'
        : 'No hay ninguna variable de Groq definida en Render. Agrega GROQ_API_KEY en Render > Environment.',
  });
});

// El panel necesita solo los booleanos (`sheets`, `ia`) para decidir si avisa.
// Los numeros comerciales —tasa de comision, descuento mayor, tramos y el
// modelo de IA— son estructura de negocio: antes de esto eran publicos y
// cualquiera los leia. Se devuelven solo con sesion del dueño.
app.get('/api/config', (req, res) => {
  const publico = {
    sheets: inventory.completo(),
    sheetsUrl: inventory.estaConfigurado(),
    sheetsClave: inventory.tieneClave(),
    ia: ficha.habilitado(),
    argumentosVenta: ficha.hayArgumentos(),
    reportes: ledger.modo(),
    reportesEfimeros: ledger.esEfimero(),
  };
  if (!auth.estaAutenticado(req)) return res.json(publico);
  res.json(Object.assign(publico, {
    modeloArgs: ficha.hayArgumentos() ? ficha.modeloArgs : null,
    tasaComision: TASA_COMISION,
    descuentoMayorPct: DESCUENTO_MAYOR_PCT,
    tramosMayor: TRAMOS_MAYOR,
  }));
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
    // Si el modelo no esta en el inventario igual se puede calcular: el
    // vendedor escribe el costo y el precio a mano. No se descuenta stock.
    const enInventario = !!producto;
    res.json({
      encontrado: true,
      enInventario: enInventario,
      modelo: enInventario ? producto.modelo : modelo,
      stock: enInventario ? producto.stock : 0,
      sucursal: enInventario ? producto.sucursal : '',
      calculo: construirCalculo(enInventario ? producto : null, req.body),
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas', limitar(60, 60000), exigirLlaveTienda, async (req, res) => {
  try {
    if (!exigirSheets(res)) return;
    const cuerpo = req.body || {};
    const vendedor = texto(cuerpo.vendedor, 80);
    const modeloTexto = texto(cuerpo.modelo, 120);
    const cantidad = entero(cuerpo.cantidad);
    const tipoCambio = decimal(cuerpo.tipoCambio);
    const clave = claveValida(cuerpo.claveIdempotencia);

    // Reintento del mismo cobro: se devuelve lo que ya se respondio y no
    // se toca la hoja. Va antes de validar, para que un reintento no
    // falle por "stock insuficiente" cuando lo que bajo de stock fue
    // esta misma venta.
    if (clave) {
      const previa = operacionRecordada(CLAVE_VENTA + clave);
      if (previa) {
        return res.status(200).json(Object.assign({}, previa, { repetida: true }));
      }
    }

    if (!vendedor) return res.status(400).json({ error: 'Ingresa el nombre del vendedor.' });
    if (!modeloTexto) return res.status(400).json({ error: 'Ingresa o selecciona un modelo.' });
    if (cantidad <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
    if (!(tipoCambio > 0)) return res.status(400).json({ error: 'El tipo de cambio debe ser mayor a 0.' });

    const producto = await inventory.buscar(modeloTexto);
    // Vender un equipo que no esta cargado en el inventario es valido: el
    // vendedor escribe costo y precio a mano. Solo no se descuenta stock.
    if (producto && producto.stock < cantidad) {
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
      modelo: producto ? producto.modelo : modeloTexto,
      sucursal: producto ? producto.sucursal : '',
      tipo: calculo.tipo,
      cantidad: cantidad,
      tipoCambio: calculo.tipoCambio,
      costoUsd: calculo.costoUsd,
      precioUnitarioBs: calculo.precioUnitarioBs,
      costoUnitarioBs: calculo.costoUnitarioBs,
      costoTotalBs: calculo.costoTotalBs,
      totalCobradoBs: calculo.totalCobradoBs,
      gananciaBs: calculo.gananciaBs,
      comisionBs: calculo.comisionBs,
      descuentoAplicadoPct: calculo.descuentoAplicadoPct,
      // Los campos nuevos van con el MISMO nombre que los lee
      // ledger.normalizarVenta. Sin `accesorios` y `foto` aqui, el reporte
      // del modo archivo perdia los accesorios y nunca tendria foto.
      cliente: String(cuerpo.cliente || '').slice(0, 500),
      nota: String(cuerpo.nota || '').slice(0, 500),
      accesorios: (Array.isArray(cuerpo.accesorios) ? cuerpo.accesorios : [])
        .map((a) => String((a && a.nombre) || '').trim().slice(0, 300))
        .filter(Boolean)
        .join(', '),
      accesoriosBs: calculo.precioAccesoriosBs,
      accesoriosCostoBs: calculo.costoAccesoriosBs,
      // La URL de la foto la resuelve el Apps Script guardando el archivo, asi
      // que todavia no existe: se completa despues de escribir.
      foto: '',
      filaExcel: producto ? producto.filaExcel : null,
    };

    // Si Apps Script rechaza (fila movida, stock racedado) esto lanza y
    // no se toca el historial, asi que no queda una venta fantasma.
    const escrito = await inventory.escribir({
      tipoOperacion: 'VENTA',
      // Sin inventario no hay fila para descontar stock. Apps Script valida
      // que la fila exista, asi que se marca explicitamente para que la omita.
      subTipo: producto ? undefined : 'SIN_INVENTARIO',
      filaExcel: producto ? producto.filaExcel : null,
      fecha: fechaIso,
      vendedor: vendedor,
      modelo: producto ? producto.modelo : modeloTexto,
      sucursal: producto ? producto.sucursal : '',
      tipo: calculo.tipo,
      cantidad: cantidad,
      tipoCambio: calculo.tipoCambio,
      costoUsd: calculo.costoUsd,
      precioUnitarioBs: calculo.precioUnitarioBs,
      costoUnitarioBs: calculo.costoUnitarioBs,
      costoTotalBs: calculo.costoTotalBs,
      totalCobrado: calculo.totalCobradoBs,
      gananciaRegistrada: calculo.gananciaBs,
      cliente: String(cuerpo.cliente || '').slice(0, 500),
      nota: String(cuerpo.nota || '').slice(0, 500),
      accesoriosTexto: (Array.isArray(cuerpo.accesorios) ? cuerpo.accesorios : [])
        .map((a) => String((a && a.nombre) || '').trim().slice(0, 300))
        .filter(Boolean)
        .join(', '),
      precioAccesoriosBs: calculo.precioAccesoriosBs,
      costoAccesoriosBs: calculo.costoAccesoriosBs,
      // La foto viaja en base64 y la guarda el Apps Script en Drive: el
      // servidor no tiene credenciales de Google, solo la URL del web app.
      // Si se pierde aqui, la columna Foto queda vacia para siempre.
      fotoBase64: fotoBase64De(cuerpo.fotoBase64),
      comision: calculo.comisionBs,
      claveIdempotencia: clave,
    });

    // El Apps Script guarda la foto en Drive y devuelve el link que si pudo
    // guardar. Si no lo pudo (sin scope de Drive, foto rechazada), vuelve
    // vacio: la venta esta escrita igual y no se pierde nada.
    registro.foto = (escrito && typeof escrito.fotoUrl === 'string') ? escrito.fotoUrl : '';

    // El script encontro la clave en la hoja: la venta ya estaba
    // registrada (el servidor de Render reinicio entre el intento y el
    // reintento, y se perdio la cache en memoria). No se vuelve a
    // guardar en el historial ni a descontar stock.
    if (escrito && escrito.duplicada) {
      const listaDup = await inventory.listar({ forzar: true });
      const productoDup = producto ? inventory.buscarEn(listaDup, producto.modelo) : null;
      return res.status(200).json({
        venta: ledger.normalizarVenta(registro),
        calculo: calculo,
        stockRestante: productoDup ? productoDup.stock : (producto ? producto.stock : 0),
        advertencia:
          'Esta venta ya estaba registrada. No se cobro ni se desconto stock dos veces.',
        repetida: true,
      });
    }

    let advertencia = null;
    try {
      await ledger.registrarVenta(registro);
    } catch (e) {
      advertencia = 'La venta se guardo en Sheets pero no en el historial de reportes.';
      console.error('[ledger]', e.message);
    }

    const lista = await inventory.listar({ forzar: true });
    const actualizado = producto ? inventory.buscarEn(lista, producto.modelo) : null;

    const respuesta = {
      venta: ledger.normalizarVenta(registro),
      calculo: calculo,
      stockRestante: actualizado
        ? actualizado.stock
        : (producto ? Math.max(0, producto.stock - cantidad) : 0),
      advertencia: advertencia,
    };

    // Se recuerda la respuesta para que un reintento con la misma clave no
    // vuelva a cobrar. Es lo que hace segura la segunda capa (la hoja).
    recordarOperacion(CLAVE_VENTA + clave, respuesta);

    res.status(201).json(respuesta);
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/consignaciones', limitar(60, 60000), exigirLlaveTienda, async (req, res) => {
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

app.post('/api/consignaciones', limitar(60, 60000), exigirLlaveTienda, async (req, res) => {
  try {
    if (!exigirSheets(res)) return;
    const cuerpo = req.body || {};
    const cliente = texto(cuerpo.cliente, 80);
    const modeloTexto = texto(cuerpo.modelo, 120);
    const cantidad = entero(cuerpo.cantidad);
    const clave = claveValida(cuerpo.claveIdempotencia);

    // Misma proteccion que en ventas: un doble toque no descuenta stock
    // dos veces. Va antes de validar porque el reintento llegaria con el
    // stock ya bajado por esta misma consignacion.
    if (clave) {
      const previa = operacionRecordada(CLAVE_CONSIGNACION + clave);
      if (previa) return res.status(200).json(Object.assign({}, previa, { repetida: true }));
    }

    if (!cliente) return res.status(400).json({ error: 'Ingresa el responsable.' });
    if (!modeloTexto) return res.status(400).json({ error: 'Ingresa o selecciona un modelo.' });
    if (cantidad <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });

    const producto = await inventory.buscar(modeloTexto);
    if (!producto) return res.status(400).json({ error: 'Ese modelo no existe en el inventario.' });
    if (producto.stock < cantidad) {
      return res.status(409).json({ error: 'Stock insuficiente. Solo quedan ' + producto.stock + ' unidades.' });
    }

    // El Id de la consignacion es la clave que manda el navegador, para
    // que un reintento conserve el mismo Id y la hoja lo reconozca como
    // la misma operacion. Sin clave (llamadas viejas) se genera una.
    const id = clave || ledger.nuevoId('C');
    const fechaIso = new Date().toISOString();

    const escrito = await inventory.escribir({
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

    // El script ya tenia este Id: no se desconto stock de nuevo.
    if (escrito && escrito.duplicada) {
      const listaDup = await inventory.listar({ forzar: true });
      const productoDup = inventory.buscarEn(listaDup, producto.modelo);
      return res.status(200).json({
        consignacion: { id: id, fecha: fechaIso, cliente: cliente, modelo: producto.modelo, sucursal: producto.sucursal, cantidad: cantidad, estado: 'Pendiente', filaExcel: producto.filaExcel },
        stockRestante: productoDup ? productoDup.stock : producto.stock,
        advertencia: 'Esta consignacion ya estaba registrada. No se desconto stock dos veces.',
        repetida: true,
      });
    }

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

    const respuesta = {
      consignacion: consignacion,
      stockRestante: actualizado ? actualizado.stock : Math.max(0, producto.stock - cantidad),
      advertencia: advertencia,
    };

    recordarOperacion(CLAVE_CONSIGNACION + clave, respuesta);

    res.status(201).json(respuesta);
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/consignaciones/estado', limitar(60, 60000), exigirLlaveTienda, async (req, res) => {
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

app.post('/api/consignaciones/devolver', limitar(60, 60000), exigirLlaveTienda, async (req, res) => {
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
    const resultado = await ficha.fichaTecnica(modelo, req.ip || 'desconocido');
    res.json({ modelo: modelo, cache: resultado.cache, ficha: resultado.ficha });
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
  console.log('Jhsel Tech Mobiles escuchando en el puerto ' + PUERTO);
  console.log('Sheets URL: ' + inventory.estaConfigurado());
  console.log('Sheets clave: ' + inventory.tieneClave());
  console.log('Reportes: ' + ledger.modo() + (ledger.esEfimero() ? ' (efimero)' : ''));
  console.log('Ficha tecnica: ' + ficha.habilitado());
  console.log('Argumentos de venta (Groq): ' + ficha.hayArgumentos());
  console.log('Diagnostico de Sheets: /api/diagnostico');
  if (!process.env.SESSION_SECRET) {
    console.error('AVISO: SESSION_SECRET no esta definido. Las sesiones no funcionaran.');
  }
});
