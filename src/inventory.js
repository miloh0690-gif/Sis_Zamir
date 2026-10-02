'use strict';

const URL_WEBAPP = (process.env.SHEETS_WEBAPP_URL || '').trim();
const TTL_MS = Math.max(5, Number(process.env.STOCK_CACHE_SEG) || 60) * 1000;
const TIMEOUT_MS = 20000;

let cache = { datos: null, expira: 0 };
let enCurso = null;

function normalizar(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
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
  const modelo = String(f.modelo !== undefined ? f.modelo : f.Modelo || '').trim();
  return {
    modelo,
    clave: normalizar(modelo),
    costoUsd: aNumero(f.costoUsd !== undefined ? f.costoUsd : f.CostoUsd !== undefined ? f.CostoUsd : f.costo),
    stock: Math.floor(aNumero(f.stock !== undefined ? f.stock : f.Stock)),
    sucursal: String(f.sucursal !== undefined ? f.sucursal : f.Sucursal || '').trim(),
    filaExcel: f.filaExcel !== undefined ? f.filaExcel : f.FilaExcel !== undefined ? f.FilaExcel : null,
  };
}

function estaConfigurado() {
  return Boolean(URL_WEBAPP) && !URL_WEBAPP.includes('AQUI_PEGA');
}

async function pedirRemoto(payload) {
  if (!estaConfigurado()) {
    const error = new Error('SHEETS_WEBAPP_URL no esta configurado en el servidor.');
    error.codigo = 503;
    throw error;
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(URL_WEBAPP, {
      method: payload === null ? 'GET' : 'POST',
      headers: payload === null ? undefined : { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload),
      redirect: 'follow',
      signal: controlador.signal,
    });

    const texto = await respuesta.text();
    if (!respuesta.ok) {
      const error = new Error('Apps Script respondio HTTP ' + respuesta.status);
      error.codigo = 502;
      error.detalle = texto.slice(0, 300);
      throw error;
    }
    if (!texto.trim()) return null;
    try {
      return JSON.parse(texto);
    } catch (e) {
      return texto;
    }
  } catch (e) {
    if (e.codigo) throw e;
    const error = new Error('No se pudo contactar al servidor de Google Sheets.');
    error.codigo = e.name === 'AbortError' ? 504 : 502;
    throw error;
  } finally {
    clearTimeout(temporizador);
  }
}

async function leerRemoto() {
  const datos = await pedirRemoto(null);
  if (!Array.isArray(datos)) {
    const error = new Error('La respuesta de Google Sheets no es una lista de productos.');
    error.codigo = 502;
    throw error;
  }
  return datos.map(mapearFila).filter((p) => p.modelo);
}

async function listar(opciones = {}) {
  if (!opciones.forzar && cache.datos && Date.now() < cache.expira) {
    return cache.datos;
  }
  if (enCurso) return enCurso;

  enCurso = leerRemoto()
    .then((datos) => {
      cache = { datos, expira: Date.now() + TTL_MS };
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
  const parcial = lista.find((p) => p.clave.includes(clave) || clave.includes(p.clave));
  return parcial || null;
}

async function buscar(texto) {
  const lista = await listar();
  return buscarEn(lista, texto);
}

function limpiarCache() {
  cache = { datos: null, expira: 0 };
}

async function escribir(payload) {
  const resultado = await pedirRemoto(payload);
  limpiarCache();
  return resultado;
}

module.exports = {
  estaConfigurado,
  listar,
  buscar,
  buscarEn,
  mapearFila,
  normalizar,
  escribir,
  limpiarCache,
  urlWebapp: URL_WEBAPP,
};