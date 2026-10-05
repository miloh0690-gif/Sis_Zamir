'use strict';

// =================================================================
// Regenera src/fichas.json: nombre de la tienda -> ruta del archivo
// dentro de data/ del dataset.
//
//   npm run indexar
//
// Que hace y por que existe: los archivos del dataset se llaman
// "xiaomi-redmi-a7-4g-3gb-64gb-4g-lte", imposibles de adivinar. Resolver
// 225 SKUs en vivo contra la API de GitHub es lentisimo y sin
// GITHUB_TOKEN choca con el limite de 60 req/h. Asi que se resuelve una
// sola vez, aqui, y el resultado queda horneado en src/fichas.json para
// que el servidor lo lea sin pedirle nada a nadie.
//
// Lo importante: NADA entra sin verificarse. Cada candidato se descarga
// y se contrasta con src/modelo.js contra el nombre real del JSON. Si el
// gate no pasa, el SKU no se indexa. Es preferible un hueco en el indice
// que una ficha del telefono equivocado.
//
// Uso:
//   npm run indexar                      respeta lo que ya hay y agrega
//   npm run indexar -- --limpiar        rehace desde cero (borra lo viejo)
//   npm run indexar -- --verificar      no agrega nada, solo revisa que
//                                        las rutas actuales sigan existiendo
//   npm run indexar -- --muestra N      muestra los N SKU sin resultado
//
// Variables:
//   GITHUB_TOKEN   recomendado. Sin el, la API de GitHub limita a 60
//                  req/h por IP y el recorrido se corta.
//   INVENTARIO_URL de donde sale la lista de SKU. Si no esta, se usan las
//                  claves que ya hay en src/fichas.json (asi se pueden
//                  agregar SKU a mano al archivo y expandirlos).
// =================================================================

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

const dataset = require('../src/dataset');
const modelo = require('../src/modelo');

const RAIZ = path.join(__dirname, '..');
const RUTA_SALIDA = path.join(RAIZ, 'src', 'fichas.json');

const REPO = process.env.DATASET_REPO || 'GetTechAPI/TechAPI';
const REF = process.env.DATASET_REF || 'develop';
const API_GIT = 'https://api.github.com/repos/' + REPO + '/git/trees/';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/data';

const TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const INVENTARIO_URL = String(process.env.INVENTARIO_URL || '').trim();

const CATEGORIAS = ['smartphone', 'tablet', 'laptop'];
const TIMEOUT_MS = 25000;
const PAUSA_MS = Number(process.env.INDEXAR_PAUSA_MS) || 60;

const argumentos = new Set(
  process.argv.slice(2).map((a) => String(a).replace(/^--/, ''))
);
const LIMPIAR = argumentos.has('limpiar');
const VERIFICAR = argumentos.has('verificar');
const MOSTRAR = Number(
  (process.argv.find((a) => String(a).startsWith('--muestra=')) || '').split('=')[1] || 20
);

let apiUsadas = 0;
function gastarApi() {
  if (!TOKEN) {
    // Sin token la API limitando a 60 req/h. Un recorrido completo pide
    // pocas, pero hay que llevar la cuenta igual para no cortar el
    // script a mitad de camino sin avisar.
    apiUsadas++;
    if (apiUsadas > 55) {
      throw new Error(
        'Se agotaron las peticiones de la API de GitHub sin GITHUB_TOKEN. ' +
          'Define GITHUB_TOKEN y corre de nuevo.'
      );
    }
    return true;
  }
  apiUsadas++;
  return true;
}

function cabeceras() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'sis-zamir-indexar' };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}

async function pedirJson(url) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: url.indexOf(API_GIT) === 0 ? cabeceras() : {},
      redirect: 'follow',
      signal: controlador.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

