'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizarVenta } = require('../src/ledger');

test('lee cliente, nota, accesorios y foto de la fila', () => {
    const v = normalizarVenta({ fecha: '2026-10-12', vendedor: 'Carlos', modelo: 'X1',
        tipo: 'UNIDAD', cantidad: 1, tipoCambio: 11.75,
        precioUnitarioBs: 200, costoTotalBs: 130, totalCobradoBs: 280,
        gananciaBs: 150, comisionBs: 45, sucursal: 'Central',
        cliente: 'Doña María', nota: 'se le regaló un vidrio',
        accesorios: 'vidrio, cargador', accesoriosBs: 80,
        accesoriosCostoBs: 30, foto: 'https://drive.google.com/uc?export=view&id=ABC' });

    assert.equal(v.cliente, 'Doña María');
    assert.equal(v.nota, 'se le regaló un vidrio');
    assert.equal(v.accesorios, 'vidrio, cargador');
    assert.equal(v.accesoriosBs, 80);
    assert.equal(v.accesoriosCostoBs, 30);
    assert.equal(v.foto, 'https://drive.google.com/uc?export=view&id=ABC');
});

test('las ventas viejas devuelven strings vacios, nunca undefined', () => {
    const v = normalizarVenta({});

    assert.equal(v.cliente, '');
    assert.equal(v.nota, '');
    assert.equal(v.accesorios, '');
    assert.equal(v.foto, '');
    assert.equal(v.accesoriosBs, 0);
    assert.equal(v.accesoriosCostoBs, 0);
});

test('un valor de dinero no numérico se vuelve 0 y no rompe la venta', () => {
    const v = normalizarVenta({ accesoriosBs: 'no sé', accesoriosCostoBs: '30' });

    assert.equal(v.accesoriosBs, 0);
    assert.equal(v.accesoriosCostoBs, 30);
    assert.equal(v.vendedor, '');
});

test('el texto conserva acentos y mayúsculas tal cual', () => {
    const v = normalizarVenta({
        cliente: 'Álvaro Núñez',
        nota: 'Se le regaló un VIDRIO',
        accesorios: 'CARGADOR premium',
        foto: 'FOTO-ABC',
    });

    assert.equal(v.cliente, 'Álvaro Núñez');
    assert.equal(v.nota, 'Se le regaló un VIDRIO');
    assert.equal(v.accesorios, 'CARGADOR premium');
    assert.equal(v.foto, 'FOTO-ABC');
});

test('los alias viejos siguen funcionando', () => {
    const v = normalizarVenta({
        precioUnitario: 200,
        costoTotal: 130,
        totalCobrado: 280,
        gananciaRegistrada: 150,
        comision: 45,
    });

    assert.equal(v.precioUnitarioBs, 200);
    assert.equal(v.costoTotalBs, 130);
    assert.equal(v.totalCobradoBs, 280);
    assert.equal(v.gananciaBs, 150);
    assert.equal(v.comisionBs, 45);
});

// Nota: la hoja y normalizarVenta manejan estos importes en bolivianos (Bs),
// no en centavos; por eso accesoriosBs=80 se espera como 80 y no como 8000.
