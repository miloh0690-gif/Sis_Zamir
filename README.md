# Jhsel Tech Mobiles - Sis Jhessel v2

Sistema de ventas para "Jhsel Tech Mobiles". El dinero se calcula en el **servidor**, no en el navegador.

## Estructura

```
Sis_Jhessel/
├── .env.example              Plantilla de variables
├── .gitignore                Ignora .env, node_modules y data/
├── package.json
├── server.js                 Servidor Express: rutas /api/*
├── scripts/hash-pin.js       Genera el hash del PIN
├── src/
│   ├── money.js              Motor de precios en centavos
│   ├── inventory.js          Cliente de Google Sheets con cache
│   ├── ledger.js             Historial de ventas y resumen
│   ├── auth.js               PIN con scrypt + sesiones HMAC
│   └── ai.js                 Ficha tecnica con Gemini + rate limit
├── public/index.html         La interfaz (cliente delgado)
└── apps-script/
    ├── Code.gs               Apps Script corregido (pegar en script.google.com)
    └── appsscript.json       Manifiesto (solo si usas clasp)
```

## Desarollo local

```bash
npm install
cp .env.example .env
npm run hash-pin -- 1234
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run dev
```

## Variables de entorno

| Variable | Para que sirve |
| --- | --- |
| `SHEETS_WEBAPP_URL` | URL `/exec` de tu Web App. **No se publica en la web**, solo la usa Render. |
| `SHEETS_API_KEY` | Secreto compartido con Apps Script. Sin esto no hay inventario. |
| `ADMIN_PIN_HASH` | Hash scrypt del PIN. El PIN en si mismo nunca se guarda. |
| `SESSION_SECRET` | Firma las cookies de sesion. Minimo 16 caracteres. |
| `TASA_COMISION` | Comision del vendedor sobre la ganancia. `0.30` = 30%. |
| `DESCUENTO_MAYOR_PCT` | Descuento mayorista plano. `5` = 5%. |
| `MAYOR_TIERS` | Tramos por volumen: `3:8,6:12`. Tiene prioridad sobre el plano. |
| `REPORTES_DESDE_SHEETS` | `1` para que el historial viva en tu Sheet y no en el disco de Render. |
| `GROQ_API_KEY` | Llave de Groq. **Solo en Render.** Sin esto no hay argumentos de venta, pero la ficha tecnica sigue funcionando. |
| `GROQ_MODEL` | Por defecto `openai/gpt-oss-120b`. Ojo: la capacidad gratuita es del modelo, no de la cuenta. |
| `AI_RATE_LIMIT_POR_MIN` | Consultas de IA por minuto y por IP. |
| `FICHAS_POR_IA` | `0` apaga las fichas redactadas por IA y vuelve a decir "no hay ficha verificada". |
| `GITHUB_TOKEN` | Opcional. Solo lo necesita `npm run indexar`. |

> [!IMPORTANT]
> `REPORTES_DESDE_SHEETS=1` **exige el `Code.gs` version 3** en el Apps
> Script. Con la version 2 el reporte de ventas sale VACIO: el lector
> pedia que la columna "Tipo" fuera exactamente `VENTA`, pero ahi va
> `UNIDAD` o `MAYOR`, y descartaba todas las filas. Verifica con
> `/api/diagnostico` que diga `version 3` antes de prenderlo.

---

## Puesta en marcha del Apps Script

El archivo correcto es **`apps-script/Code.gs`**. Pega su contenido completo en tu proyecto de Apps Script, reemplazando lo anterior.

**Orden de los pasos:**

1. **Genera la clave compartida.** En el editor de Apps Script, agrega una funcion vacia `generarClaveCompartida()`, ejecuta una vez, y copia el valor del log. Es largo y aleatorio.

2. **Guarda la propiedad.** `Configuracion del proyecto` -> `Propiedades del script` -> `Agregar propiedad`:
   - Nombre: `SHEETS_API_KEY`
   - Valor: la clave del paso 1

3. **Borra `generarClaveCompartida()`** del script.

4. **Despliega.** `Implementar` -> `Nueva implementacion`:
   - Tipo: aplicacion web
   - Ejecutar como: **Yo**
   - Quien tiene acceso: **Cualquier persona**

   Cada vez que cambies el codigo tienes que volver a desplegar. Editar el script no cambia la version que se ejecuta.

