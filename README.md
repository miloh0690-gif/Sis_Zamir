# MooN ERP · Sis_Zamir v2

Sistema de ventas para「MooN Tech Mobiles」。Ahora con **backend propio en Render**：el dinero ya no se calcula en el navegador.

## Que cambio y por que

### El bug del "otro precio"

La version 1 calculaba los importes en el navegador. Eso rompia de tres formas:

1. Al escribir en el campo de modelo se llamaba `forzarAutofillYRecalcular()`, que ponia `dataset.manual = "false"`. **Cada tecla borraba el precio que habias tecleado a mano.**
2. `actualizarPreciosVenta()` hacia `if (!productoSelected) return;`. Si el modelo no coincidia exacto, **no recalculaba nada** y los tres indicadores seguian mostrando los numeros del modelo anterior.
3. `registrarVenta()` enviaba a Sheets las variables cacheadas `ultimoTotalCobrar` / `ultimaGananciaPura`, no un recalculo. Cualquier evento que no disparase el handler mandaba dinero viejo.
4. El selector «Mayor» no tenia ninguna regla de precio asociada.
5. La ganancia se calculaba sobre el precio unitario ya redondeado con `toFixed(2)` y el total no se redondeaba: el error se acumulaba en centavos.

**Ahora** todo el dinero se calcula en `src/money.js`, en el servidor, usando **enteros en centavos**. No hay flotantes en el camino critico, asi que el total siempre cuadra con `precioUnitario x cantidad` y `total - costo = ganancia`. El navegador solo muestra lo que el servidor responde (`POST /api/ventas/preview`) y al guardar el servidor **vuelve a calcular desde cero** aunque alguien manipule el JS.

### El boton de ficha tecnica

La v1 llamaba a `gemini-1.5-flash` desde el navegador. Eso estaba roto por partida doble:

- `gemini-1.5-flash` esta **apagado** desde 2025.
- La llave estaba **en el HTML de un repositorio publico**. Ademas, desde junio de 2026 Google rechaza llaves sin restriccion.

La v2 usa `gemini-3.5-flash` por defecto, pide respuesta estructurada con `responseSchema` (por eso ya no hay que parsear texto libre), guarda la llave en `.env`, cachea 6 horas por modelo y limita a 6 consultas por minuto y por IP.

### Los reportes

La v1 guardaba las ventas en `baseDeDatosVentas`, un array en memoria. Recargabas y todo era 0.00. Ademas la comision nunca se enviaba a Sheets, asi que no habia historico.

La v2 tiene un ledger (`src/ledger.js`) con dos motores:

| `REPORTES_DESDE_SHEETS` | Donde viven las ventas |
| --- | --- |
| `0` (por defecto) | `data/ventas.json` en el servidor. **Se pierde cuando Render reinicia la instancia.** |
| `1` | Tu Google Sheet, via el snippet `REPORTE_VENTAS` de mas abajo. Permanente. |

Los reportes ahora se filtran por fecha y vendedor, y se exportan a CSV.

## Estructura

```
Sis_Zamir/
├── .env.example          Plantilla de variables (copiala a .env)
├── .gitignore            Ignora .env, node_modules y data/
├── package.json
├── server.js             Servidor Express: rutas /api/*
├── scripts/hash-pin.js   Genera el hash del PIN
├── src/
│   ├── money.js          Motor de precios en centavos
│   ├── inventory.js      Cliente de Google Sheets con cache
│   ├── ledger.js         Historial de ventas y resumen
│   ├── auth.js           PIN con scrypt + sesiones HMAC
│   └── ai.js             Ficha tecnica con Gemini + rate limit
└── public/index.html     La interfaz (cliente delgado)
```

## Desarollo local

```bash
npm install
cp .env.example .env
npm run hash-pin -- 1234        # pega el resultado en ADMIN_PIN_HASH
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # SESSION_SECRET
npm run dev
```

## Variables de entorno

