'use strict';

// Orquesta la ficha tecnica. Fuentes, en orden de preferencia:
//
//   1. src/dataset.js -> dataset abierto en GitHub (datos estructurados)
//   2. src/specs.js   -> scraper de GSMArena (respaldo, cubre los ultimos)
//
// Antes de devolver nada se VERIFICA que la ficha sea del telefono que se
// pidio. Sin esa comprobacion la base de datos responde con el modelo mas
// parecido y el vendedor le dice esas especificaciones al cliente:
// "REDMI 17 256/4" devolvia el Redmi 9 y "IPHONE 17 PRO MAX" devolvia el
// iPhone 17 Pro. Es preferible decir "no hay ficha" antes que mentir.
//
// Los ARGUMENTOS DE VENTA los redacta src/ia.js (Groq) usando esta ficha
// como unico contexto. Si Groq falla, se entrega la ficha sin argumentos.

const dataset = require('./dataset');
const specs = require('./specs');
const ia = require('./ia');

// Modificadores que distinguen un telefono de otro. 5G/4G/Lite/Fe NO estan
// aqui: son variantes de conectividad que comparten nucleo de ficha.
const ESTRICTOS = ['pro', 'max', 'ultra', 'mini', 'plus'];

function habilitado() {
  return true;
}

function hayArgumentos() {
  return ia.habilitado();
}

function palabraEn(texto, palabra) {
  const partes = String(texto === undefined || texto === null ? '' : texto)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return partes.indexOf(palabra) !== -1;
}

function generacion(texto) {
  const numeros = String(texto === undefined || texto === null ? '' : texto).match(/\d+/g) || [];
  return numeros
    .map(function (n) {
      return Number(n);
    })
    .filter(function (n) {
      return n >= 10;
    });
}

/**
 * Devuelve null si la ficha es del telefono pedido, o el motivo del
 * rechazo si no lo es.
 */
function verificar(ficha, pedido) {
  if (!ficha) return 'la fuente no devolvio nada';
  if (!ficha.nombre) return 'la ficha no trae nombre';

  const nombre = ficha.nombre;
  const pedidoGen = generacion(pedido);
  const nombreGen = generacion(nombre);

  if (pedidoGen.length) {
    let coincide = false;
    for (let i = 0; i < pedidoGen.length; i++) {
      if (nombreGen.indexOf(pedidoGen[i]) !== -1) coincide = true;
    }
    if (!coincide) return 'es de otro modelo (' + nombre + ')';
  }

  for (let j = 0; j < ESTRICTOS.length; j++) {
    const mod = ESTRICTOS[j];
    if (palabraEn(pedido, mod) && !palabraEn(nombre, mod)) {
      return 'le falta "' + mod + '" (' + nombre + ')';
    }
  }

  return null;
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

  // 1) dataset estructurado
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

  // 2) scraper de GSMArena
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
};