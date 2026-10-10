'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { construirReporteImprimible, construirReporteTermico } = require('../src/report-export');

const reporte = {
    filtros: { desde: '2026-10-01', hasta: '2026-10-05', vendedor: 'Ana' },
    resumen: {
        totalVendidoBs: 1200,
        totalGananciaBs: 240,
        totalComisionesBs: 48,
        unidades: 2,
        ticketPromedioBs: 600,
        margenPct: 20,
    },
    ventas: [{
        fecha: '2026-10-03T14:30:00.000Z',
        vendedor: 'Ana',
        modelo: 'iPhone 15',
        tipo: 'UNIDAD',
        cantidad: 2,
        totalCobradoBs: 1200,
        gananciaBs: 240,
        comisionBs: 48,
    }],
};

test('construye el PDF con los filtros, resumen y ventas del reporte', () => {
    const html = construirReporteImprimible(reporte);

    assert.match(html, /01\/10\/2026/);
    assert.match(html, /05\/10\/2026/);
    assert.match(html, /Ana/);
    assert.match(html, /Ventas totales/);
    assert.match(html, /iPhone 15/);
    assert.match(html, /1\.200,00/);
});

test('construye la impresión térmica con tamaño de página 50 mm', () => {
    const html = construirReporteTermico(reporte);

    assert.match(html, /@page\s*\{[^}]*size:\s*50mm\s+50mm/s);
    assert.match(html, /Ana/);
    assert.match(html, /iPhone 15/);
    assert.match(html, /TOTAL/);
});

test('publica el generador de reportes que carga la interfaz', () => {
    const archivoPublico = fs.readFileSync(require.resolve('../public/report-export.js'), 'utf8');

    assert.match(archivoPublico, /window\.ReporteExportacion/);
    assert.match(archivoPublico, /construirReporteImprimible/);
    assert.match(archivoPublico, /construirReporteTermico/);
});
