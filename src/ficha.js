'use strict';

// Orquesta la ficha tecnica. Fuentes, en orden de preferencia:
//
//   1. src/indice.js  -> src/fichas.json: indice horneado y verificado.
//                        Sin GITHUB_TOKEN y sin rate limit. Cubre 89 de
//                        los 225 SKUs reales de la tienda.
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
// La MEMORIA la pone el SKU, no la base: ver aplicarMemoriaDelSku().
//
// Los ARGUMENTOS DE VENTA los redacta src/ia.js (Groq) usando esta ficha
// como unico contexto. Si Groq falla, se entrega la ficha sin argumentos
// y con argumentosError explicando por que.

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

/**
 * Memoria que declara el SKU: "POCO X7 PRO 512/12" -> 512 GB y 12 GB.
 *
 * El orden es almacenamiento/RAM: en la tienda "64/4" es 64 de
 * almacenamiento y 4 de RAM, no al reves.
 */
function memoriaDelSku(texto) {
  const m = String(texto === undefined || texto === null ? '' : texto).match(
    /(\d+)\s*\/\s*(\d+)\b/
  );
  if (!m) return null;
  const almacenamiento = Number(m[1]);
  const ram = Number(m[2]);
  if (!almacenamiento || !ram) return null;
  return { ram: ram, almacenamiento: almacenamiento };
}

/**
 * La memoria del SKU le gana a la de la base de datos.
 *
 * Medido el 2026-10-03 sobre 70 SKUs con memoria explicita: solo 20
 * coincidian con la ficha. La base guarda UNA variante del modelo, y el
 * modelo se vende en varias. El procesador, la pantalla, la camara y la
 * bateria son los mismos en todas; la RAM y el almacenamiento no.
 *
 * Ejemplos de lo que pasaba:
 *   REDMI 15 256/8      -> ficha decia 16 GB RAM   (el SKU es de 8)
 *   REDMI 17 128/4      -> ficha decia 12 GB RAM   (el SKU es de 4)
 *   MOTOROLA G15 128/4  -> ficha decia 8 GB RAM    (el SKU es de 4)
 *   REALME 13 5G 256/12 -> ficha decia 6 GB RAM    (el SKU es de 12)
 *
 * Decirle a un cliente "16 GB de RAM" cuando la etiqueta dice 8 es peor
 * que no decir nada. El numero que vale es el de la etiqueta, que es la
 * que esta pegada en la caja; la base solo aporta el resto de la ficha.
 */
function aplicarMemoriaDelSku(ficha, texto) {
  const mem = memoriaDelSku(texto);
  if (!mem) return;

  const textoMemoria = mem.ram + ' GB RAM \u00b7 ' + mem.almacenamiento + ' GB almacenamiento';

  ficha.ramAlmacenamiento = textoMemoria;
  // El resumen arrastra la memoria de la base: hay que corregirla tambien
  // o el panel mostraria las dos y la IA leeria la vieja.
  if (ficha.resumen) {
    ficha.resumen = ficha.resumen
      .replace(/\d+\s*GB\s*RAM/gi, mem.ram + ' GB RAM')
      .replace(/[\d\s/]*\d+\s*GB\s*almacenamiento/gi, mem.almacenamiento + ' GB almacenamiento');
  }
  ficha.memoriaDelSku = true;
}

async function finalizar(ficha, cache, ip) {
  ficha.puntosDeVenta = [];
  ficha.argumentosError = null;

  if (ia.habilitado()) {
    try {
      ficha.puntosDeVenta = await ia.argumentosDeVenta(ficha, ip);
    } catch (e) {
      // Antes se devolvia la lista vacia sin decir por que, y el vendedor
      // no tenia forma de distinguir "la IA no tiene nada que decir" de
      // "la IA esta caida". Ahora el motivo viaja con la respuesta.
      ficha.argumentosError = e.message;
      console.error('[ficha] Groq fallo, se entrega solo la ficha: ' + e.message);
    }
  } else {
    ficha.argumentosError = 'La IA no esta habilitada (falta GROQ_API_KEY en el servidor).';
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
        if (!problema) {
          aplicarMemoriaDelSku(r0.ficha, texto);
          return finalizar(r0.ficha, r0.cache, ip);
        }
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
      if (!problema) {
        aplicarMemoriaDelSku(r1.ficha, texto);
        return finalizar(r1.ficha, r1.cache, ip);
      }
      razones.push('dataset: ' + problema);
    }
  } catch (e1) {
    razones.push('dataset: ' + e1.message);
  }

  // 3) scraper de GSMArena
  try {
    const r2 = await specs.buscarFicha(texto);
    const problema = verificar(r2.ficha, texto);
    if (!problema) {
      aplicarMemoriaDelSku(r2.ficha, texto);
      return finalizar(r2.ficha, r2.cache, ip);
    }
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
  memoriaDelSku: memoriaDelSku,
  aplicarMemoriaDelSku: aplicarMemoriaDelSku,
  enIndice: indice.tiene,
  indiceCuantos: indice.cuantos,
};