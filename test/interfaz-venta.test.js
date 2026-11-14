const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('public/index.html', 'utf8');

test('el formulario tiene los 7 elementos nuevos', () => {
  for (const id of [
    'clienteVenta',
    'notaVenta',
    'listaAccesorios',
    'btnAgregarAccesorio',
    'btnTomarFoto',
    'miniaturaFoto',
    'btnQuitarFoto',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `falta id="${id}"`);
  }
});

test('la nota tiene el ejemplo que pidio el cliente', () => {
  assert.match(html, /placeholder="[^"]*regal[^"]*vidrio/i);
});

test('cuerpoVenta manda los 4 campos nuevos', () => {
  for (const campo of ['cliente:', 'nota:', 'accesorios:', 'fotoBase64:']) {
    assert.ok(html.includes(campo), `falta ${campo}`);
  }
});

test('el script inline sigue siendo JavaScript valido', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  for (const [, src] of scripts) {
    assert.doesNotThrow(() => new Function(src));
  }
});

test('la foto se redimensiona a 1200 px y se exporta como JPEG', () => {
  assert.ok(html.includes('1200'));
  assert.ok(html.includes('image/jpeg'));
  assert.ok(html.includes('0.7'));
});

test('el total de los accesorios se muestra y se suma al detalle de precio', () => {
  assert.ok(html.includes('txtAccesoriosTotal'));
  assert.ok(html.includes('leerAccesorios'));
  assert.match(html, /programarPreview[\s\S]{0,500}(?:accesorio|Accesorio)/);
});

test('escribir el cliente o la nota no vuelve a pedir el precio', () => {
  // El precio solo depende de modelo, tipo, cantidad, TC, costo y accesorios.
  // Cliente y nota disparaban un POST por pausa de 250 ms sin cambiar nada.
  assert.doesNotMatch(html, /\$\('clienteVenta'\)\.addEventListener\('input',\s*programarPreview\)/);
  assert.doesNotMatch(html, /\$\('notaVenta'\)\.addEventListener\('input',\s*programarPreview\)/);
});

test('el detalle del precio dice que modelo resolvio el servidor', () => {
  assert.match(html, /datos\.modeloResuelto/);
  assert.match(html, /coincidencia === 'parcial'/);
});
