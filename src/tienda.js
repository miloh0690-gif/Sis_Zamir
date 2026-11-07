'use strict';

// Tabla curada de fichas para los SKUs que ninguna base resuelve.
//
// Por que existe: de los 167 SKUs que el indice horneado no cubre, el dataset
// de TechAPI tiene CERO y el espejo de GSMArena solo responde por el nombre
// oficial exacto ("Samsung Galaxy A27", no "SAMSUNG A27 256/8"). Se midio
// marca por marca el 2026-11-06: 148 SKUs sin archivo en el dataset, 19 sin
// indice. Buscar mejor no lo arregla; falta la tabla.
//
// src/fichas-tienda.json se armo ficha por ficha contra GSMArena: se bajo la
// pagina del modelo, se convirtio con el mismo formato que dataset.mapear()
// y se comparo el nombre devuelto con el SKU antes de aceptarlo. Cada entrada
// guarda su URL en fuentes[], asi que se puede auditar.
//
// La CLAVE es el SKU normalizado (src/tienda.clave), no el nombre del
// fabricante. Por eso la busqueda es exacta y NO pasa por el gate de
// src/modelo.js: el gate compara tokens de identidad y fallaria en tablets
// ("TAB S9 5G" vs "Galaxy Tab S9"), en ZFold/ZFlip y en los sufijos de caja
// ("ULTRA CAJA GRANDE"). La verificacion aca es la clave: si el SKU no se
// normaliza a una clave de la tabla, no hay ficha. Nunca se parece "un poco".
//
// La tabla guarda UNA variante del modelo. La RAM y el almacenamiento los
// pone el SKU con aplicarMemoriaDelSku(), igual que con las demas fuentes.

const TABLA = require('./fichas-tienda.json');

// Ruido que NO cambia el equipo: estado de la caja, origen, color, pluses de
// marketing y la generacion de red (que va en la ficha, no en el nombre).
const RUIDO = new Set([
  'chip', 'esim', 'jp', 'homo', 'homogenizado', 'vietnam', 'arabe', 'set', 'v2',
  'normal', 'lamborgini', 'lamborghini', 'medio', 'uso', 'sh', 'wifi', '5g', '4g',
  'lte', 'caja', 'blanca', 'grande', 'gift', 'box', 'dual', 'sim', 'nuevo',
  'original', 'azul', 'blanco', 'negro', 'negra', 'lila', 'verde',
  'gris', 'dorado', 'rosa', 'morado', 'titanio', 'ultramarine', 'graphite',
  'natural', 'galaxy',
]);

// Errores de tipeo y abreviaturas que usa la hoja de la tienda.
const ALIAS = {
  ob: 'iphone', sparck: 'spark', kinkong: 'kingkong', kinkones: 'kingkong es',
  kinkon: 'kingkong', kinkonges: 'kingkong es', np: 'nxtpaper', mega: 'megapad',
  zfold: 'z fold', zflip: 'z flip',
};

// El tamano de pantalla solo se quita en tablets: "TAB S9 11" es la de 11",
// pero "SAMSUNG A15 256/8" no lleva tamano.
const TAMANOS = new Set(['8.7', '10.4', '11', '12.4', '14.6', '13', '8.4', '12.9', '10.9', '12.3', '9.7', '14', '15']);

/**
 * SKU de la tienda -> clave de la tabla.
 *
 * Quita la memoria ("256/8", "1T/12", "128GB"), la concatenacion que aparece
 * en la hoja ("10256/8" = 10" + 256/8), el "25612" de un typo, y el ruido.
 * El orden importa: primero la memoria, despues el ruido, y el "+" se
 * convierte en "plus" para no perderlo (S26+ no es S26).
 */
function clave(sku) {
  let t = ' ' + String(sku === undefined || sku === null ? '' : sku) + ' ';
  t = t.replace(/\b[12]\s*[tT]\s*\/\s*\d+/g, ' ');
  t = t.replace(/(\d+)(32|64|128|256|512)\s*\/\s*(\d{1,2})\b/g, '$1 ');
  t = t.replace(/\b\d{1,4}\s*\/\s*\d{1,4}\s*\/\s*\d{1,4}\b/g, ' ');
  t = t.replace(/\b\d{1,4}\s*\/\s*\d{1,4}\b/g, ' ');
  t = t.replace(/\b\d+\s*(gb|tb)\b/gi, ' ');
  t = t.replace(/\b[12]T\b/g, ' ');
  t = t.replace(/\b\d{5}\b/g, ' ');
  t = t.replace(/caja\s+(blanca|grande)/gi, ' ');
  t = t.replace(/gift\s+box/gi, ' ');
  t = t.replace(/medio\s+uso/gi, ' ');
  t = t.replace(/\+/g, ' plus ');
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const esTablet = /\b(tab|tablet|pad)\b/.test(t);
  const palabras = t.split(/[^a-z0-9.]+/).filter(Boolean);
  const salida = [];
  for (const p of palabras) {
    if (RUIDO.has(p)) continue;
    if (esTablet && TAMANOS.has(p)) continue;
    salida.push(ALIAS[p] === undefined ? p : ALIAS[p]);
  }
  // "SAMSUNG A15 256/8 128" -> el almacenamiento suelto al final sobra.
  if (salida.length >= 3 && /^(32|64|128|256|512|1024|2048)$/.test(salida[salida.length - 1])) {
    salida.pop();
  }
  return salida.join(' ');
}

/**
 * Devuelve {ficha, cache} o null. La ficha viene en la forma de
 * dataset.mapear() y ya esta verificada por construccion (ver arriba).
 *
 * Se devuelve una copia: quien la pide le aplica la memoria del SKU y le
 * agrega los puntos de venta, y eso no puede contaminar la tabla.
 */
function buscar(modelo) {
  const k = clave(modelo);
  if (!k) return null;
  const base = TABLA[k];
  if (!base) return null;
  const copia = Object.assign({}, base);
  copia.fuentes = (base.fuentes || []).slice();
  return { ficha: copia, cache: true };
}

function tiene(modelo) {
  const k = clave(modelo);
  return Boolean(k && TABLA[k]);
}

function cuantos() {
  return Object.keys(TABLA).length;
}

module.exports = {
  buscar: buscar,
  tiene: tiene,
  cuantos: cuantos,
  clave: clave,
};
