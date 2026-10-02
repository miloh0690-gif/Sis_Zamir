'use strict';

// Fachada de la ficha tecnica. server.js sigue hablando con este modulo.
//
// Reparto de responsabilidades (los nombres se parecen, asi que va
// clarifying):
//   src/specs.js  -> los DATOS, desde una base de datos real de telefonos
//   src/ia.js     -> los ARGUMENTOS DE VENTA, desde Groq (solo redacta)
//   src/ficha.js  -> orquesta ambos
//
// Este archivo existe para no romper los requires existentes.

const ficha = require('./ficha');

module.exports = {
  fichaTecnica: ficha.fichaTecnica,
  habilitado: ficha.habilitado,
  hayArgumentos: ficha.hayArgumentos,
  modelo: ficha.modeloArgs,
};