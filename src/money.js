'use strict';

function toCents(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function fromCents(centavos) {
  return Math.round(centavos) / 100;
}

function normalizarTipo(tipo) {
  return String(tipo || '').trim().toUpperCase().startsWith('MAYOR') ? 'MAYOR' : 'UNIDAD';
}

function parseTramos(texto) {
  if (!texto) return [];
  return String(texto)
    .split(',')
    .map((trozo) => {
      const partes = String(trozo).split(':');
      if (partes.length < 2) return null;
      const desde = Number(partes[0]);
      const pct = Number(partes[1]);
      if (!Number.isFinite(desde) || !Number.isFinite(pct) || desde <= 0 || pct < 0) return null;
      return { desde: Math.floor(desde), pct };
    })
    .filter(Boolean)
    .sort((a, b) => a.desde - b.desde);
}

function descuentoPara(tipo, cantidad, opciones = {}) {
  const descuentoMayorPct = Number(opciones.descuentoMayorPct) || 0;
  const tramosMayor = opciones.tramosMayor || [];
  if (normalizarTipo(tipo) !== 'MAYOR') return { pct: 0, tramo: null };
  let elegido = null;
  for (const tramo of tramosMayor) {
    if (cantidad >= tramo.desde) elegido = tramo;
  }
  if (elegido) return { pct: elegido.pct, tramo: elegido.desde + '+ un.' };
  return { pct: descuentoMayorPct, tramo: null };
}

function calcularVenta(opciones = {}) {
  const {
    costoUsd = 0,
    tipo = 'UNIDAD',
    cantidad = 1,
    tipoCambio = 0,
    precioManualBs = null,
    tasaComision = 0.3,
    descuentoMayorPct = 0,
    tramosMayor = [],
    accesorios: accesoriosRecibidos = [],
  } = opciones;

  const cant = Math.max(1, Math.floor(Number(cantidad) || 0));
  const tcNum = Number(tipoCambio);
  const tc = Number.isFinite(tcNum) && tcNum > 0 ? tcNum : 0;

  const costoNum = Number(costoUsd);
  const costo = Number.isFinite(costoNum) && costoNum >= 0 ? costoNum : 0;

  const costoUnitarioCents = toCents(costo * tc);

  const { pct, tramo } = descuentoPara(tipo, cant, { descuentoMayorPct, tramosMayor });
  let factor = 1 - pct / 100;
  if (factor < 0) factor = 0;

  const sugeridoCents = Math.round(costoUnitarioCents * factor);

  const manualNum = Number(precioManualBs);
  const hayManual =
    precioManualBs !== null &&
    precioManualBs !== undefined &&
    precioManualBs !== '' &&
    Number.isFinite(manualNum) &&
    manualNum > 0;

  const precioUnitarioCents = hayManual ? toCents(manualNum) : sugeridoCents;

  const totalCobradoCents = precioUnitarioCents * cant;
  const accesorios = Array.isArray(accesoriosRecibidos) ? accesoriosRecibidos : [];
  let precioAccesoriosCents = 0;
  let costoAccesoriosCents = 0;

  for (const accesorio of accesorios) {
    if (!accesorio || !String(accesorio.nombre || '').trim()) continue;
    precioAccesoriosCents += toCents(accesorio.precioBs);
    costoAccesoriosCents += toCents(accesorio.costoBs);
  }

  const totalConAccesoriosCents = totalCobradoCents + precioAccesoriosCents;
  const costoTotalCents = costoUnitarioCents * cant + costoAccesoriosCents;
  const gananciaAccesoriosCents = precioAccesoriosCents - costoAccesoriosCents;
  const gananciaCents = totalConAccesoriosCents - costoTotalCents;

  const tasaNum = Number(tasaComision);
  const tasa = Number.isFinite(tasaNum) && tasaNum >= 0 ? tasaNum : 0;
  const comisionCents = gananciaCents > 0 ? Math.round(gananciaCents * tasa) : 0;

  return {
    cantidad: cant,
    tipo: normalizarTipo(tipo),
    tipoCambio: tc,
    costoUsd: costo,
    descuentoAplicadoPct: hayManual ? 0 : pct,
    tramoDescuento: hayManual ? null : tramo,
    fuentePrecio: hayManual ? 'MANUAL' : 'CALCULADO',
    precioUnitarioBs: fromCents(precioUnitarioCents),
    precioSugeridoBs: fromCents(sugeridoCents),
    costoUnitarioBs: fromCents(costoUnitarioCents),
    costoTotalBs: fromCents(costoTotalCents),
    totalCobradoBs: fromCents(totalConAccesoriosCents),
    gananciaBs: fromCents(gananciaCents),
    comisionBs: fromCents(comisionCents),
    precioAccesoriosBs: fromCents(precioAccesoriosCents),
    costoAccesoriosBs: fromCents(costoAccesoriosCents),
    gananciaAccesoriosBs: fromCents(gananciaAccesoriosCents),
    margenPct:
      totalConAccesoriosCents > 0
        ? Math.round((gananciaCents / totalConAccesoriosCents) * 10000) / 100
        : 0,
  };
}

module.exports = {
  toCents,
  fromCents,
  normalizarTipo,
  parseTramos,
  descuentoPara,
  calcularVenta,
};