5. **Copia la URL `/exec`** que te da Render al terminar.

6. **En Render**, `Environment`, agrega las dos variables:
   ```
   SHEETS_WEBAPP_URL = https://script.google.com/macros/s/AKfy.../exec
   SHEETS_API_KEY    = (la misma clave del paso 1)
   ```

7. **Prueba** entrando a `https://sis-zamir.onrender.com/api/health`. Debe decir `"sheetsUrl":true,"sheetsClave":true`.

8. **Confirma que corre la version que creés.** `https://sis-zamir.onrender.com/api/diagnostico` responde `Code.gs desplegado, version N`. Si dice `version 2`, tenés la version vieja pegada: el reporte de ventas y la idempotencia no funcionan.

9. **La hoja "Ventas" se completa sola.** No hace falta agregar columnas a mano: al primer deploy, el script agrega `ClaveIdempotencia` al final si no existe. Vas a ver el cambio en el registro de ejecuciones.

---

## Idempotencia: por que no se cobra dos veces

Deshabilitar el boton "Cobrar" no protege el dinero. Render free se duerme
tras inactividad y la primera peticion del dia tarda mas de 20 segundos. Si
la peticion expira despues de que el servidor ya escribio en la hoja, y el
vendedor toca el boton otra vez, se registraban **dos ventas y se
descontaba el stock dos veces**.

Ahora el navegador manda una `claveIdempotencia` por intento de cobro, y la
**reutiliza** si reintenta. Hay dos capas:

1. **En memoria, en Render.** La clave se recuerda 30 minutos. Un reintento
   devuelve la respuesta original sin tocar la hoja.
2. **En la hoja.** La clave queda escrita en la columna
   `ClaveIdempotencia`. Antes de descontar stock, el script la busca: si ya
   esta, responde "ya registrada" y no duplica. Esta capa cubre que el
   servidor de Render reinicie entre el intento y el reintento.

Lo mismo aplica a las consignaciones, que tambien mueven stock. Ahi la
clave viaja en la columna `Id`.

> [!NOTE]
> La clave se genera **una vez por intento**. Cuando la venta si se
> registro, el navegador genera una nueva para el siguiente cobro. Si
> borras la clave a mano, la proteccion se pierde para esa venta.

---

## Bugs corregidos (y donde estaban)

### En el precio

La version 1 calculaba en el navegador. Se rompia por cinco caminos distintos:

1. `forzarAutofillYRecalcular()` ponia `dataset.manual = "false"` en cada tecla del campo de modelo: **te borraba el precio tecleado a mano**.
2. `actualizarPreciosVenta()` hacia `if (!productoSelected) return;`. Si el modelo no coincidia exacto, **no recalculaba** y los tres indicadores seguian mostrando los numeros del modelo anterior.
3. `registrarVenta()` mandaba a Sheets las variables cacheadas, no un recalculo.
4. "Mayor" no tenia ninguna regla de precio.
5. La ganancia se calculaba sobre el precio unitario ya redondeado y el total no se redondeaba: se acumulaba error en centavos.

**Ahora** todo el dinero se calcula en `src/money.js` con **enteros en centavos**. El navegador solo muestra lo que responde `POST /api/ventas/preview`, y al guardar el servidor **recalcula desde cero** aunque alguien manipule el JS.

### En el Apps Script (los que acabas de pegar)

