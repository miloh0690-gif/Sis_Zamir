'use strict';

// Orquesta la ficha tecnica. Fuentes, en orden de preferencia:
//
//   1. src/indice.js  -> src/fichas.json: indice horneado y verificado.
//                        Sin GITHUB_TOKEN y sin rate limit. Cubre 89 de
//                        los 226 SKUs reales de la tienda.
//   2. src/dataset.js -> indice en vivo del dataset (necesita GITHUB_TOKEN)
//   3. src/specs.js   -> scraper de GSMArena (respaldo)
//
// Antes de devolver nada se VERIFICA que la ficha sea del telefono que se
// pidio, comparando tokens de identidad (src/modelo.js). La version
// anterior comparaba numeros >= 10, lo que dejaba pasar "Samsung ZFOLD 5"
// cuando la base devolvia un "Z Flip 5", y "Redmi Note 15 Pro" cuando
// devolvia el "Note 11 Pro+". Es preferible decir "no hay ficha
// verificada" antes que mentirle a un cliente.
//
// Los ARGUMENTOS DE VENTA los redacta src/ia.js (Groq) usando esta ficha
// como unico contexto. Si Groq falla, se entrega la ficha sin argumentos.

const indice = require('./indice');
const dataset = require('./dataset');
const specs = require('./specs');
const ia = require('./ia');
const modelo = require('./modelo');

function habilitado() {
  return true;
}

function hayArgumentos() {
  return ia.habilitado();
}

/**
 * Devuelve null si la ficha es del telefono pedido, o el motivo del
 * rechazo si no lo es.
 *
 * La comparacion por tokens de identidad vive en src/modelo.js. La version
 * anterior comparaba numeros >= 10, lo que dejaba pasar "Samsung ZFOLD 5"
 * cuando la base devolvia un "Z Flip 5" y "Redmi Note 15 Pro" cuando
 * devolvia el "Note 11 Pro+".
 */
function verificar(ficha, pedido) {
  if (!ficha) return 'la fuente no devolvio nada';
  if (!ficha.nombre) return 'la ficha no trae nombre';
  return modelo.verificar(pedido, ficha.nombre);
}

async function finalizar(ficha, cache, ip) {
  ficha.puntosDeVenta = [];

  if (ia.habilitado()) {
    try {
      ficha.puntosDeVenta = await ia.argumentosDeVenta(ficha, ip);
    } catch (e) {
      console.error('[ficha] Groq fallo, se entrega solo la ficha: ' + e.message);
    }
  }

  return { ficha: ficha, cache: cache };
}

async function fichaTecnica(modelo, ip) {
  const texto = String(modelo === undefined || modelo === null ? '' : modelo).trim();
  if (!texto) {
    const e = new Error('Indica el modelo a consultar.');
    e.codigo = 400;
    throw e;
  }

  const razones = [];

  // 1) indice horneado: la via que no depende de ninguna llave
  if (indice.tiene(texto)) {
    try {
      const r0 = await indice.buscar(texto);
      if (r0) {
        const problema = verificar(r0.ficha, texto);
        if (!problema) return finalizar(r0.ficha, r0.cache, ip);
        razones.push('indice: ' + problema);
      } else {
        razones.push('indice: el archivo ya no esta en el dataset');
      }
    } catch (e0) {
      razones.push('indice: ' + e0.message);
    }
  }

  // 2) indice en vivo del dataset (necesita GITHUB_TOKEN)
  try {
    const r1 = await dataset.buscarFicha(texto);
    if (r1) {
      const problema = verificar(r1.ficha, texto);
      if (!problema) return finalizar(r1.ficha, r1.cache, ip);
      razones.push('dataset: ' + problema);
    }
  } catch (e1) {
    razones.push('dataset: ' + e1.message);
  }

  // 3) scraper de GSMArena
  try {
    const r2 = await specs.buscarFicha(texto);
    const problema = verificar(r2.ficha, texto);
    if (!problema) return finalizar(r2.ficha, r2.cache, ip);
    razones.push('scraper: ' + problema);
  } catch (e2) {
    razones.push('scraper: ' + e2.message);
  }

  const detalle = razones.length ? ' (' + razones.join(' | ') + ')' : '';
  const err = new Error(
    'No hay ficha verificada de "' + texto + '" en las bases de datos' +
      detalle +
      '. Prueba con el nombre exacto del fabricante y el modelo.'
  );
  err.codigo = 404;
  throw err;
}

module.exports = {
  fichaTecnica: fichaTecnica,
  habilitado: habilitado,
  hayArgumentos: hayArgumentos,
  modeloArgs: ia.modelo,
  verificar: verificar,
  identidad: modelo.identidad,
  enIndice: indice.tiene,
  indiceCuantos: indice.cuantos,
};