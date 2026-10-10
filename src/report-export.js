'use strict';

const formatoMoneda = new Intl.NumberFormat('es-BO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function escaparHtml(valor) {
    return String(valor === undefined || valor === null ? '' : valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function moneda(valor) {
    return formatoMoneda.format(Number(valor) || 0);
}

function fechaCorta(valor) {
    const fecha = String(valor || '').slice(0, 10);
    const partes = fecha.split('-');
    return partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : fecha;
}

function textoFiltros(filtros) {
    const desde = filtros && filtros.desde ? fechaCorta(filtros.desde) : 'Inicio';
    const hasta = filtros && filtros.hasta ? fechaCorta(filtros.hasta) : 'Hoy';
    const vendedor = filtros && filtros.vendedor ? filtros.vendedor : 'Todos';
    return { desde, hasta, vendedor };
}

function filasVentas(reporte) {
    return (reporte.ventas || []).map((venta) => `
        <tr>
            <td>${escaparHtml(fechaCorta(venta.fecha))}</td>
            <td>${escaparHtml(venta.vendedor)}</td>
            <td>${escaparHtml(venta.modelo)}</td>
            <td>${escaparHtml(venta.tipo)}</td>
            <td class="numero">${escaparHtml(venta.cantidad)}</td>
            <td class="numero">${moneda(venta.totalCobradoBs)}</td>
            <td class="numero">${moneda(venta.gananciaBs)}</td>
            <td class="numero">${moneda(venta.comisionBs)}</td>
        </tr>`).join('');
}

function construirReporteImprimible(reporte) {
    const filtros = textoFiltros(reporte.filtros);
    const resumen = reporte.resumen || {};
    const filas = filasVentas(reporte);
    return `<!doctype html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <title>Reporte de ventas</title>
    <style>
        @page { size: A4; margin: 14mm; }
        * { box-sizing: border-box; }
        body { color: #172033; font: 12px Arial, sans-serif; margin: 0; }
        h1 { font-size: 22px; margin: 0 0 5px; }
        h2 { font-size: 14px; margin: 22px 0 8px; }
        p { margin: 4px 0; }
        .encabezado { border-bottom: 2px solid #172033; padding-bottom: 12px; }
        .filtros { color: #4c566a; margin-top: 8px; }
        .resumen { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px; }
        .indicador { border: 1px solid #cbd2dc; padding: 9px; }
        .etiqueta { color: #5f6b7a; font-size: 10px; text-transform: uppercase; }
        .valor { font-size: 16px; font-weight: 700; margin-top: 4px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border-bottom: 1px solid #dce1e8; padding: 7px 5px; text-align: left; }
        th { background: #eef1f5; font-size: 10px; text-transform: uppercase; }
        .numero { text-align: right; white-space: nowrap; }
        .vacio { color: #5f6b7a; padding: 18px 0; }
        @media print { .sin-impresion { display: none; } }
    </style>
</head>
<body>
    <header class="encabezado">
        <h1>Reporte de ventas</h1>
        <p>Jhessel Tech Mobiles</p>
        <p class="filtros">Vendedor: <strong>${escaparHtml(filtros.vendedor)}</strong> · Periodo: <strong>${escaparHtml(filtros.desde)} al ${escaparHtml(filtros.hasta)}</strong></p>
    </header>
    <section class="resumen">
        <div class="indicador"><div class="etiqueta">Ventas totales</div><div class="valor">Bs ${moneda(resumen.totalVendidoBs)}</div></div>
        <div class="indicador"><div class="etiqueta">Ganancia</div><div class="valor">Bs ${moneda(resumen.totalGananciaBs)}</div></div>
        <div class="indicador"><div class="etiqueta">Comisiones</div><div class="valor">Bs ${moneda(resumen.totalComisionesBs)}</div></div>
        <div class="indicador"><div class="etiqueta">Unidades</div><div class="valor">${escaparHtml(resumen.unidades || 0)}</div></div>
        <div class="indicador"><div class="etiqueta">Ticket promedio</div><div class="valor">Bs ${moneda(resumen.ticketPromedioBs)}</div></div>
        <div class="indicador"><div class="etiqueta">Margen</div><div class="valor">${moneda(resumen.margenPct)}%</div></div>
    </section>
    <h2>Ventas registradas</h2>
    ${filas ? `<table><thead><tr><th>Fecha</th><th>Vendedor</th><th>Modelo</th><th>Tipo</th><th>Un.</th><th>Total Bs</th><th>Ganancia Bs</th><th>Comisión Bs</th></tr></thead><tbody>${filas}</tbody></table>` : '<p class="vacio">No hay ventas para los filtros seleccionados.</p>'}
</body>
</html>`;
}

function construirReporteTermico(reporte) {
    const filtros = textoFiltros(reporte.filtros);
    const resumen = reporte.resumen || {};
    const ventas = (reporte.ventas || []).map((venta) => `
        <article class="venta">
            <div class="fila fuerte"><span>${escaparHtml(venta.modelo)}</span><span>Bs ${moneda(venta.totalCobradoBs)}</span></div>
            <div class="fila"><span>${escaparHtml(venta.vendedor)} · ${escaparHtml(fechaCorta(venta.fecha))}</span><span>${escaparHtml(venta.cantidad)} u.</span></div>
        </article>`).join('');
    return `<!doctype html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <title>Reporte térmico</title>
    <style>
        @page{size:50mm 50mm;margin:0}
        *{box-sizing:border-box}
        html,body{margin:0;padding:0;width:50mm;background:#fff;color:#000}
        body{font:8pt/1.2 Arial,sans-serif;padding:2mm}
        h1{font-size:11pt;text-align:center;margin:0 0 1.5mm}
        p{margin:0 0 1mm;text-align:center}
        .filtros{border-bottom:1px dashed #000;border-top:1px dashed #000;padding:1mm 0;margin-bottom:1mm}
        .resumen{border-bottom:1px dashed #000;padding-bottom:1mm;margin-bottom:1mm}
        .fila{display:flex;justify-content:space-between;gap:2mm}
        .fuerte{font-weight:700}
        .venta{border-bottom:1px dotted #777;padding:1mm 0}
        .total{font-size:10pt;font-weight:700;border-top:1px solid #000;margin-top:1mm;padding-top:1mm}
        .vacio{text-align:center;padding:3mm 0}
    </style>
</head>
<body>
    <h1>Jhessel Tech Mobiles</h1>
    <p>REPORTE DE VENTAS</p>
    <div class="filtros">${escaparHtml(filtros.vendedor)}<br>${escaparHtml(filtros.desde)} - ${escaparHtml(filtros.hasta)}</div>
    <div class="resumen">
        <div class="fila"><span>Unidades</span><span>${escaparHtml(resumen.unidades || 0)}</span></div>
        <div class="fila total"><span>TOTAL</span><span>Bs ${moneda(resumen.totalVendidoBs)}</span></div>
    </div>
    ${ventas || '<div class="vacio">Sin ventas</div>'}
</body>
</html>`;
}

const api = { construirReporteImprimible, construirReporteTermico };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ReporteExportacion = api;
