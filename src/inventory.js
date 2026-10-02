'use strict';

const URL_BASE = (process.env.SHEETS_WEBAPP_URL || '').trim();
const API_KEY = (process.env.SHEETS_API_KEY || '').trim();
const TTL_MS = Math.max(5, Number(process.env.STOCK_CACHE_SEG) || 60) * 1000;
const TIMEOUT_MS = 20000;

let cache = { datos: null, expira: 0 };
let enCurso = null;

function normalizar(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function aNumero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function mapearFila(fila) {
  const f = fila || {};
  const modelo = String(
    f.modelo !== undefined ? f.modelo : f.Modelo || ''
  ).trim();
  return {
    modelo: modelo,
    clave: normalizar(modelo),
    costoUsd: aNumero(
      f.costoUsd !== undefined
        ? f.costoUsd
        : f.CostoUsd !== undefined
          ? f.CostoUsd
          : f.costo
    ),
    stock: Math.floor(
      aNumero(f.stock !== undefined ? f.stock : f.Stock)
    ),
    sucursal: String(
      f.sucursal !== undefined ? f.sucursal : f.Sucursal || ''
    ).trim(),
    filaExcel:
      f.filaExcel !== undefined ? f.filaExcel : f.FilaExcel !== undefined ? f.FilaExcel : null,
  };
}

function estaConfigurado() {
  return Boolean(URL_BASE) && URL_BASE.indexOf('AQUI_PEGA') === -1;
}

function tieneClave() {
  return Boolean(API_KEY);
}

function completo() {
  return estaConfigurado() && tieneClave();
}

/**
 * Apps Script NO expone los encabezados HTTP de la peticion dentro de
 * doGet, asi que la clave compartida tiene que ir en la query string.
 */
function construirUrl() {
  if (!API_KEY) return URL_BASE;
  return URL_BASE + (URL_BASE.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(API_KEY);
}

function errorDeAuth() {
  const e = new Error(
    'El Apps Script rechazo la peticion. Revisa tres cosas: (1) que hayas pegado ' +
      'apps-script/Code.gs y lo hayas desplegado con Implementar > Nueva implementacion; ' +
      '(2) que la propiedad SHEETS_API_KEY este guardada en el script; ' +
      '(3) que ese mismo valor este en la variable SHEETS_API_KEY de Render.'
  );
  e.codigo = 502;
  return e;
}

function pareceFalloDeAuth(datos, estadoHttp) {
  if (estadoHttp === 401 || estadoHttp === 403) return true;
  if (!datos || typeof datos !== 'object') return false;
  const bruto = datos.error !== undefined ? datos.error : datos.message;
  if (bruto === undefined || bruto === null) return false;
  const texto = String(bruto).toUpperCase();
  return (
    texto.indexOf('NO_AUTORIZADO') >= 0 ||
    texto.indexOf('NO AUTORIZADO') >= 0 ||
    texto.indexOf('TOKEN') >= 0 ||
    texto.indexOf('API KEY') >= 0 ||
    texto.indexOf('APIKEY') >= 0
  );
}

async function pedirRemoto(payload) {
  if (!estaConfigurado()) {
    const e = new Error('SHEETS_WEBAPP_URL no esta configurado en el servidor.');
    e.codigo = 503;
    throw e;
  }

  const cabeceras = {};
  let url = URL_BASE;
  let cuerpo;

  if (payload === null) {
    url = construirUrl();
  } else {
    // En POST la clave viaja en el cuerpo, no en la query.
    cuerpo = JSON.stringify(Object.assign({ apiKey: API_KEY }, payload));
    cabeceras['Content-Type'] = 'application/json';
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  let estadoHttp = 0;
  let texto = '';
  try {
    const respuesta = await fetch(url, {
      method: payload === null ? 'GET' : 'POST',
      headers: cabeceras,
      body: cuerpo,
      redirect: 'follow',
      signal: controlador.signal,
    });
    estadoHttp = respuesta.status;
    texto = await respuesta.text();
  } catch (e) {
    const fallo = new Error(
      e.name === 'AbortError'
        ? 'Google Sheets tardo demasiado en responder.'
        : 'No se pudo contactar al servidor de Google Sheets.'
    );
    fallo.codigo = e.name === 'AbortError' ? 504 : 502;
    throw fallo;
  } finally {
    clearTimeout(temporizador);
  }

  let datos = null;
  if (texto.trim()) {
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      datos = null;
    }
  }

  if (estadoHttp === 401 || estadoHttp === 403) throw errorDeAuth();
  if (pareceFalloDeAuth(datos, estadoHttp)) throw errorDeAuth();
  if (estadoHttp >= 400) {
    const e = new Error('Apps Script respondio HTTP ' + estadoHttp + '.');
    e.codigo = 502;
    throw e;
  }

  return datos;
}

/**
 * Escribe una operacion y verifica que Apps Script la haya aceptado.
 *
 * Apps Script responde HTTP 200 incluso cuando rechaza la operacion,
 * devolviendo {status:'ERROR', message:'...'}. Si no se chequea eso, el
 * usuario ve "venta registrada" aunque la hoja nunca se haya tocado.
 */
async function escribir(payload) {
  const respuesta = await pedirRemoto(payload);

  if (respuesta && typeof respuesta === 'object' && respuesta.status === 'ERROR') {
    const e = new Error(String(respuesta.message || 'Google Sheets rechazo la operacion.'));
    e.codigo = 409;
    throw e;
  }

  limpiarCache();
  return respuesta;
}

async function leerRemoto() {
  const datos = await pedirRemoto(null);
  if (!Array.isArray(datos)) {
    const e = new Error('La respuesta de Google Sheets no es una lista de productos.');
    e.codigo = 502;
    throw e;
  }
  return datos.map(mapearFila).filter((p) => p.modelo);
}

async function listar(opciones) {
  if (!opciones || !opciones.forzar) {
    if (cache.datos && Date.now() < cache.expira) return cache.datos;
  }
  if (enCurso) return enCurso;

  enCurso = leerRemoto()
    .then((datos) => {
      cache = { datos: datos, expira: Date.now() + TTL_MS };
      return datos;
    })
    .finally(() => {
      enCurso = null;
    });

  return enCurso;
}

function buscarEn(lista, texto) {
  const clave = normalizar(texto);
  if (!clave) return null;
  const exacto = lista.find((p) => p.clave === clave);
  if (exacto) return exacto;
  const parcial = lista.find((p) => p.clave.indexOf(clave) >= 0 || clave.indexOf(p.clave) >= 0);
  return parcial || null;
}

async function buscar(texto) {
  const lista = await listar();
  return buscarEn(lista, texto);
}

function limpiarCache() {
  cache = { datos: null, expira: 0 };
}

module.exports = {
  estaConfigurado: estaConfigurado,
  tieneClave: tieneClave,
  completo: completo,
  listar: listar,
  buscar: buscar,
  buscarEn: buscarEn,
  mapearFila: mapearFila,
  normalizar: normalizar,
  escribir: escribir,
  limpiarCache: limpiarCache,
  urlWebapp: URL_BASE,
};