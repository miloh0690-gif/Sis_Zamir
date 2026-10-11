'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const code = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');
const contexto = {};
vm.runInNewContext(code, contexto, { filename: 'Code.gs' });

test('permite validar una venta sin inventario y sin fila para descontar stock', () => {
    const hojaInventario = {
        getLastRow() {
            return 1;
        },
    };

    const resultado = contexto.validarOperacion(hojaInventario, {
        tipoOperacion: 'VENTA',
        subTipo: 'SIN_INVENTARIO',
        modelo: 'Modelo manual',
        cantidad: 1,
    });

    assert.equal(resultado.ok, true);
    assert.equal(resultado.filaData, null);
});
