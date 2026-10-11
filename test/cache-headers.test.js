'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');

function extraerMiddleware() {
    const inicio = source.indexOf('app.use((req, res, next) => {');
    assert.notEqual(inicio, -1, 'server.js debe seguir teniendo el middleware de seguridad');
    const fin = source.indexOf('\n});', inicio);
    assert.notEqual(fin, -1, 'no se pudo cerrar el middleware de seguridad');
    return source.slice(inicio, fin + 4);
}

test('el middleware de seguridad marca toda respuesta como no cacheable', () => {
    let manejador = null;
    vm.runInNewContext(extraerMiddleware(), {
        app: { use: (fn) => { manejador = fn; } },
    }, { filename: 'server.js' });
    assert.ok(manejador, 'el middleware debe registrarse con app.use');

    const puestas = {};
    let siguiente = false;
    manejador({}, { setHeader: (k, v) => { puestas[k] = v; } }, () => { siguiente = true; });

    assert.equal(puestas['Cache-Control'], 'no-store');
    assert.equal(siguiente, true, 'el middleware debe seguir la cadena');
});