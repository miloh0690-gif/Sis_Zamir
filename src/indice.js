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

/**
 * Clave de busqueda de la tabla. El "+" SE CONSERVA, a proposito.
 *
 * "SAMSUNG S26 256/12" y "SAMSUNG S26+ 256/12" dan la misma clave si el "+"
 * se convierte en espacio. Con dos SKUs en la misma clave, el primero se
 * queda con la ficha del segundo y el vendedor del Galaxy S26+ leeria las
 * especificaciones del S26. Son telefonos distintos.
 */
function clave(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Si dos SKUs distintos caen en la misma clave solo entra el primero. Se
// avisa al arrancar en vez de devolver la ficha del otro en silencio.
const POR_CLAVE = {};
const YA_INDEXADO = {};
const COLISIONES = {};
for (const nombre of Object.keys(TABLAS)) {
  const k = clave(nombre);
  if (!k) continue;
  if (POR_CLAVE[k]) {
    // COLISIONES guarda el SKU que se lleva la ficha, no la ruta: al
    // reportar hay que poder leer los dos nombres, no dos rutas.
    COLISIONES[nombre] = YA_INDEXADO[k] || '';
    continue;
  }
  POR_CLAVE[k] = TABLAS[nombre];
  YA_INDEXADO[k] = nombre;
}

for (const nombre of Object.keys(COLISIONES)) {
  console.error(
    '[indice] "' + nombre + '" y "' + COLISIONES[nombre] +
      '" dan la misma clave. Solo se indexa el primero.'
  );
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
  const k = clave(modelo);
  if (!k) return null;

  const guardado = cache.get(k);
  if (guardado) return { ficha: guardado, cache: true };

  const ruta = POR_CLAVE[k];
  if (!ruta) return null;

  const json = await fetchJson(RAW_BASE + '/' + ruta);
  const ficha = sinMarcaDuplicada(dataset.mapear(json));
  if (!ficha) return null;

  cache.set(k, ficha);
  return { ficha: ficha, cache: false };
}

/**
 * El dataset trae brand ("xiaomi") y name ("Xiaomi Redmi A7 4G"), y
 * dataset.mapear los concatena: "Xiaomi Xiaomi Redmi A7 4G". Se repite
 * cuando el name ya empieza con la marca, que es lo habitual.
 */
function sinMarcaDuplicada(ficha) {
  if (!ficha || !ficha.nombre || !ficha.marca) return ficha;
  const partes = String(ficha.nombre).trim().split(/\s+/);
  while (partes.length > 1 && partes[0].toLowerCase() === String(ficha.marca).toLowerCase()) {
    partes.shift();
  }
  const limpio = partes.join(' ');
  if (limpio === ficha.nombre) return ficha;
  const copia = Object.assign({}, ficha);
  copia.nombre = limpio;
  return copia;
}

function tiene(modelo) {
  return Boolean(POR_CLAVE[clave(modelo)]);
}

function cuantos() {
  return Object.keys(POR_CLAVE).length;
}

module.exports = {
  buscar: buscar,
  tiene: tiene,
  cuantos: cuantos,
  colisiones: COLISIONES,
  clave: clave,
};