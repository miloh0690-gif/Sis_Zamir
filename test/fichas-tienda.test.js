'use strict';

// La tabla curada de la tienda (src/fichas-tienda.json) es la unica fuente
// de fichas que no viene de una base de datos automatizada: se armo a mano
// contra GSMArena. Estas pruebas cuidan las dos cosas que pueden romperla en
// silencio: que las fichas esten completas y citadas, y que la normalizacion
// del SKU siga encontrandolas.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const tienda = require('../src/tienda');
const tabla = require('../src/fichas-tienda.json');

test('la tabla tiene una entrada por cada SKU que las bases no resuelven', () => {
  assert.ok(tienda.cuantos() >= 120, 'la tabla se achico: hay ' + tienda.cuantos());
});

test('cada ficha trae los datos que el vendedor lee en voz alta', () => {
  const vacias = [];
  for (const [clave, f] of Object.entries(tabla)) {
    if (!f.nombre || !f.pantalla || !f.bateria || !f.ramAlmacenamiento) vacias.push(clave);
  }
  assert.deepEqual(vacias, [], 'fichas sin nombre, pantalla, bateria o memoria');

  // GSMArena no publica el chipset del Tecno Megapad Pro. No se inventa: se
  // deja vacio y el resumen simplemente no lo menciona.
  const sinProcesador = Object.entries(tabla)
    .filter(([, f]) => !f.procesador)
    .map(([k]) => k);
  assert.deepEqual(sinProcesador, ['tecno megapad pad pro']);
});

test('cada ficha cita la pagina de GSMArena de la que salio', () => {
  for (const [clave, f] of Object.entries(tabla)) {
    assert.ok(Array.isArray(f.fuentes) && f.fuentes.length, clave + ' no cita fuente');
    for (const u of f.fuentes) {
      assert.match(u, /^https:\/\/www\.gsmarena\.com\/[a-z0-9_().+-]+\.php$/, clave + ': ' + u);
    }
    assert.equal(f.fuenteDatos, 'tienda', clave + ': fuenteDatos inesperado');
  }
});

test('la clave del SKU ignora memoria, estado de caja y ruido', () => {
  const casos = [
    ['REDMI NOTE 17 PRO MAX 512/12', 'redmi note 17 pro max'],
    ['SAMSUNG ZFOLD 7 512/12', 'samsung z fold 7'],
    ['HONOR X8D 256/8', 'honor x8d'],
    ['TECNO MEGA PAD PRO', 'tecno megapad pad pro'],
    ['TAB S10 FE+ 13 WIFI 256/8', 'tab s10 fe plus'],
    ['MOTO 50 RAZR ULTRA CAJA GRANDE 512/8/12', 'moto 50 razr ultra'],
    ['CUBOT KINKONGES 5 128/4', 'cubot kingkong es 5'],
    ['TCL 60 NP 512/8', 'tcl 60 nxtpaper'],
    ['IPHONE 15 PRO MAX 256 CHIP caja blanca', 'iphone 15 pro max'],
    ['SAMSUNG SH S25 Ultra 1T/12 vietnam', 'samsung s25 ultra'],
  ];
  for (const [sku, esperado] of casos) {
    assert.equal(tienda.clave(sku), esperado, sku);
  }
});

test('los SKUs dificiles encuentran su ficha y ninguno cae en otro modelo', () => {
  const casos = [
    ['TAB S9 5G 128/6', 'Samsung Galaxy Tab S9'],
    ['MOTOROLA SIGNATURE 1T/16', 'Motorola Signature'],
    ['POCO X8 PRO MAX 512/12', 'Xiaomi Poco X8 Pro Max'],
    ['REALME 16 PRO PLUS', 'Realme 16 Pro+'],
    ['ZTE V80 MAX 256/4', 'ZTE Blade V80 Max'],
  ];
  for (const [sku, nombre] of casos) {
    const r = tienda.buscar(sku);
    assert.ok(r && r.ficha, 'sin ficha para ' + sku);
    assert.equal(r.ficha.nombre, nombre, sku);
  }
});

test('buscar devuelve una copia: la memoria del SKU no contamina la tabla', () => {
  const a = tienda.buscar('REDMI NOTE 17 PRO MAX 512/12').ficha;
  const antes = tabla['redmi note 17 pro max'].ramAlmacenamiento;
  a.ramAlmacenamiento = '12 GB RAM · 512 GB almacenamiento';
  a.puntosDeVenta = ['prueba'];
  const b = tienda.buscar('REDMI NOTE 17 PRO MAX 512/12').ficha;
  assert.equal(b.ramAlmacenamiento, antes);
  assert.deepEqual(b.puntosDeVenta || [], []);
  assert.notEqual(a.fuentes, b.fuentes, 'las fuentes se comparten por referencia');
});

test('un SKU que no esta en la tabla no devuelve una ficha parecida', () => {
  assert.equal(tienda.buscar('MACBOOK AIR 13 M5 512/16'), null);
  assert.equal(tienda.buscar('CUBOT KINKONG 3 256/6'), null);
  assert.equal(tienda.buscar(''), null);
});

test('ficha.js consulta la tabla antes que el resto de las fuentes', () => {
  const src = fs.readFileSync(require.resolve('../src/ficha.js'), 'utf8');
  const iTienda = src.indexOf('tienda.buscar(texto)');
  const iIndice = src.indexOf('indice.tiene(texto)');
  assert.notEqual(iTienda, -1, 'ficha.js ya no consulta src/tienda.js');
  assert.ok(iTienda < iIndice, 'la tabla curada tiene que ir antes del indice');
});
