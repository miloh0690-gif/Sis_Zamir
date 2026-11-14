'use strict';

// El precio de un modelo depende de que el catalogo este en memoria. Estas
// pruebas fijan la regla: una escritura (venta, consignacion o reporte) NO
// puede obligar a releer los 258 productos, y un catalogo vencido se sirve
// igual mientras se refresca por detras.
//
// Antes de esto, escribir hacia limpiarCache(): el primer precio despues de
// cada venta costaba una lectura completa de la hoja (2-4 s medidos).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RUTA = path.resolve(__dirname, '../src/inventory.js');

// La configuracion se lee al cargar el modulo.
process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/PRUEBA/exec';
process.env.SHEETS_API_KEY = 'clave-de-prueba';
// 1 segundo: el minimo del modulo, para poder vencer el catalogo sin esperar
// los 15 minutos de produccion.
process.env.STOCK_CACHE_SEG = '1';

const CATALOGO = [
  { modelo: 'XIAOMI REDMI 13', sucursal: 'MODELOS', stock: 3, costoUsd: 100, filaExcel: 5 },
];

function cargar() {
  const resuelta = require.resolve(RUTA);
  delete require.cache[resuelta];
  return require(resuelta);
}

function respuestaHttp(cuerpo, estado) {
  return {
    status: estado === undefined ? 200 : estado,
    ok: (estado === undefined ? 200 : estado) < 400,
    text: async () => JSON.stringify(cuerpo),
  };
}

function esperar(ms) {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

function montarFetch(opciones) {
  const ajustes = opciones || {};
  const demora = ajustes.demoraMs || 0;
  const llamadas = { get: 0, post: 0 };

  globalThis.fetch = async (url, peticion) => {
    const metodo = (peticion && peticion.method) || 'GET';
    if (metodo === 'GET') {
      llamadas.get += 1;
      if (demora) await esperar(demora);
      if (ajustes.fallaLaRed) throw new Error('red caida');
      return respuestaHttp(CATALOGO);
    }
    llamadas.post += 1;
    return respuestaHttp({ status: 'OK', ok: true });
  };

  return llamadas;
}

test('sin catalogo previo la primera lectura espera a Google', async () => {
  const inventario = cargar();
  const llamadas = montarFetch();

  const lista = await inventario.listar();

  assert.equal(lista.length, 1);
  assert.equal(llamadas.get, 1);
});

test('una escritura no tira el catalogo: el precio sigue en memoria', async () => {
  const inventario = cargar();
  // Google tarda 300 ms en devolver el catalogo: si el precio esperara al
  // refresco, se notaria.
  const llamadas = montarFetch({ demoraMs: 300 });

  await inventario.listar();
  assert.equal(llamadas.get, 1);

  await inventario.escribir({ tipoOperacion: 'VENTA', modelo: 'XIAOMI REDMI 13' });
  assert.equal(llamadas.post, 1, 'la venta se escribe una vez');

  const inicio = Date.now();
  const lista = await inventario.listar();
  const tardo = Date.now() - inicio;

  assert.equal(lista.length, 1, 'sigue devolviendo el catalogo');
  assert.ok(tardo < 100, 'responde de memoria, no espera a Google (tardo ' + tardo + ' ms)');
});

test('un catalogo vencido responde al instante y se refresca por detras', async () => {
  const inventario = cargar();
  const llamadas = montarFetch({ demoraMs: 300 });

  await inventario.listar();
  await esperar(1100);

  const inicio = Date.now();
  const lista = await inventario.listar();
  const tardo = Date.now() - inicio;

  assert.equal(lista.length, 1, 'devuelve el catalogo que ya tenia');
  assert.ok(tardo < 100, 'no espera a Google para responder (tardo ' + tardo + ' ms)');
  assert.equal(llamadas.get, 2, 'el refresco arranca igual, en segundo plano');
});

test('si el refresco falla, el catalogo viejo sigue sirviendo', async () => {
  const inventario = cargar();
  montarFetch();

  await inventario.listar();
  await esperar(1100);
  montarFetch({ fallaLaRed: true });

  const lista = await inventario.listar();

  assert.equal(lista.length, 1, 'el mostrador no se queda sin precios porque Google falle');
  await esperar(80);
});

test('forzar sigue obligando a leer (lo usa el stock restante al cobrar)', async () => {
  const inventario = cargar();
  const llamadas = montarFetch();

  await inventario.listar();
  await inventario.listar({ forzar: true });

  assert.equal(llamadas.get, 2);
});

test('si nunca hubo catalogo, el fallo de Google se informa (no se silencia)', async () => {
  const inventario = cargar();
  montarFetch({ fallaLaRed: true });

  await assert.rejects(() => inventario.listar(), /Google Sheets/i);
});

test('si Google falla, no se reintenta en cada request', async () => {
  const inventario = cargar();
  montarFetch();

  await inventario.listar();
  await esperar(1100);
  const llamadas = montarFetch({ fallaLaRed: true });

  await inventario.listar();
  await esperar(50);
  await inventario.listar();
  await inventario.listar();
  await esperar(50);

  assert.equal(
    llamadas.get,
    1,
    'con Google caido, un refresco por request martillaria Apps Script'
  );
});

test('el cobro no paga una segunda lectura completa del catalogo', () => {
  // Medido: /api/ventas tardaba ~1,4 s solo por el listar({forzar:true}) que
  // recalculaba el stock restante. El catalogo ya tiene el stock: se descuenta
  // en memoria y el refresco de fondo corrige si hubo otra caja.
  const fs = require('node:fs');
  const servidor = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const inicio = servidor.indexOf("app.post('/api/ventas'");
  const fin = servidor.indexOf("app.get('/api/consignaciones'", inicio);
  assert.ok(inicio > -1 && fin > inicio, 'no se encontro el bloque de /api/ventas');
  const bloque = servidor.slice(inicio, fin);
  const relecturas = (bloque.match(/forzar:\s*true/g) || []).length;
  assert.equal(relecturas, 1, 'solo el camino de reintento puede releer el catalogo');
});

test('el buscador distingue coincidencia exacta de parcial', () => {
  const inventario = cargar();
  const lista = [
    { modelo: 'XIAOMI REDMI 15C', clave: 'xiaomi redmi 15c' },
    { modelo: 'SAMSUNG GALAXY A06', clave: 'samsung galaxy a06' },
  ];

  // El bug: "REDMI 15" resolvia al 15C, o sea precio, costo y stock de otro
  // equipo, sin decirlo. Ahora al menos se puede avisar.
  assert.equal(inventario.coincidenciaEn(lista, 'XIAOMI REDMI 15C'), 'exacta');
  assert.equal(inventario.coincidenciaEn(lista, 'xiaomi redmi 15'), 'parcial');
  assert.equal(inventario.coincidenciaEn(lista, 'IPHONE 15'), 'ninguna');
  assert.equal(inventario.coincidenciaEn(lista, ''), 'ninguna');
});
