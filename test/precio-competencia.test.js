'use strict';

// El bug real: al cambiar rapido de modelo, la respuesta del modelo anterior
// puede llegar despues de la del nuevo y pisar el precio. El debounce de
// 250 ms no lo evita. Estas pruebas reproducen la carrera con la funcion real
// extraida de public/index.html; contra el codigo viejo fallan.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');

function cortar(desde, hasta) {
    const inicio = html.indexOf(desde);
    assert.notEqual(inicio, -1, 'public/index.html ya no tiene: ' + desde);
    const fin = html.indexOf(hasta, inicio + desde.length);
    assert.notEqual(fin, -1, 'no se pudo cerrar el bloque que empieza en: ' + desde);
    return html.slice(inicio, fin);
}

const fuente =
    cortar('        function normalizar(texto) {', '        // Código de tienda.') +
    cortar('        // ---------- PRECIO: TODO VIENE DEL SERVIDOR ----------', '        function leerAccesorios() {') +
    cortar('        function cuerpoVenta(conFoto) {', '        // ---------- REGISTRAR VENTA ----------');

function elemento(valor) {
    return {
        value: valor === undefined ? '' : valor,
        textContent: '',
        innerHTML: '',
        classList: { add() {}, remove() {} },
        querySelectorAll() {
            return [];
        },
    };
}

function montar() {
    const nodos = Object.create(null);
    const obtener = (id) => {
        if (!nodos[id]) nodos[id] = elemento();
        return nodos[id];
    };
    const pedidos = [];
    const contexto = {
        ESTADO: {
            productos: [],
            precioManual: false,
            costoManual: false,
            temporizador: null,
            previewSecuencia: 0,
            previewControlador: null,
            ultimoModeloConsultado: '',
        },
        $: obtener,
        fmt: (n) => Number(n || 0).toFixed(2),
        leerAccesorios: () => [],
        AbortController,
        clearTimeout: () => {},
        setTimeout: () => 0,
        api: (ruta, opciones) =>
            new Promise((resolve, reject) => {
                pedidos.push({ ruta, opciones, resolve, reject });
            }),
        console,
    };
    vm.runInNewContext(
        fuente + '\nthis.__estado = ESTADO; this.__pedirPreview = pedirPreview;',
        contexto,
        { filename: 'public/index.html' }
    );
    return { contexto, pedidos, nodos: obtener, estado: contexto.__estado };
}

function calculo(precio) {
    return {
        encontrado: true,
        enInventario: true,
        stock: 3,
        calculo: {
            totalCobradoBs: precio,
            gananciaBs: precio * 0.1,
            comisionBs: precio * 0.03,
            costoUnitarioBs: precio * 0.9,
            margenPct: 0,
            descuentoAplicadoPct: 0,
            precioUnitarioBs: precio,
            costoUsd: 25,
        },
    };
}

test('una respuesta vieja del preview no pisa el precio del modelo nuevo', async () => {
    const { contexto, pedidos, nodos, estado } = montar();

    nodos('ventaModelo').value = 'Modelo A';
    const pedidoA = contexto.__pedirPreview();
    assert.equal(pedidos.length, 1, 'el primer modelo debe disparar un pedido');

    nodos('ventaModelo').value = 'Modelo B';
    const pedidoB = contexto.__pedirPreview();
    assert.equal(pedidos.length, 2, 'el segundo modelo debe disparar otro pedido');
    assert.equal(estado.previewSecuencia, 2);

    // B responde primero: se pinta su precio.
    pedidos[1].resolve(calculo(200));
    await pedidoB;
    assert.equal(nodos('ventaPrecioCobrado').value, '200.00');

    // A responde tarde: tiene que ser descartada.
    pedidos[0].resolve(calculo(100));
    await pedidoA;
    assert.equal(
        nodos('ventaPrecioCobrado').value,
        '200.00',
        'la respuesta del modelo A no puede pisar el precio del B'
    );
    assert.equal(nodos('txtTotalCobrar').textContent, '200.00');
});

test('cada pedido de preview cancela el anterior', async () => {
    const { contexto, pedidos, nodos } = montar();

    nodos('ventaModelo').value = 'Modelo A';
    contexto.__pedirPreview();
    const primeraSenal = pedidos[0].opciones.signal;
    assert.ok(primeraSenal, 'el primer pedido debe llevar una senal de cancelacion');

    nodos('ventaModelo').value = 'Modelo B';
    contexto.__pedirPreview();
    assert.equal(primeraSenal.aborted, true, 'el pedido anterior debe quedar abortado');

    pedidos[1].resolve(calculo(150));
    await Promise.resolve();
    await Promise.resolve();
});

test('al cambiar de modelo se borra el precio manual del modelo anterior', async () => {
    const { contexto, pedidos, nodos, estado } = montar();

    nodos('ventaModelo').value = 'Modelo A';
    estado.ultimoModeloConsultado = 'modelo a';
    estado.precioManual = true;
    estado.costoManual = true;
    nodos('ventaPrecioCobrado').value = '999';
    nodos('ventaCostoUsd').value = '111';

    nodos('ventaModelo').value = 'Modelo B';
    const pedido = contexto.__pedirPreview();

    // Se limpia antes de esperar al servidor: no se puede cobrar el precio
    // tecleado para el modelo anterior.
    assert.equal(nodos('ventaPrecioCobrado').value, '');
    assert.equal(nodos('ventaCostoUsd').value, '');
    assert.equal(estado.precioManual, false);
    assert.equal(estado.costoManual, false);

    pedidos[0].resolve(calculo(300));
    await pedido;
    assert.equal(nodos('ventaPrecioCobrado').value, '300.00');
});

test('el cliente pide las respuestas sin cache del navegador', () => {
    assert.match(
        html,
        /if \(!config\.cache\) config\.cache = 'no-store';/,
        'api() debe forzar cache: no-store'
    );
});

test('el backend precalienta el inventario al arrancar y mide las consultas', () => {
    assert.match(server, /Inventario precalentado/, 'falta el precalentado al arrancar');
    assert.match(server, /inventory\s*\.listar\(\)/, 'el precalentado debe leer el inventario');
    assert.match(server, /Server-Timing/, 'faltan tiempos medibles en las respuestas');
});
