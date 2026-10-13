'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');
const ctx = {};
vm.runInNewContext(code, ctx, { filename: 'Code.gs' });
ctx.Logger = { log() {} };

test('las 6 columnas nuevas estan en ENCABEZADO_VENTAS', () => {
    ['Cliente', 'Nota', 'Accesorios', 'AccesoriosBs', 'AccesoriosCostoBs', 'Foto']
        .forEach((nombre) => assert.ok(ctx.ENCABEZADO_VENTAS.includes(nombre), nombre));
});

test('el version declarado es 6', () => {
  assert.match(code, /version:\s*6/);
});

test('textoCelda sanea una formula de Sheets', () => {
    assert.equal(ctx.textoCelda('=IMPORTXML("http://x","//a")')[0], "'");
});

test('textoCelda recorta a 500 caracteres', () => {
    assert.equal(ctx.textoCelda('x'.repeat(900)).length, 500);
});

test('textoCelda convierte null y undefined en cadena vacia', () => {
    assert.equal(ctx.textoCelda(null), '');
    assert.equal(ctx.textoCelda(undefined), '');
});

test('textoAccesorios arma la lista y omite los vacios', () => {
    assert.equal(
        ctx.textoAccesorios([{ nombre: 'vidrio' }, { nombre: '' }, { nombre: 'cargador' }]),
        'vidrio, cargador'
    );
});

test('registrarVenta escribe las columnas nuevas por nombre', () => {
    const encabezado = [
        'Vendedor', 'TotalCobrado', 'Modelo', 'GananciaEquipo', 'Fecha',
        'Tipo', 'Cantidad', 'TC', 'PrecioUnitarioBs', 'CostoTotalBs',
        'TotalBs', 'GananciaBs', 'ComisionBs', 'Sucursal', 'ClaveIdempotencia',
    ];
    let filaEscrita;
    const hoja = {
        getName() {
            return 'Ventas';
        },
        getLastColumn() {
            return 15;
        },
        getRange(fila, columna, cantidadFilas, cantidadColumnas) {
            assert.equal(fila, 1);
            if (cantidadFilas === undefined) {
                return { setValue() {} };
            }
            assert.equal(columna, 1);
            assert.equal(cantidadFilas, 1);
            assert.equal(cantidadColumnas, 15);
            return { getValues: () => [encabezado] };
        },
        appendRow(fila) {
            filaEscrita = fila;
        },
    };
    const ss = {
        getSheetByName(nombre) {
            assert.equal(nombre, 'Ventas');
            return hoja;
        },
    };

    ctx.registrarVenta(ss, {
        vendedor: 'Ana',
        modelo: 'X1',
        tipo: 'UNIDAD',
        cantidad: 2,
        tipoCambio: 11,
        precioUnitarioBs: 200,
        totalCobrado: 400,
        comision: 30,
        sucursal: 'Central',
        claveIdempotencia: 'clave-1',
        cliente: 'Cliente nuevo',
        nota: 'Nota nueva',
        accesoriosTexto: 'vidrio, cargador',
        fotoUrl: 'foto-1',
    }, {
        costoTotalBs: 150,
        gananciaBs: 250,
        precioAccesoriosBs: 80,
        costoAccesoriosBs: 30,
    });

    assert.equal(filaEscrita.length, 19);
    assert.equal(filaEscrita[0], 'Ana');
    assert.equal(filaEscrita[1], '');
    assert.equal(filaEscrita[2], 'X1');
    assert.equal(filaEscrita[3], '');
    assert.equal(Object.prototype.toString.call(filaEscrita[4]), '[object Date]');
    assert.equal(filaEscrita[5], 'UNIDAD');
    assert.equal(filaEscrita[6], 2);
    assert.equal(filaEscrita[7], 11);
    assert.equal(filaEscrita[8], 200);
    assert.equal(filaEscrita[9], 150);
    assert.equal(filaEscrita[10], 400);
    assert.equal(filaEscrita[11], 250);
    assert.equal(filaEscrita[12], 30);
    assert.equal(filaEscrita[13], 'Central');
    assert.equal(filaEscrita[14], 'clave-1');
    assert.deepEqual(Array.from(filaEscrita.slice(15)), ['', '', '', '']);
});
