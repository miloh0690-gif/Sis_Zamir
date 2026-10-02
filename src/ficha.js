'use strict';

// Orquesta la ficha tecnica. Fuentes, en orden de preferencia:
//
//   1. src/dataset.js -> dataset abierto en GitHub. Datos estructurados y
//      verificados, con las marcas chinas (Xiaomi, Oppo, Honor, Infinix,
//      Vivo) que el scraper no tiene.
//   2. src/specs.js   -> scraper de GSMArena. Respaldo para los modelos
//      que el dataset no tiene.
//
// Los ARGUMENTOS DE VENTA los redacta src/ia.js (Groq) usando estas
// specs como unico contexto, para que no invente nada. Si Groq falla, la
// ficha se entrega igual sin argumentos: la app nunca se queda en blanco.

const dataset = require('./dataset');
const specs = require('./specs');
const ia = require('./ia');

function habilitado() {
  return true;
}

function hayArgumentos() {
  return ia.habilitado();
}

async function fichaTecnica(modelo, ip) {
  const texto = String(modelo || '').trim();
  if (!texto) {
    const e = new Error('Indica el modelo a consultar.');
    e.codigo = 400;
    throw e;
  }

  let ficha = null;
  let cache = false;
  let falloDataset = null;

  try {
    const resultado = await dataset.buscarFicha(texto);
    if (resultado) {
      ficha = resultado.ficha;
      cache = resultado.cache;
    }
  } catch (e) {
    falloDataset = e;
    console.error('[ficha] dataset fallo: ' + e.message);
  }

  if (!ficha) {
    const resultado = await specs.buscarFicha(texto);
    ficha = resultado.ficha;
    cache = resultado.cache;
  }

  ficha.puntosDeVenta = [];

  if (ia.habilitado()) {
    try {
      ficha.puntosDeVenta = await ia.argumentosDeVenta(ficha, ip);
    } catch (e) {
      console.error('[ficha] Groq fallo, se entrega solo la ficha: ' + e.message);
    }
  }

  if (falloDataset && !ficha) throw falloDataset;

  return { ficha: ficha, cache: cache };
}

module.exports = {
  fichaTecnica: fichaTecnica,
  habilitado: habilitado,
  hayArgumentos: hayArgumentos,
  modeloArgs: ia.modelo,
};