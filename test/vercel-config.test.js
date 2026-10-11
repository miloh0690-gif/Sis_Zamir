'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const config = JSON.parse(fs.readFileSync(require.resolve('../vercel.json'), 'utf8'));

test('Vercel sirve la interfaz estatica desde public sin build de Node', () => {
    assert.equal(config.framework, null);
    assert.equal(config.buildCommand, null);
    assert.equal(config.outputDirectory, 'public');
});

test('el proxy manda todo /api al backend de Render', () => {
    assert.deepEqual(config.rewrites, [
        { source: '/api/:path*', destination: 'https://sis-zamir.onrender.com/api/:path*' },
    ]);
});

test('las respuestas del proxy nunca se cachean', () => {
    const regla = config.headers.find((h) => h.source === '/api/:path*');
    assert.ok(regla, 'debe existir una regla de headers para /api/:path*');
    const claves = Object.fromEntries(regla.headers.map((h) => [h.key, h.value]));
    assert.equal(claves['x-vercel-enable-rewrite-caching'], '0');
    assert.equal(claves['Cache-Control'], 'no-store, no-cache, must-revalidate');
});