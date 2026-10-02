'use strict';

// Orquesta la ficha tecnica: los DATOS vienen de la base de datos y los
// ARGUMENTOS de venta del modelo de lenguaje, que solo redacta sobre lo
// que ya existe. Si Groq falla, la ficha se entrega igual sin
// argumentos: la app nunca se queda en blanco.

const specs = require('./specs');
const ia = require('./ia');

function habilitado() {
  return specs.habilitado();
}

function hayArgumentos() {
  return ia.habilitado();
}

async function fichaTecnica(modelo, ip) {
  const resultado = await specs.buscarFicha(modelo);
  const ficha = Object.assign({}, resultado.ficha);

  ficha.puntosDeVenta = [];

  if (ia.habilitado()) {
    try {
      ficha.puntosDeVenta = await ia.argumentosDeVenta(ficha, ip);
    } catch (e) {
      console.error('[ficha] Groq fallo, se entrega solo la ficha: ' + e.message);
    }
  }

  return { ficha: ficha, cache: resultado.cache };
}

module.exports = {
  fichaTecnica: fichaTecnica,
  habilitado: habilitado,
  hayArgumentos: hayArgumentos,
  modeloArgs: ia.modelo,
};