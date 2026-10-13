'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');

function extraerHandlerVentas() {
    const inicio = source.indexOf("app.post('/api/ventas'");
    assert.notEqual(inicio, -1, 'server.js debe tener el handler de ventas');
    const fin = source.indexOf("\n});\n\napp.get('/api/consignaciones'", inicio);
    assert.notEqual(fin, -1, 'no se pudo cerrar el handler de ventas');
    return source.slice(inicio, fin + 3);
}

function extraerConstruirCalculo() {
    const inicio = source.indexOf('function construirCalculo(');
    assert.notEqual(inicio, -1, 'server.js debe tener construirCalculo');
    const fin = source.indexOf('\n}\n\napp.get(', inicio);
    assert.notEqual(fin, -1, 'no se pudo cerrar construirCalculo');
    return source.slice(inicio, fin + 2);
}

test('el body JSON de ventas acepta fotos de hasta 2mb', () => {
    assert.match(source, /express\.json\(\{\s*limit:\s*['"]2mb['"]/);
});

test('ventas manda los campos ampliados a inventory.escribir', () => {
    const handler = extraerHandlerVentas();
    for (const campo of [
        'cliente:',
        'nota:',
        'accesoriosTexto:',
        'precioAccesoriosBs:',
        'costoAccesoriosBs:',
        'costoTotalBs:',
        'gananciaRegistrada:',
    ]) {
        assert.match(handler, new RegExp(`inventory\\.escribir\\([\\s\\S]*${campo}`));
    }
    assert.doesNotMatch(handler, /inventory\.escribir\([\s\S]*fotoUrl:/);
});

test('construirCalculo normaliza accesorios antes de llamar a money', () => {
    const funcion = extraerConstruirCalculo();
    const recibidos = [];
    const contexto = {
        money: {
            calcularVenta: (opciones) => {
                recibidos.push(opciones);
                return {};
            },
        },
        entero: (valor) => Number(valor),
        decimal: (valor) => Number(valor),
        TASA_COMISION: 0.3,
        DESCUENTO_MAYOR_PCT: 0,
        TRAMOS_MAYOR: [],
    };
    vm.runInNewContext(`${funcion}\nresultado = construirCalculo;`, contexto, { filename: 'server.js' });
    const construirCalculo = contexto.resultado;

    construirCalculo({}, {
        costoUsd: 10,
        tipo: 'contado',
        cantidad: 1,
        tipoCambio: 7,
        accesorios: [{ nombre: 'vidrio', precioBs: 80, costoBs: 30 }],
    });
    construirCalculo({}, { cantidad: 1, tipoCambio: 7 });

    assert.equal(
        JSON.stringify(recibidos[0].accesorios),
        JSON.stringify([{ nombre: 'vidrio', precioBs: 80, costoBs: 30 }]),
    );
    assert.equal(JSON.stringify(recibidos[1].accesorios), '[]');
});

test('ventas no rechaza por faltar cliente, nota, foto o accesorios', () => {
    const handler = extraerHandlerVentas();
    assert.doesNotMatch(handler, /status\((?:400|409)\)[^;\n]*(?:cliente|nota|foto|accesorios)/i);
});
