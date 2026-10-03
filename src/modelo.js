'use strict';

// Comparacion de modelo entre lo que PIDIO la tienda y lo que devuelve la
// base de datos. Vive aparte porque la usan dos lugares: src/ficha.js en
// cada consulta, y scripts/indexar-fichas.js al generar el indice.
//
// POR QUE NO BASTA COMPARAR NUMEROS
//
// La version anterior (ficha.js) sacaba los numeros >= 10 del pedido y
// buscaba uno igual en el nombre de la ficha. Rompia en dos direcciones:
//
//   "POCO X7 PRO 512/12" -> [512, 12]   el 7 se perdia (7 < 10) y la
//                                        memoria se tomaba por generacion
//   "SAMSUNG ZFOLD 5 256/12" vs "Galaxy Z Flip 5G"
//                          -> comparten el 5, se daba por buena
//   "REDMI NOTE 15 PRO 5G" vs "Redmi Note 11 Pro+"
//                          -> el 5 de "5G" hacia coincidir cualquier cosa
//   "SAMSUNG S26+" vs "Galaxy S26" -> identicas, son telefonos distintos
//
// Un vendedor que le dice a un cliente "su Z Fold 5 tiene la pantalla del
// Z Flip" es peor que no tener ficha. Asi que aqui se comparan TOKENS DE
// IDENTIDAD, no numeros sueltos.

// Memorias: nunca son generacion ni modelo.
const CAPACIDADES = [
  32, 64, 128, 256, 512, 1024, 2048, 4000, 6000, 8000, 12000, 16000,
];

// Palabras que no distinguen un modelo de otro.
// OJO: pro/max/plus/ultra/mini/fe/lite NO van aqui. Son justamente lo que
// separa "Galaxy S26" de "Galaxy S26+" y "GT 30" de "GT 30 Pro".
const NEUTRAS = new Set(['galaxy', 'wifi']);

const MARCAS = new Set([
  'xiaomi', 'redmi', 'poco', 'honor', 'motorola', 'moto', 'samsung', 'apple',
  'iphone', 'ipad', 'macbook', 'realme', 'infinix', 'tecno', 'tcl', 'zte',
  'meizu', 'nubia', 'redmagic', 'cubot', 'black', 'shark',
]);

// Descriptores del negocio: describen la unidad concreta, no el modelo.
const DESCRIPTORES = new Set([
  'chip', 'esim', 'jp', 'lila', 'blanco', 'negra', 'negro', 'azul', 'caja',
  'grande', 'homo', 'homogenizado', 'vietnam', 'arabe', 'original', 'nuevo',
  'importado', 'sri', 'lanka', 'sh', 'gen', 'm1', 'm2', 'm3', 'm4', 'm5',
  'premium', 'edicion', 'power', 'curve',
]);

function esCapacidad(n) {
  return CAPACIDADES.indexOf(n) !== -1;
}

function esAnio(n) {
  return n >= 2010 && n <= 2035;
}

/**
 * Quita memoria y apurea lo que no es parte del modelo.
 * Importante: "1T/12" es 1 TB con 12 GB de RAM, pero "17T" es el modelo
 * Xiaomi 17T. Por eso solo se quitan 1T y 2T, no cualquier \d+T.
 */
function limpiar(texto) {
  let t = String(texto === undefined || texto === null ? '' : texto);
  t = t.replace(/(\d+)\s*\/\s*\d+\b/g, ' ');
  t = t.replace(/\b\d+\s*(gb|tb)\b/gi, ' ');
  t = t.replace(/\b[12]t\b/gi, ' ');
  // 3G/4G/5G se van pegados a la G. Un 5 suelto es modelo ("Neo 5",
  // "Spark Go 3"), no conectividad.
  t = t.replace(/\b[345]g\b/gi, ' ');
  t = t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // "S26+", "Note 15 Pro +" y "S21 +": el mismo "+" que dice "plus".
  return t.replace(/\+/g, ' plus ');
}

/**
 * Conjunto de tokens que identifican el modelo. Se parte lo que va pegado:
 * "Magic8" -> magic,8 ; "G06" -> g,6 ; "X5C" -> x,5,c. Ese sufijo de letra
 * es justo lo que distingue X5 de X5C, y antes se colaba.
 */
function identidad(texto) {
  const limpio = limpiar(texto);
  const salida = {};

  const crudos = limpio.split(/[^a-z0-9]+/);
  for (let i = 0; i < crudos.length; i++) {
    const tok = crudos[i];
    if (!tok || DESCRIPTORES.has(tok)) continue;

    const partes = tok.match(/[a-z]+|[0-9]+/g) || [];
    for (let j = 0; j < partes.length; j++) {
      const p = partes[j];
      if (!p) continue;
      if (NEUTRAS.has(p) || MARCAS.has(p) || DESCRIPTORES.has(p)) continue;
      if (p === 'lte' || p === 'td') continue;
      if (/^[0-9]+$/.test(p)) {
        const n = Number(p);
        if (esCapacidad(n)) continue;
        if (esAnio(n)) continue;
      }
      salida[p] = true;
    }
  }

  return salida;
}

function comoLista(obj) {
  return Object.keys(obj).sort();
}

/**
 * Devuelve null si la ficha es del telefono pedido, o el motivo del
 * rechazo si no lo es. Preferible "no hay ficha" antes que mentir.
 */
function verificar(pedido, nombreFicha) {
  const ped = identidad(pedido);
  const nom = identidad(nombreFicha);

  const pedidoVacio = comoLista(ped).length === 0;
  if (pedidoVacio) return null;

  if (comoLista(nom).length === 0) {
    return 'la ficha no trae modelo (' + nombreFicha + ')';
  }

  const faltan = [];
  const sobran = [];
  const clavesPed = comoLista(ped);
  const clavesNom = comoLista(nom);
  for (let i = 0; i < clavesPed.length; i++) {
    if (!nom[clavesPed[i]]) faltan.push(clavesPed[i]);
  }
  for (let i = 0; i < clavesNom.length; i++) {
    if (!ped[clavesNom[i]]) sobran.push(clavesNom[i]);
  }

  if (!faltan.length && !sobran.length) return null;
  if (faltan.length) {
    return 'le falta "' + faltan.join('", "') + '" (' + nombreFicha + ')';
  }
  return 'es otro modelo, sobra "' + sobran.join('", "') + '" (' + nombreFicha + ')';
}

module.exports = {
  verificar: verificar,
  identidad: identidad,
  limpiar: limpiar,
  comoLista: comoLista,
  CAPACIDADES: CAPACIDADES,
  DESCRIPTORES: DESCRIPTORES,
  MARCAS: MARCAS,
  NEUTRAS: NEUTRAS,
};