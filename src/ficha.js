'use strict';

// Orquesta la ficha tecnica. Fuentes, en orden de preferencia:
//
//   1. src/indice.js  -> src/fichas.json: indice horneado y verificado.
//                        Sin GITHUB_TOKEN y sin rate limit. Cubre 89 de
//                        los 225 SKUs reales de la tienda.
//   2. src/gsm.js     -> BUSQUEDA en el espejo de GSMArena, con los nombres
//                        oficiales ("Samsung Galaxy A06"). Cubre los que el
//                        indice no tiene, sin GITHUB_TOKEN.
//   3. src/dataset.js -> indice en vivo del dataset (necesita GITHUB_TOKEN)
//   4. src/specs.js   -> coincidencia exacta de nombre (respaldo)
//   5. src/iaficha.js -> fichas redactadas por IA. ULTIMO recurso, y van
//                        marcadas como no verificadas. La IA solo llega
//                        aqui cuando ninguna base de datos tiene el equipo.
//
// Todo lo que sale de las fuentes 1 a 4 pasa por el gate de src/modelo.js.
// La fuente 5 NO: por definicion no hay con que verificarla, y por eso
// viaja con verificado:false, fuenteDatos:'ia' y el resultado de comparar
// dos respuestas independientes (estable / diferencias).
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
const gsm = require('./gsm');
const dataset = require('./dataset');
const specs = require('./specs');
const iaficha = require('./iaficha');
const ia = require('./ia');
const modelo = require('./modelo');

// La ficha por IA se puede apagar. Con FICHAS_POR_IA=0 el sistema vuelve a
// decir "no hay ficha verificada" en vez de mostrar una ficha de IA. Es la
// opcion para cuando Milo prefiera no arriesgar una especificacion al
// cliente aunque venga marcada como no verificada.
const IA_COMO_FICHA =
  String(process.env.FICHAS_POR_IA === undefined ? '1' : process.env.FICHAS_POR_IA) !== '0';

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
  // El resumen arrastra la memoria de la base y el panel lo muestra, asi
  // que hay que corregirlo tambien. Ojo: en el resumen el almacenamiento
  // NO dice "almacenamiento", dice "256 / 512 GB" a secas, y va al final.
  if (ficha.resumen) {
    ficha.resumen = ficha.resumen.replace(
      /\d+\s*GB\s*RAM/gi,
      mem.ram + ' GB RAM'
    );
    // Forma con la palabra: "64 GB almacenamiento".
    ficha.resumen = ficha.resumen.replace(
      /[\d\s/]*\d+\s*GB\s*almacenamiento/gi,
      mem.almacenamiento + ' GB almacenamiento'
    );
    // Forma desnuda al final: "..., 128 / 256 GB." Es la que arma
    // dataset.mapear, porque ahi el almacenamiento no lleva ninguna palabra.
    ficha.resumen = ficha.resumen.replace(
      /(?:\s*,\s*|\s+)[\d\s/]*\d+\s*GB\s*\.?\s*$/,
      ', ' + mem.almacenamiento + ' GB.'
    );
  }
  ficha.memoriaDelSku = true;
}

/**
 * `opciones.sinArgumentos` se usa para la ficha de IA: si los datos no
 * coinciden entre dos consultas, no se inventan argumentos de venta encima,
 * porque multiplicaria el riesgo.
 */
async function finalizar(ficha, cache, ip, opciones) {
  const opts = opciones || {};
  ficha.puntosDeVenta = [];
  ficha.argumentosError = opts.nota || null;

  if (opts.sinArgumentos) return { ficha: ficha, cache: cache };

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

  // 2) busqueda en el espejo de GSMArena con nombres oficiales
  if (gsm.habilitado()) {
    try {
      const rg = await gsm.buscar(texto);
      if (rg && rg.ficha) {
        const problema = verificar(rg.ficha, texto);
        if (!problema) {
          aplicarMemoriaDelSku(rg.ficha, texto);
          return finalizar(rg.ficha, rg.cache, ip);
        }
        razones.push('gsm: ' + problema);
      }
    } catch (eg) {
      razones.push('gsm: ' + eg.message);
    }
  }

  // 3) indice en vivo del dataset (necesita GITHUB_TOKEN)
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

  // 4) coincidencia exacta de nombre en GSMArena
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

  // 5) ultimo recurso: la ficha la redacta la IA. No se verifica contra
  //    una base porque no hay ninguna que la verifique, asi que se marca.
  if (IA_COMO_FICHA) {
    let r3 = null;
    try {
      r3 = await iaficha.buscar(texto);
    } catch (e3) {
      razones.push('ia: ' + e3.message);
    }

    if (r3 && r3.ficha) {
      const f = r3.ficha;
      // La identidad sigue sin verificarse: si la IA contesta con otro
      // telefono, es peor que no devolver nada.
      const problema = verificar(f, texto);
      if (!problema) {
        aplicarMemoriaDelSku(f, texto);
        f.verificado = false;
        f.esFichaDeIa = true;
        f.estable = r3.estable;
        f.diferencias = r3.diferencias;

        const nota = r3.estable
          ? 'Ficha redactada por IA, no verificada contra ninguna base de ' +
            'datos. Las dos consultas coincidieron, pero confirmala antes de ' +
            'leerla al cliente.'
          : 'Ficha de IA SIN VERIFICAR: los datos no coinciden entre dos ' +
            'consultas (' + (r3.diferencias.join(', ') || 'sin detalle') +
            '). El modelo esta inventando. No la leas al cliente.';

        return finalizar(f, false, ip, { sinArgumentos: !r3.estable, nota: nota });
      }
      razones.push('ia: ' + problema);
    } else if (r3 && r3.mensaje) {
      razones.push('ia: ' + r3.mensaje);
    }
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
  iaComoFicha: function () {
    return IA_COMO_FICHA && iaficha.habilitado();
  },
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