1. **La ganancia restaba dolares de bolivianos.** Era `totalCobrado - (costoUsd * cantidad)`: multiplicaba dolares por unidades y no multiplicaba por el tipo de cambio. Con un costo de 100 USD a 11,75 daba una ganancia de ~-13.000 en vez de ~0.
2. **La comision nunca se guardaba.** La hoja "Ventas" tenia 7 columnas y no incluia comision, asi que los reportes de comisiones salian en 0.
3. **No existian consultas de reporte.** El historial era de solo escritura: no habia forma de leerlo de vuelta.
4. **No habia validacion de stock.** El script ponia 0 si el stock daba negativo, con lo cual se vendian equipos inexistentes.
5. **Las consignaciones contaminaban el reporte de ventas.** Iban mezcladas en la hoja "Ventas" con ganancia 0. Ahora viven en su propia hoja, con id, y el reporte las ignora.
6. **`leerVentas()` no devolvia NINGUNA venta.** Para separar las ventas de las consignaciones descartaba toda fila cuya columna "Tipo" no fuera exactamente `VENTA`. Pero ahi va `UNIDAD` o `MAYOR` (lo produce `normalizarTipo` en `src/money.js`), nunca `VENTA`. O sea que descartaba el 100% de las filas y el reporte salia vacio. Ese filtro era un resto de cuando las consignaciones vivian en la misma hoja. Ahora acepta `VENTA`, `UNIDAD` y `MAYOR`, y **las columnas se buscan por encabezado en vez de por posicion**, asi que agregar o reordenar columnas ya no rompe la lectura.
7. **No habia idempotencia.** Un doble toque o un reintento tras un timeout cobraba dos veces y descontava stock dos veces. Ver la seccion de arriba.
8. **La hoja no se actualizaba sola.** Si le faltaba una columna, `registrarVenta` la escribia en una columna sin nombre y la lectura por nombre no la encontraba. Ahora `asegurarEncabezados()` agrega la que falta al desplegar.

### En el contrato entre backend y Apps Script

1. **Apps Script no puede leer headers HTTP.** Dentro de `doGet(e)` solo existen `parameter` y `postData`. Por eso la clave compartida viaja en `?key=` en las lecturas y en el campo `apiKey` del cuerpo JSON en las escrituras.
2. **Se elimino el login con token de sesion del script.** El unico cliente es Render, que ya autentica con su propio PIN y cookie firmada. El token de Apps Script dependia de `CacheService`, que puede evictar la sesion y romper la lectura de inventario de forma aleatoria.
3. **`inventory.escribir` daba por buena cualquier respuesta.** Apps Script devuelve HTTP 200 incluso cuando rechaza la operacion, con `{status:"ERROR"}` adentro. Antes eso se ignoraba y la app le decia "venta registrada" al usuario aunque la hoja nunca se hubiera tocado. Ahora `src/inventory.js` lo detecta y devuelve 409.

### En la autenticacion del cliente

- El PIN estaba en el HTML como `PIN_SECRETO = "1234"`. Cualquiera que abriera devtools entraba a Dueño y Reportes.
- `enviarANube()` usaba `mode: 'no-cors'`, que devuelve una respuesta opaca. `sincronizado` **siempre daba `true`**: si Sheets fallaba, el stock local bajaba igual sin avisar.

### El boton de ficha tecnica

La v1 llamaba a `gemini-1.5-flash` desde el navegador, que esta **apagado** desde 2025, y con la llave metida en un HTML publico. Ademas, desde junio de 2026 Google rechaza llaves sin restriccion de proyecto.

La v2 usa `gemini-3.5-flash`, pide respuesta estructurada con `responseSchema` (por eso ya no hay que parsear texto libre), guarda la llave en Render, cachea 6 horas por modelo y limita a 6 consultas por minuto y por IP.

---

## Lo que quedo fuera y por que

- **La lista de consignaciones no pide PIN.** Es el mismo comportamiento que la v1. Si quieres que solo el dueño vea los nombres de los clientes, se agrega `auth.exigirAuth` a `GET /api/consignaciones`.
- **`costoUsd` se oculta en las respuestas publicas.** Es defensa en profundidad, no una barrera real: los precios calculados ya revelan el margen.
- **El rate limit de escritura es por IP (60/min).** Si un vendedor cambia de IP, puede evadirlo.
- **La clave compartida viaja en la query string** de las lecturas, asi que aparece en los logs de ejecucion de Google. Se acepto ese coste porque Apps Script no da otra forma de leer un secreto.
- **Render free se duerme tras inactividad.** Con `REPORTES_DESDE_SHEETS=1` no se pierden datos, pero la primera peticion del dia va a ser lenta.

## Aviso de seguridad

Este repositorio es **publico**. En su historial hubo dos llaves de API de Gemini en texto plano (una en el `index.html` viejo, otra en un `.env.example` de un commit posterior). Ambas hay que considerarlas quemadas y rotarlas en [AI Studio](https://aistudio.google.com/apikey). Borrar el archivo no borra la llave de los commits: hay que rotarla.