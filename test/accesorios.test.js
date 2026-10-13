'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcularVenta } = require('../src/money');

test('los accesorios suman al total y a la ganancia, y la comisión los incluye', () => {
  const r = calcularVenta({
    costoUsd: 10,
    tipo: 'UNIDAD',
    cantidad: 1,
    tipoCambio: 10,
    precioManualBs: 200,
    tasaComision: 0.3,
    accesorios: [
      { nombre: 'vidrio', precioBs: 30, costoBs: 10 },
      { nombre: 'cargador', precioBs: 50, costoBs: 20 },
    ],
  });

  assert.equal(r.precioAccesoriosBs, 80);
  assert.equal(r.costoAccesoriosBs, 30);
  assert.equal(r.gananciaAccesoriosBs, 50);
  assert.equal(r.totalCobradoBs, 280);
  assert.equal(r.gananciaBs, 150);
  assert.equal(r.comisionBs, 45);
});

test('sin accesorios los números quedan igual que antes', () => {
  const argumentos = {
    costoUsd: 100,
    tipo: 'UNIDAD',
    cantidad: 1,
    tipoCambio: 10,
    precioManualBs: 200,
    tasaComision: 0.3,
  };
  const sinClave = calcularVenta(argumentos);
  const conListaVacia = calcularVenta({ ...argumentos, accesorios: [] });

  assert.equal(sinClave.precioAccesoriosBs, 0);
  assert.equal(sinClave.costoAccesoriosBs, 0);
  assert.equal(sinClave.gananciaAccesoriosBs, 0);
  assert.equal(conListaVacia.precioAccesoriosBs, 0);
  assert.equal(conListaVacia.costoAccesoriosBs, 0);
  assert.equal(conListaVacia.gananciaAccesoriosBs, 0);
  assert.equal(conListaVacia.totalCobradoBs, sinClave.totalCobradoBs);
  assert.equal(conListaVacia.gananciaBs, sinClave.gananciaBs);
  assert.equal(conListaVacia.comisionBs, sinClave.comisionBs);
});

test('accesorios con precio 0 no alteran el total', () => {
  const r = calcularVenta({
    costoUsd: 100,
    tipo: 'UNIDAD',
    cantidad: 1,
    tipoCambio: 10,
    precioManualBs: 200,
    tasaComision: 0.3,
    accesorios: [
      { nombre: 'funda', precioBs: 0, costoBs: 0 },
      { nombre: 'vidrio regalado', precioBs: 0, costoBs: 25 },
    ],
  });

  assert.equal(r.precioAccesoriosBs, 0);
  assert.equal(r.costoAccesoriosBs, 25);
  assert.equal(r.totalCobradoBs, 200);
});

test('si el accesorio se vende por debajo del costo la comision es 0, no negativa', () => {
  const r = calcularVenta({
    costoUsd: 8,
    tipo: 'UNIDAD',
    cantidad: 1,
    tipoCambio: 10,
    precioManualBs: 100,
    tasaComision: 0.3,
    accesorios: [{ nombre: 'cargador', precioBs: 10, costoBs: 50 }],
  });

  assert.ok(r.gananciaBs < 0);
  assert.equal(r.comisionBs, 0);
});

// Regresion: calcularVenta devuelve BOLIVIANOS, no centavos.
// Si esto cambia, cada venta se escribe en la hoja 100 veces inflada
// (Bs 22.540 se guardaria como Bs 2.254.000) y no lo detecta ningun otro test.
test('calcularVenta devuelve los importes en Bs, no en centavos', () => {
  const r = calcularVenta({
    costoUsd: 10,
    tipo: 'UNIDAD',
    cantidad: 1,
    tipoCambio: 10,
    precioManualBs: 200,
    tasaComision: 0.3,
  });

  assert.equal(r.precioUnitarioBs, 200);
  assert.equal(r.precioSugeridoBs, 100);
  assert.equal(r.costoUnitarioBs, 100);
  assert.equal(r.costoTotalBs, 100);
  assert.equal(r.totalCobradoBs, 200);
  assert.equal(r.gananciaBs, 100);
  assert.equal(r.comisionBs, 30);
});
