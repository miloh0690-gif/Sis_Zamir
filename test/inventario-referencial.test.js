'use strict';

// El catalogo de la tienda no es un inventario: es una lista de precios y
// fichas de referencia. Estas pruebas fijan esa regla en los tres lugares
// donde el stock Todavia bloqueaba, para que nadie vuelva a poner el filtro.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const code = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');

// Cada endpoint se corta en la siguiente declaracion app.* para que el
// slice no se coma el resto del archivo.
function bloqueDelEndpoint(inicioMarca, finMarca) {
    const inicio = server.indexOf(inicioMarca);
    assert.notEqual(inicio, -1, 'server.js ya no tiene ' + inicioMarca);
    const fin = server.indexOf(finMarca, inicio + inicioMarca.length);
    assert.notEqual(fin, -1, 'no se pudo cerrar el bloque que empieza en ' + inicioMarca);
    return server.slice(inicio, fin);
}

const bloqueVenta = bloqueDelEndpoint(
    "app.post('/api/ventas'",
    "app.get('/api/consignaciones'"
);
const bloqueConsignacion = bloqueDelEndpoint(
    "app.post('/api/consignaciones'",
    "app.post('/api/consignaciones/estado'"
);

test('una venta no se rechaza por falta de stock, pero sigue exigiendo los datos obligatorios', () => {
    assert.doesNotMatch(
        bloqueVenta,
        /Stock insuficiente/,
        'el catalogo es referencial: quedarse sin unidades ya no bloquea la venta'
    );

    assert.match(bloqueVenta, /Ingresa el nombre del vendedor\./, 'el vendedor sigue siendo obligatorio');
    assert.match(bloqueVenta, /Ingresa o selecciona un modelo\./, 'el modelo sigue siendo obligatorio');
    assert.match(bloqueVenta, /La cantidad debe ser mayor a 0\./, 'la cantidad sigue siendo obligatoria');
    assert.match(bloqueVenta, /El tipo de cambio debe ser mayor a 0\./, 'el tipo de cambio sigue siendo obligatorio');
    assert.match(bloqueVenta, /El precio debe ser mayor a 0\./, 'el precio sigue siendo obligatorio');
});

test('una consignacion tampoco se rechaza por falta de stock', () => {
    assert.doesNotMatch(
        bloqueConsignacion,
        /Stock insuficiente/,
        'consignar un modelo con 0 unidades es valido'
    );

    assert.match(bloqueConsignacion, /Ingresa el responsable\./, 'el responsable sigue siendo obligatorio');
    assert.match(bloqueConsignacion, /Ese modelo no existe en el inventario\./,
        'el modelo sigue teniendo que existir en el catalogo');
});

test('validarOperacion acepta vender con 0 unidades en la hoja', () => {
    const contexto = {};
    vm.runInNewContext(code, contexto, { filename: 'Code.gs' });

    const hojaInventario = {
        getLastRow: () => 12,
        getRange: (fila, columna, filas, columnas) => ({
            getValues: () => [['XIAOMI REDMI 13', 'MODELOS', 0, 145]],
        }),
    };

    const resultado = contexto.validarOperacion(hojaInventario, {
        tipoOperacion: 'VENTA',
        modelo: 'XIAOMI REDMI 13',
        cantidad: 5,
        filaExcel: 5,
    });

    assert.equal(resultado.ok, true,
        'con 0 unidades en la hoja la venta tiene que pasar igual');
    assert.equal(resultado.filaData.stock, 0, 'sigue entregando el stock real de la fila');
    assert.equal(resultado.filaData.costoUsd, 145, 'sigue entregando el costo para el calculo');
});

test('el buscador de modelos muestra los que tienen 0 unidades', () => {
    assert.doesNotMatch(
        html,
        /p\.stock > 0 &&/,
        'con el filtro de stock el vendedor no encontraba los modelos agotados'
    );
    assert.match(html, /Stock registrado/, 'el numero se llama asi porque ya no es un limite de venta');
    assert.doesNotMatch(html, /'Stock: ' \+ datos\.stock/, 'el preview tambien dice stock registrado');
});