| Variable | Para que sirve |
| --- | --- |
| `SHEETS_WEBAPP_URL` | URL `/exec` de tu Web App de Apps Script. **Sin esto no hay inventario.** |
| `ADMIN_PIN_HASH` | Hash scrypt del PIN. El PIN en si mismo nunca se guarda. |
| `SESSION_SECRET` | Firma las cookies de sesion. Minimo 16 caracteres. |
| `TASA_COMISION` | Comision del vendedor sobre la ganancia. `0.30` = 30%. |
| `DESCUENTO_MAYOR_PCT` | Descuento mayorista plano. `5` = 5%. |
| `MAYOR_TIERS` | Tramos por volumen: `3:8,6:12` = 3+ un. 8%, 6+ un. 12%. Tiene prioridad sobre el plano. |
| `REPORTES_DESDE_SHEETS` | `1` para que el historial viva en tu Sheet. |
| `GEMINI_API_KEY` | Llave de Google AI Studio. Sin ella la ficha tecnica sale deshabilitada. |
| `GEMINI_MODEL` | Por defecto `gemini-3.5-flash`. |
| `AI_RATE_LIMIT_POR_MIN` | Consultas de IA por minuto y por IP. Por defecto 6. |

## Snippet para Apps Script

Pega esto en tu proyecto de Apps Script, **antes** del `return` final de `doPost`, para que el historial de ventas sea permanente:

```javascript
// ---- Historial de ventas (para REPORTES_DESDE_SHEETS=1) ----
const HOJA_VENTAS = 'Ventas';

function registrarVentaHistorica(d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(HOJA_VENTAS);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_VENTAS);
    hoja.appendRow([
      'Fecha', 'Vendedor', 'Modelo', 'Tipo', 'Cantidad', 'TC',
      'PrecioUnitarioBs', 'CostoTotalBs', 'TotalBs', 'GananciaBs', 'ComisionBs', 'FilaExcel'
    ]);
  }
  hoja.appendRow([
    d.fecha || new Date().toISOString(),
    d.vendedor || '', d.modelo || '', d.tipo || '', Number(d.cantidad) || 0,
    Number(d.tipoCambio) || 0, Number(d.precioUnitarioBs) || 0,
    Number(d.costoTotalBs) || 0, Number(d.totalCobrado) || 0,
    Number(d.gananciaRegistrada) || 0, Number(d.comision) || 0,
    d.filaExcel || ''
  ]);
}

function leerVentasHistoricas() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_VENTAS);
  if (!hoja) return [];
  var valores = hoja.getDataRange().getValues();
  var salida = [];
  for (var i = 1; i < valores.length; i++) {
    var f = valores[i];
    if (!f[0]) continue;
    salida.push({
      fecha: new Date(f[0]).toISOString(), vendedor: f[1], modelo: f[2],
      tipo: f[3], cantidad: Number(f[4]) || 0, tipoCambio: Number(f[5]) || 0,
      precioUnitarioBs: Number(f[6]) || 0, costoTotalBs: Number(f[7]) || 0,
      totalCobradoBs: Number(f[8]) || 0, gananciaBs: Number(f[9]) || 0,
      comisionBs: Number(f[10]) || 0, filaExcel: f[11]
    });
  }
  return salida;
}
```

Y en el `doPost`, dentro del bloque que ya manejas, agrega:

```javascript
if (data.tipoOperacion === 'VENTA') registrarVentaHistorica(data);
if (data.tipoOperacion === 'REPORTE_VENTAS') return leerVentasHistoricas();
```

La v2 tambien manda campos que tu script actual ignora (`precioUnitarioBs`, `comision`, `tipoCambio`). Son inocuos si tu script no los lee.

## Deploy en Render

El repositorio ya trae el servicio configurado. En Render > Environment agrega las variables de `.env.example`.

## Lo que quedo fuera y por que

- **La lista de consignaciones no pide PIN.** Es el mismo comportamiento que la v1. Si quieres que solo el dueño vea los nombres de los clientes, agrego un gate de `auth.exigirAuth` en `GET /api/consignaciones`.
- **`costoUsd` se oculta en las respuestas publicas.** Es defensa en profundidad, no una barrera real: los precios calculados ya revelan el margen.
- **No hay rate limit por usuario en las escrituras**, solo por IP (60/min). Si un vendedor cambia de IP varias veces, ese limite se evadia.
- **Render free reinicia la instancia tras inactividad** y se duerme. Con `REPORTES_DESDE_SHEETS=1` eso no afecta los datos, pero la primera peticion del dia va a ser lenta.