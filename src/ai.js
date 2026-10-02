'use strict';

// Fachada de la ficha tecnica. server.js sigue hablando con este modulo.
//
// Reparto de responsabilidades (los nombres se parecen, asi que va
// clarifying):
//   src/specs.js   -> respaldo: scraper de GSMArena (HTML -> campos)
//   src/dataset.js -> principal: dataset abierto en GitHub (ya estructurado)
//   src/ia.js      -> argumentos de venta con Groq (solo redacta)
//   src/ficha.js   -> orquesta los tres
//
// Este archivo normaliza la forma que server.js consume. Ese servidor
// pide `resultado.datos`, que es el nombre que se usa desde la primera
// version (cuando este modulo era el cliente de Gemini y devolvia
// {datos, cache}). src/ficha.js devuelve {ficha, cache}, asi que la
// traduccion vive aqui y no hace falta tocar el servidor.

const ficha = require('./ficha');

async function fichaTecnica(modelo, ip) {
  const resultado = await ficha.fichaTecnica(modelo, ip);
  return { datos: resultado.ficha, cache: resultado.cache };
}

module.exports = {
  fichaTecnica: fichaTecnica,
  habilitado: ficha.habilitado,
  hayArgumentos: ficha.hayArgumentos,
  modelo: ficha.modeloArgs,
};