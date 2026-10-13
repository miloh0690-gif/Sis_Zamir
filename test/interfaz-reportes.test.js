'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('public/index.html', 'utf8');
const renderVentas = html.match(/function renderVentas\(ventas\) \{([\s\S]*?)\n        \}\n\n        function renderTablas/);

assert.ok(renderVentas, 'no se encontró renderVentas');
const cuerpo = renderVentas[1];

test('renderVentas pinta cliente, nota y accesorios', () => {
  assert.match(cuerpo, /cliente/);
  assert.match(cuerpo, /nota/);
  assert.match(cuerpo, /accesorios/);
});

test('la foto se muestra como miniatura de 80 px', () => {
  assert.match(cuerpo, /<img[\s\S]*?80px/);
});

test('la miniatura abre la foto en pestana nueva con seguridad', () => {
  assert.match(cuerpo, /target="_blank"[\s\S]*?rel="noopener"/);
});

test('una venta sin foto ni nota no rompe el render', () => {
  for (const campo of ['cliente', 'nota', 'accesorios', 'foto']) {
    assert.match(cuerpo, new RegExp(`v\\.${campo}\\s*\\|\\|\\s*''`), `falta proteger ${campo}`);
  }
});