function pausa(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Arbol COMPLETO de data/ en dos llamadas a la API, sin importar cuantas
 * marcas haya.
 *
 * A diferencia de dataset.indexarMarca, que reconstruye la URL como
 * data/<categoria>/<marca>/<anio>/<archivo>, aqui se guarda la ruta
 * tal cual viene del arbol. El dataset tiene carpetas anidadas: hay
 * archivos en data/smartphone/redmagic/2021/nubia-red-magic-6/<archivo>.json,
 * y si se asume que el anio es siempre la carpeta anterior al archivo,
 * el anio sale siendo "nubia-red-magic-6". Por eso el anio se busca como
 * el primer segmento que parezca un anio, y la URL se arma desde la ruta
 * real.
 */
async function indiceCompleto() {
  if (!gastarApi()) return [];
  const raiz = await pedirJson(API_GIT + REF);
  if (!raiz) {
    throw new Error('No se pudo leer el arbol del repo ' + REPO + ' en la ref ' + REF + '.');
  }
  const data = (raiz.tree || []).find((e) => e.path === 'data');
  if (!data) {
    throw new Error('El repo ' + REPO + ' no tiene carpeta "data". Revisa DATASET_REPO.');
  }

  if (!gastarApi()) return [];
  const sub = await pedirJson(API_GIT + data.sha + '?recursive=1');
  if (!sub) throw new Error('No se pudo leer el arbol de la carpeta data/.');

  if (sub.truncated) {
    console.warn(
      '[indexar] AVISO: GitHub devolvio el arbol truncado. Faltan ramas del ' +
        'dataset. Las fichas de esas ramas no van a entrar al indice.'
    );
  }

  const lista = [];
  for (const e of sub.tree || []) {
    if (!e.path || e.path.slice(-5) !== '.json') continue;
    const partes = e.path.split('/');
    // data/<categoria>/<marca>/[...anio]/<archivo>.json
    if (partes.length < 4) continue;
    if (CATEGORIAS.indexOf(partes[1]) < 0) continue;

    let anio = null;
    for (let i = partes.length - 2; i >= 2; i--) {
      if (/^20[0-2][0-9]$/.test(partes[i])) {
        anio = partes[i];
        break;
      }
    }

    lista.push({
      categoria: partes[1],
      marca: partes[2],
      anio: anio,
      archivo: partes[partes.length - 1],
      ruta: partes.slice(1).join('/'),
    });
  }
  return lista;
}

/** Solo las entradas de una marca, que es lo que necesita el match. */
function porMarca(indice) {
  const mapa = {};
  for (const item of indice) {
    const k = item.categoria + '/' + item.marca;
    if (!mapa[k]) mapa[k] = [];
    mapa[k].push(item);
  }
  return mapa;
}

async function skusDelInventario() {
  if (!INVENTARIO_URL) return null;

  const bruto = await pedirJson(INVENTARIO_URL);
  if (!bruto) {
    console.warn('[indexar] No se pudo leer INVENTARIO_URL. Se usan los SKUs del indice actual.');
    return null;
  }

  const lista = Array.isArray(bruto) ? bruto : Array.isArray(bruto.productos) ? bruto.productos : null;
  if (!lista) {
    console.warn('[indexar] INVENTARIO_URL no devolvio una lista de productos. Se usa el indice actual.');
    return null;
  }

  return lista
    .map((p) => String((p && (p.modelo || p.Modelo)) || '').trim())
    .filter(Boolean);
}

function indiceActual() {
  try {
    const crudo = fs.readFileSync(RUTA_SALIDA, 'utf8');
    const datos = JSON.parse(crudo);
    return datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {};
  } catch (e) {
    return {};
  }
}

function guardar(datos) {
  const claves = Object.keys(datos).sort();
  const bonito = {};
  for (const k of claves) bonito[k] = datos[k];
  fs.writeFileSync(RUTA_SALIDA, JSON.stringify(bonito, null, 2) + '\n', 'utf8');
  return claves.length;
}

async function main() {
  console.log('[indexar] dataset: ' + REPO + '@' + REF);
  console.log(
    '[indexar] GITHUB_TOKEN: ' + (TOKEN ? 'presente' : 'AUSENTE (saldra por el limite de 60 req/h)')
  );

  const actual = indiceActual();
  const delInventario = await skusDelInventario();

  const skus = Array.from(
    new Set(LIMPIAR && delInventario ? delInventario : (delInventario || []).concat(Object.keys(actual)))
  ).filter(Boolean);

  if (!skus.length) {
    console.error(
      '[indexar] No hay SKUs que indexar. Define INVENTARIO_URL o deja alguno en src/fichas.json.'
    );
    process.exit(1);
  }

  console.log('[indexar] SKUs a revisar: ' + skus.length);
  console.log('[indexar] leyendo el arbol de data/...');

  const indice = await indiceCompleto();
  const marcas = porMarca(indice);
  console.log(
    '[indexar] ' + indice.length + ' archivos en ' + Object.keys(marcas).length + ' carpetas de marca'
  );
  console.log('[indexar] peticiones a la API hasta ahora: ' + apiUsadas);

  const resultado = VERIFICAR ? Object.assign({}, actual) : LIMPIAR ? {} : Object.assign({}, actual);
  const agregados = [];
  const conservados = [];
  const rotos = [];
  const sinHoja = [];
  const nuevos = [];

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    const rutaPrevia = resultado[sku];

    if (VERIFICAR) {
      if (!rutaPrevia) continue;
      const existe = indice.some((item) => item.ruta === rutaPrevia);
      if (existe) {
        conservados.push(sku);
      } else {
        rotos.push(sku);
        delete resultado[sku];
      }
      continue;
    }

    if (rutaPrevia) {
      // Ya estaba. Se conserva sin volver a descargar: la ruta se verifico
      // cuando se genero, y el gate de src/modelo.js sigue corriendo en
      // cada consulta en vivo.
      conservados.push(sku);
      continue;
    }

    const marca = dataset.detectarMarca(sku);
    if (!marca) {
      sinHoja.push(sku + '  (no se reconoce la marca)');
      continue;
    }
    const categoria = dataset.detectarCategoria(sku);

    const claveMarca = categoria + '/' + marca;
    let candidatos = marcas[claveMarca];
    if (!candidatos || !candidatos.length) {
      // La categoria detectada no existe: se prueban las otras.
      for (const otra of CATEGORIAS) {
        candidatos = marcas[otra + '/' + marca];
        if (candidatos && candidatos.length) break;
      }
    }
    if (!candidatos || !candidatos.length) {
      sinHoja.push(sku + '  (el dataset no tiene ' + marca + ')');
      continue;
    }

    const juegos = dataset.juegosDeTokens(sku, marca);
    let encontrado = null;

    for (const buscados of juegos) {
      const hit = dataset.mejorArchivo(candidatos, buscados);
      if (!hit) continue;

      const json = await pedirJson(RAW_BASE + '/' + hit.ruta);
      if (!json) continue;

      const ficha = dataset.mapear(json);
      if (!ficha) continue;

      // EL GATE. Si el nombre real del JSON no es el telefono pedido, se
      // sigue probando con el siguiente juego de tokens. Es preferible un
      // hueco que una ficha del telefono equivocado.
      const problema = modelo.verificar(sku, ficha.nombre);
      if (problema) continue;

      encontrado = hit.ruta;
      break;
    }

    if (encontrado) {
      resultado[sku] = encontrado;
      nuevos.push(sku);
      agregados.push(sku + '  ->  ' + encontrado);
    } else {
      sinHoja.push(sku);
    }

    await pausa(PAUSA_MS);
  }

  if (VERIFICAR) {
    console.log('\n[indexar] === VERIFICACION ===');
    console.log('rutas que siguen existiendo: ' + conservados.length);
    console.log('rutas que ya NO existen:    ' + rotos.length);
    if (rotos.length) {
      console.log('\nSe quitaron del indice porque el dataset las renombro o borro:');
      rotos.forEach((s) => console.log('  - ' + s));
      console.log('\nCorre esto para volver a indexarlas:\n  npm run indexar');
    }
    if (!rotos.length) {
      console.log('\nEl indice esta al dia con el dataset.');
    }
    return;
  }

  const total = guardar(resultado);

  console.log('\n[indexar] === RESULTADO ===');
  console.log('SKUs revisados:     ' + skus.length);
  console.log('nuevos en el indice: ' + nuevos.length);
  console.log('ya estaban:          ' + conservados.length);
  console.log('sin ficha en el dataset: ' + sinHoja.length);
  console.log('total en src/fichas.json: ' + total);

  if (agregados.length) {
    console.log('\nAgregados:');
    agregados.slice(0, 25).forEach((a) => console.log('  ' + a));
    if (agregados.length > 25) console.log('  ... y ' + (agregados.length - 25) + ' mas');
  }

  if (sinHoja.length && MOSTRAR > 0) {
    console.log('\nSin ficha (huecos del dataset, no bugs):');
    sinHoja.slice(0, MOSTRAR).forEach((s) => console.log('  ' + s));
    if (sinHoja.length > MOSTRAR) {
      console.log('  ... y ' + (sinHoja.length - MOSTRAR) + ' mas (--muestra=0 para ocultar)');
    }
  }

  console.log('\n[indexar] ' + rutaRelativa() + ' actualizado.');
}

function rutaRelativa() {
  return path.relative(RAIZ, RUTA_SALIDA);
}

main().catch((e) => {
  console.error('\n[indexar] ERROR: ' + e.message);
  process.exit(1);
});