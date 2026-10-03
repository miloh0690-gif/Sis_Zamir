'use strict';

// Indice horneado de fichas: nombre de la tienda -> archivo del dataset.
//
// Por que una tabla y no buscar en vivo: los archivos del dataset se llaman
// "xiaomi-redmi-a7-4g-3gb-64gb-4g-lte", que no se pueden adivinar. La
// unica forma de resolverlos en vivo es leer el arbol del repo por la API
// de GitHub, que sin GITHUB_TOKEN se choca con el limite de 60 req/h de una
// IP compartida (Render comparte IP de salida con sus otros servicios).
//
// src/fichas.json mapea el nombre de la tienda a la ruta dentro de data/,
// como un solo string: "smartphone/honor/2025/honor-magic-8-pro.json". Se
// genera con `npm run indexar`, y cada entrada ya fue verificada contra el
// nombre real del JSON en ese momento. Servir la tabla NO exime de
// verificar: el gate de src/modelo.js sigue corriendo en cada consulta, asi
// que si el dataset se renombra el sistema se da cuenta.
//
// Los SKUs que no estan en la tabla NO son un error: se resuelven por
// src/dataset.js (que necesita GITHUB_TOKEN) o por src/specs.js.

const REPO = process.env.DATASET_REPO || 'GetTechAPI/TechAPI';
const REF = process.env.DATASET_REF || 'develop';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/data';

const TIMEOUT_MS = 25000;

const dataset = require('./dataset');
const TABLAS = require('./fichas.json');

function normalizar(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// La tabla se indexa por clave normalizada ("black shark 128 6", minusculas
// y sin acentos) porque las claves del archivo son las crudas del Excel
// ("BLACK SHARK 128/6"). Sin esto la tabla nunca pegaria.
const POR_CLAVE = {};
for (const nombre of Object.keys(TABLAS)) {
  const k = normalizar(nombre);
  if (k && !POR_CLAVE[k]) POR_CLAVE[k] = TABLAS[nombre];
}

const cache = new Map();

async function fetchJson(url) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: controlador.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Devuelve {ficha, cache} o null si este modelo no esta en la tabla.
 * La fichaTodavia NO esta verificada: eso lo hace quien la pide.
 */
async function buscar(modelo) {
  const k = normalizar(modelo);
  if (!k) return null;

  const guardado = cache.get(k);
  if (guardado) return { ficha: guardado, cache: true };

  const ruta = POR_CLAVE[k];
  if (!ruta) return null;

  const json = await fetchJson(RAW_BASE + '/' + ruta);
  const ficha = dataset.mapear(json);
  if (!ficha) return null;

  cache.set(k, ficha);
  return { ficha: ficha, cache: false };
}

function tiene(modelo) {
  return Boolean(POR_CLAVE[normalizar(modelo)]);
}

function cuantos() {
  return Object.keys(POR_CLAVE).length;
}

module.exports = {
  buscar: buscar,
  tiene: tiene,
  cuantos: cuantos,
  normalizar: normalizar,
};