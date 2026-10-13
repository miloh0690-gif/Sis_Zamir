# Nota de ventas, accesorios y foto de la nota a mano — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada venta registre a quién se le vendió, una nota de texto libre, los accesorios con su precio y costo en Bs, y una foto de la nota escrita a mano; y que el Dueño vea todo eso en Reportes, con la foto clicable.

**Architecture:** Google Sheets sigue siendo la única base de datos. La hoja `Ventas` gana 6 columnas que el propio Apps Script agrega solo al final (nadie las agrega a mano). La foto no va a la hoja: se guarda en Google Drive desde `Code.gs` y lo que se escribe en la hoja es la URL. Todo el dinero se calcula en el servidor, en centavos enteros, incluyendo la comisión sobre la ganancia de los accesorios.

**Tech Stack:** Node 26 · Express 4 · Google Apps Script (V8) · Google Drive API vía `DriveApp` · Google Sheets · Tailwind CDN (sin build). Cero dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-12-nota-de-ventas-accesorios-foto-design.md` — leela antes de empezar; este plan implementa esa spec y ambos viajan juntos.

## Global Constraints

- **Dinero en centavos enteros, siempre calculado en el servidor.** El navegador nunca calcula ganancia ni comisión.
- **Toda columna nueva se escribe POR NOMBRE**, nunca por posición. `registrarVenta` ya lo hace así (`appendRow` armado con `porNombre` sobre la cabecera real de la hoja).
- **La hoja NO se toca a mano.** `asegurarEncabezados()` agrega al final lo que falta. Las 15 columnas actuales no se reordenan. `filaCorrida()` (que lee posiciones 0..11 de las filas viejas) no se modifica.
- **`TotalCobrado` (col 5) y `GananciaEquipo` (col 6) de la hoja Ventas no se tocan y no se inventan.** El script sigue escribiendo `""` en lo que no conoce.
- **Regla de oro: la venta nunca se pierde por culpa de la foto.** Si la foto falla (formato, tamaño, permisos, sin internet), la venta con sus accesorios se guarda igual, la columna `Foto` queda vacía y el fallo queda registrado.
- **Orden en `Code.gs`: idempotencia → foto → fila.** Si la venta ya existe, se devuelve y **no** se sube foto. Si la fila falla después de subir la foto, queda un archivo huérfano en Drive (invisible y tolerable); al revés quedaría una venta visible sin foto, que es justo lo que el Dueño debe poder verificar.
- **Idempotencia en dos capas, no la rompas:** memoria en Render (30 min) + columna `ClaveIdempotencia` de la hoja. `REPORTE_DESDE_SHEETS=1` ⇒ `ledger.registrarVenta()` NO persiste; la fila la escribe Apps Script.
- **Recortes, no rechazos:** texto 500 caracteres, nombre de accesorio 300 caracteres. Se recortan y la venta se guarda.
- **Prohibido agregar dependencias.** `package.json` se queda con `dotenv` y `express`.
- **Commits en español, imperativo, sin prefijo** (`Agrega ...`, `Deja ...`), como el resto del historial. **Commiteá solo los archivos de cada tarea**: `.gitignore` (modificado) y `package-lock.json` (sin trackear) ya estaban así antes de esta tarea y no son tuyos.
- **No toques ni borres** `~/OpenCut` ni `~/opencut-app`.

## Review Focus

Cinco formas de entrada o fallo que la spec describe pero que ningún test del código existente ejercita, en orden de probabilidad de morder a alguien:

1. **Reintento con la misma `claveIdempotencia`.** Si el POST se reintenta, no se debe subir una segunda copia de la foto a Drive: son archivos huérfanos que el Dueño nunca va a saber limpiar. *(Task 4)*
2. **Foto que falla en Drive** (permisos sin reautorizar, base64 corrupto, prefijo raro). Lo razonable es que la venta con celular y accesorios se guarde igual y solo falte la foto. Perder la venta es lo inaceptable. *(Task 4)*
3. **Las 8 ventas viejas**, escritas antes de que existieran estas columnas. `leerVentas()` tiene que devolver los campos nuevos vacíos (`""`), nunca `undefined`, porque `renderVentas()` los pinta en pantalla y un `undefined` aparece como la palabra "undefined". *(Task 3)*
4. **Texto que empieza con `=`, `+`, `-` o `@`** en `Cliente`, `Nota` o el nombre de un accesorio. Sin sanear, Google Sheets lo interpreta como fórmula y puede disparar un error o leer datos de otra celda. El `.gs` ya tiene un saneador de fórmulas; reusalo. *(Task 3)*
5. **Accesorios con precio 0, o con costo mayor que el precio.** La comisión no puede salir negativa ni inventar ganancia: con ganancia ≤ 0 la comisión es 0, como ya hace `calcularVenta` con el celular. *(Task 1)*

---

### Task 1: El dinero de los accesorios

**Files:**
- Modify: `src/money.js` (`calcularVenta`)
- Test: `test/accesorios.test.js` (crear)

**Interfaces:**
- Consumes: nada. Es la base de la que dependen las Tasks 2, 5 y 6.
- Produces: `money.calcularVenta(opciones)` acepta `opciones.accesorios: [{ nombre: string, precioBs: number, costoBs: number }]` (Bs, no centavos; opcional, por defecto `[]`) y devuelve, además de lo que ya devuelve hoy, `precioAccesoriosBs: number`, `costoAccesoriosBs: number` y `gananciaAccesoriosBs: number`, **los tres en centavos enteros**. Los campos que ya existen (`totalCobradoBs`, `costoTotalBs`, `gananciaBs`, `comisionBs`) ya incluyen los accesorios.

- [ ] **Step 1: Escribí el test que falla**

`test/accesorios.test.js`, con `require('../src/money')` (ese módulo exporta por `module.exports`, línea 110). Cuatro casos, con `tasaComision: 0.3`:

```js
test('los accesorios suman al total y a la ganancia, y la comisión los incluye', () => {
    const r = calcularVenta({
        costoUsd: 100, tipo: 'UNIDAD', cantidad: 1, tipoCambio: 10,
        precioManualBs: 200, tasaComision: 0.3,
        accesorios: [
            { nombre: 'vidrio', precioBs: 30, costoBs: 10 },
            { nombre: 'cargador', precioBs: 50, costoBs: 20 },
        ],
    });
    assert.equal(r.precioAccesoriosBs, 8000);      // 80 Bs
    assert.equal(r.costoAccesoriosBs, 3000);       // 30 Bs
    assert.equal(r.gananciaAccesoriosBs, 5000);    // 50 Bs
    assert.equal(r.totalCobradoBs, 28000);         // 200 + 80
    assert.equal(r.gananciaBs, 15000);             // 280 - 130
    assert.equal(r.comisionBs, 4500);              // 30% de 150
});

test('sin accesorios los números quedan igual que antes', () => {
    // mismos argumentos, sin `accesorios`: los tres campos nuevos valen 0
    // y totalCobradoBs / gananciaBs / comisionBs coinciden con el caso sin
    // la clave `accesorios`. Es el test que protege las ventas de hoy.
});

test('accesorios con precio 0 no alteran el total', () => {
    // un accesorio de precioBs: 0, costoBs: 0 y otro con precioBs: 0,
    // costoBs: 25 → precioAccesoriosBs 0, costoAccesoriosBs 2500
});

test('si el accesorio se vende por debajo del costo la comision es 0, no negativa', () => {
    // celular: precio 100 Bs, costo 80 Bs (ganancia 20 Bs) y un accesorio
    // de precio 10 Bs con costo 50 Bs → ganancia total NEGATIVA
    // assert.equal(r.comisionBs, 0);
});
```

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/accesorios.test.js
```
Expected: FAIL — `precioAccesoriosBs` es `undefined` en los cuatro casos.

- [ ] **Step 3: Implementá los accesorios en `calcularVenta`**

En `src/money.js`, dentro de `calcularVenta`:

1. Leé `opciones.accesorios` con `Array.isArray() ? opciones.accesorios : []`.
2. Recorré la lista **ignorando** los ítems cuyo `nombre` esté vacío y usando `toCents()` sobre `precioBs` y `costoBs` (los helpers de centavos ya existen en el archivo; usalos, no escribas aritmética con flotantes).
3. Sumá en dos acumuladores: `precioAccesoriosCents` y `costoAccesoriosCents`.
4. Sumá `precioAccesoriosCents` al total y sumá `gananciaAccesoriosCents` (= precio − costo de los accesorios) a la ganancia, **antes** de calcular la comisión. La comisión se sigue calculando sobre la ganancia total, así que no hay que cambiar su fórmula: sale gratis.
5. Agregá al `return` los tres campos en centavos.

Cuidado con el orden: si sumás la ganancia de los accesorios después de calcular la comisión, la comisión queda vieja. Es el error más fácil de cometer acá.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/accesorios.test.js && npm test
```
Expected: los 4 PASS y la suite completa en verde (8 tests previos + 4 nuevos = 12).

- [ ] **Step 5: Commit**

```bash
git add src/money.js test/accesorios.test.js
git commit -m "Suma los accesorios al total, la ganancia y la comision de la venta"
```

---

### Task 2: Los campos nuevos en la lectura del historial

**Files:**
- Modify: `src/ledger.js` (`normalizarVenta`)
- Test: `test/nota-venta.test.js` (crear)

**Interfaces:**
- Consumes: nada de Tasks anteriores (los nombres de columna están fijados acá y los reusan las Tasks 3, 5 y 6).
- Produces: `ledger.normalizarVenta(fila)` devuelve, además de lo actual, `cliente: string`, `nota: string`, `accesorios: string`, `accesoriosBs: number`, `accesoriosCostoBs: number`, `foto: string`. Los tres de texto **nunca** son `undefined`: si la columna no existe o la celda está vacía, son `""`. Los dos de dinero son **centavos enteros**, `0` si no hay valor.

- [ ] **Step 1: Escribí el test que falla**

`test/nota-venta.test.js`, con `require('../src/ledger')` (exporta por `module.exports`, línea 284). Cinco casos:

```js
test('lee cliente, nota, accesorios y foto de la fila', () => {
    const v = normalizarVenta({ fecha: '2026-10-12', vendedor: 'Carlos', modelo: 'X1',
        tipo: 'UNIDAD', cantidad: 1, tipoCambio: 11.75,
        precioUnitarioBs: 200, costoTotalBs: 130, totalCobradoBs: 280,
        gananciaBs: 150, comisionBs: 45, sucursal: 'Central',
        cliente: 'Doña María', nota: 'se le regaló un vidrio',
        accesorios: 'vidrio, cargador', accesoriosBs: 80,
        accesoriosCostoBs: 30, foto: 'https://drive.google.com/uc?export=view&id=ABC' });
    assert.equal(v.cliente, 'Doña María');
    assert.equal(v.accesoriosBs, 8000);   // el .gs manda Bs, ledger guarda centavos
});

test('las ventas viejas devuelven strings vacios, nunca undefined', () => {
    // fila sin ninguna de las 6 claves → cliente/nota/accesorios/foto === ''
    // y accesoriosBs/accesoriosCostoBs === 0
});

test('un valor de dinero no numérico se vuelve 0 y no rompe la venta', () => {
    // accessoriesBs: 'no sé' → 0
});

test('el texto conserva acentos y mayúsculas tal cual', () => {
    // nota: 'Se le regaló un VIDRIO' → se devuelve idéntico, sin normalizar
});

test('los alias viejos siguen funcionando', () => {
    // una fila con los nombres viejos (precioUnitario, costoTotal,
    // totalCobrado, gananciaRegistrada, comision) sigue normalizándose igual
    // que antes de este cambio
});
```

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/nota-venta.test.js
```
Expected: FAIL en los casos 1, 2 y 3.

- [ ] **Step 3: Ampliá `normalizarVenta`**

En `src/ledger.js`:

1. Leé los 6 campos nuevos de la fila con el mismo criterio tolerante que ya usan los campos viejos: si un campo no viene, `""` o `0`, nunca `undefined` ni una excepción.
2. Para `accesoriosBs` y `accesoriosCostoBs`: `Number(...)`, y si no es un número finito, `0`. Después pasalos por el helper de centavos que ya usa el archivo para los otros importes, así la fila que llega en **Bs** desde la hoja queda en **centavos** como todos los demás.
3. Devolvé los 6 campos nuevos en el objeto, siempre presentes.

Ojo: el `.gs` escribe la fila en **Bs** (con decimales), igual que las columnas de dinero que ya existen. La conversión a centavos ocurre una sola vez, acá. No la dupliques en el `server.js` de la Task 5.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/nota-venta.test.js && npm test
```
Expected: los 5 PASS y la suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.js test/nota-venta.test.js
git commit -m "Lee cliente, nota, accesorios y foto de la fila de ventas"
```

---

### Task 3: Las 6 columnas en la hoja (escribir y leer)

**Files:**
- Modify: `apps-script/Code.gs` (`ENCABEZADO_VENTAS`, `registrarVenta`, `leerVentas`, la línea `version: 3` de la línea 164)
- Test: `test/hoja-ventas.test.js` (crear)

**Interfaces:**
- Consumes: los nombres de campo de la Task 2 (`cliente`, `nota`, `accesorios`, `accesoriosBs`, `accesoriosCostoBs`, `foto`).
- Produces: `Code.gs` expone en su ámbito global `textoCelda(valor) -> string` (sanitiza fórmulas y recorta a 500 caracteres) y `textoAccesorios(lista) -> string` (arma `"vidrio, cargador"` desde `[{nombre, precioBs, costoBs}]`, nombres recortados a 300 caracteres, omitiendo los vacíos). `leerVentas()` devuelve los 6 campos nuevos. `version` pasa a **4**.
- **Mapeo exacto de `porNombre` en `registrarVenta`** (fijalo así, es el contrato con el servidor): `Cliente ← data.cliente`, `Nota ← data.nota`, `Accesorios ← data.accesoriosTexto`, `AccesoriosBs ← calculo.precioAccesoriosBs`, `AccesoriosCostoBs ← calculo.costoAccesoriosBs`, `Foto ← data.fotoUrl`.

- [ ] **Step 1: Escribí el test que falla**

`test/hoja-ventas.test.js`. `Code.gs` se carga en un sandbox como ya hace `test/manual-sale.test.js`:

```js
const code = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');
const ctx = {};
vm.runInNewContext(code, ctx, { filename: 'Code.gs' });
```

Siete casos:

```js
test('las 6 columnas nuevas estan en ENCABEZADO_VENTAS', () => {
    ['Cliente', 'Nota', 'Accesorios', 'AccesoriosBs', 'AccesoriosCostoBs', 'Foto']
        .forEach((n) => assert.ok(ctx.ENCABEZADO_VENTAS.includes(n), n));
});

test('el version declarado es 4', () => {
    // ctx.version === 4  (o leerlo del contexto si queda exportado)
});

test('textoCelda sanea una formula de Sheets', () => {
    assert.equal(ctx.textoCelda('=IMPORTXML("http://x","//a")')[0], "'");
});

test('textoCelda recorta a 500 caracteres', () => {
    assert.equal(ctx.textoCelda('x'.repeat(900)).length, 500);
});

test('textoCelda convierte null y undefined en cadena vacia', () => {
    assert.equal(ctx.textoCelda(null), '');
    assert.equal(ctx.textoCelda(undefined), '');
});

test('textoAccesorios arma la lista y omite los vacios', () => {
    assert.equal(ctx.textoAccesorios([{ nombre: 'vidrio' }, { nombre: '' }, { nombre: 'cargador' }]),
        'vidrio, cargador');
});

test('registrarVenta escribe las columnas nuevas por nombre', () => {
    // stub de hoja con getLastColumn() 15, fila de encabezado de 15 columnas
    // que NO incluye las nuevas, y appendRow capturando el array.
    //Al llamar registrarVenta con cliente/nota/accesorios, el array de 15
    // debe traer los valores en la posición que corresponde al NOMBRE
    //(las 6 columnas que la hoja todavía no tiene van como "").
    // Y registrarVenta NO debe escribir por posición 0.
});
```

El caso 7 es el que protege la trampa más cara del proyecto: la hoja real tiene 15 columnas en otro orden y la Fecha **no es la primera**. Que el test lo fixe con una cabecera de 15 columnas *diferente* del orden del script.

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/hoja-ventas.test.js
```
Expected: FAIL — faltan las columnas, `textoCelda` y `textoAccesorios` no existen, y `version` es 3.

- [ ] **Step 3: Las 6 columnas y el saneado**

En `apps-script/Code.gs`:

1. Agregá `"Cliente", "Nota", "Accesorios", "AccesoriosBs", "AccesoriosCostoBs", "Foto"` **al final** de `ENCABEZADO_VENTAS`. `asegurarEncabezados()` las agrega solas a la hoja en el próximo despliegue; no escribas código para crear columnas.
2. Implementá `textoCelda(valor)`: `String(valor == null ? '' : valor)`, trim, prefijo `'` si empieza con `=`, `+`, `-` o `@`, recorte a 500. Reusá el criterio del saneador de fórmulas que el archivo ya tiene; si no existe uno reutilizable, extraelo a esta función y dejá que lasllamadas anteriores usen `textoCelda`.
3. Implementá `textoAccesorios(lista)`: `lista` es un array de `{nombre}`; `nombre` con `textoCelda`-like trim + recorte a 300; filtra vacíos; `join(', ')`.
4. En `registrarVenta`, agregá las 6 claves a `porNombre`. Para `Cliente`, `Nota` y `Accesorios` usá `textoCelda`. Para `AccesoriosBs` y `AccesoriosCostoBs` usá **exactamente la misma conversión** que hoy se le aplica a `PrecioUnitarioBs` en esa función (el `calculo` ya trae los importes en Bs; no inventes un segundo formato). Para `Foto`, la URL que le llegue o `""`.
5. En `leerVentas`, buscá las 6 columnas con `columna(cab, "Cliente", -1)` y devolvé `""` o `0` cuando `columna` devuelva `-1`. Ampliá el shape de retorno; no cambies los 12 campos que ya devuelve.
6. Subí `version: 3` → `version: 4`.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/hoja-ventas.test.js && npm test
```
Expected: los 7 PASS y la suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs test/hoja-ventas.test.js
git commit -m "Agrega cliente, nota, accesorios y foto a la hoja de ventas"
```

---

### Task 4: La foto en Google Drive

**Files:**
- Modify: `apps-script/Code.gs` (`doPost`, funciones nuevas de Drive)
- Test: `test/foto-drive.test.js` (crear)

**Interfaces:**
- Consumes: `textoCelda` de la Task 3; `ENCABEZADO_VENTAS` con la columna `Foto`; `filaYaRegistrada` y el lock que ya existen en `doPost`.
- Produces: `guardarFotoEnDrive(datos, ss) -> string` devuelve la URL `https://drive.google.com/uc?export=view&id=<ID>` o `""` si no vino foto, si el formato no sirve o si falla. `carpetaFotos(ss) -> string` devuelve el id de la carpeta de Drive, creándola **como hermana de la hoja** la primera vez y recordándolo en las Propiedades del Script bajo `ID_CARPETA_FOTOS`. `decodificarFoto(base64) -> { bytes: string[], nombre: string } | null` acepta solo `data:image/jpeg` y `data:image/png`, recorta a 1.5 MB y devuelve `null` ante cualquier otra cosa.

- [ ] **Step 1: Escribí el test que falla**

`test/foto-drive.test.js`, con el mismo `vm.runInNewContext` y **stubs** de `DriveApp`, `PropertiesService`, `LockService`, `SpreadsheetApp`, `Logger` y `UrlFetchApp` en el contexto. Siete casos:

```js
test('decodificarFoto acepta JPEG y PNG', () => {
    assert.ok(ctx.decodificarFoto('data:image/jpeg;base64,' + Buffer.from('x').toString('base64')));
    assert.ok(ctx.decodificarFoto('data:image/png;base64,' + Buffer.from('x').toString('base64')));
});

test('decodificarFoto rechaza lo que no es imagen', () => {
    // 'data:text/plain;base64,...', 'data:application/pdf;...',
    // una cadena sin prefijo data:, '' y null → todos null
});

test('decodificarFoto recorta a 1.5 MB', () => {
    // base64 de 3 MB → null
});

test('carpetaFotos crea la carpeta hermana de la hoja la primera vez', () => {
    // PropertyService sin ID_CARPETA_FOTOS → DriveApp.createFolder llamado
    // con la hoja como padre, el id devuelto guardado y reutilizado
});

test('guardarFotoEnDrive devuelve la URL y comparte con cualquiera que tenga el link', () => {
    // el stub de createFile devuelve un id; se comparte con
    // Sharing.ANYONE_WITH_LINK y VIEW; el resultado es
    // 'https://drive.google.com/uc?export=view&id=<ID>'
});

test('guardarFotoEnDrive devuelve "" si no viene foto, sin tocar Drive', () => {
    // datos.fotoBase64 ausente → '' y ningun createFile
});

test('si Drive falla la foto se pierde pero no la venta', () => {
    // createFile tira excepcion → guardarFotoEnDrive devuelve '' y
    // NO re-lanza (no puede romper la venta); el error queda en Logger
});

test('una venta duplicada NO sube una segunda foto a Drive', () => {
    // doPost con una claveIdempotencia que filaYaRegistrada reporta ya
    // existente: la respuesta es la duplicada, ningun createFile se llama,
    // y la venta sigue registrada como estaba
});
```

Este último caso es el que protege contra la fuga silenciosa de archivos huérfanos: sin él, un reintento por timeout deja una copia de cada foto en Drive y nadie se entera.

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/foto-drive.test.js
```
Expected: FAIL — las tres funciones no existen.

- [ ] **Step 3: Implementá el guardado en Drive**

En `apps-script/Code.gs`:

1. `decodificarFoto(base64)`: validá el prefijo con `/^data:image\/(jpeg|png);base64,/i`; decodificá a bytes; si el total supera 1.5 MB devolvé `null`; armá el nombre `nota-venta-<timestamp>.<jpg|png>`.
2. `carpetaFotos(ss)`: leé `ID_CARPETA_FOTOS` de Propiedades del Script; si está vacío, `DriveApp.getFileById(ss.getId()).getParentFolder()` y `createFolder('Fotos de ventas', padre)`, guardá el id en Propiedades y devuelvelo. Si `getParentFolder()` falla, usá `DriveApp.getRootFolder()` como padre antes de rendirte.
3. `guardarFotoEnDrive(datos, ss)`: si no hay `datos.fotoBase64` devolvé `""`; si `decodificarFoto` devuelve `null`, logueá el motivo y devolvé `""`; si no, creá el archivo con `DriveApp.createFile(Utilities.newBlob(bytes, mime, nombre))` en la carpeta, compartilo con `ANYONE_WITH_LINK, VIEW` y devolvé la URL `uc?export=view&id=`. **Envolvé todo en `try/catch`: cualquier excepción se loguea y devuelve `""`. Nunca re-lanzar.**
4. En `doPost`, en el caso `VENTA`, después de `filaYaRegistrada(...)` y **antes** de `registrarVenta(...)`: si la respuesta fue duplicada, saltea este bloque y devolvé como hoy; si no, `data.fotoUrl = guardarFotoEnDrive(data, ss)`. Pasale ese valor a `registrarVenta` para la clave `Foto`.

El orden importa y es el motivo de dos de los tests: la foto se sube **después** del chequeo de idempotencia (para no duplicar archivos en un reintento) y **antes** de escribir la fila.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/foto-drive.test.js && npm test
```
Expected: los 7 PASS y la suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs test/foto-drive.test.js
git commit -m "Guarda la foto de la nota de ventas en Drive y escribe su link en la hoja"
```

---

### Task 5: El servidor acepta y reenvía los campos nuevos

**Files:**
- Modify: `server.js` (línea 24, `construirCalculo` línea 210, `POST /api/ventas` línea 382)
- Test: `test/ventas-campos.test.js` (crear)

**Interfaces:**
- Consumes: `money.calcularVenta` con `accesorios` (Task 1) y los nombres de columna de la Task 2.
- Produces: `POST /api/ventas` acepta en el cuerpo `cliente: string`, `nota: string`, `accesorios: [{nombre, precioBs, costoBs}]`, `fotoBase64: string` (data URL), todos opcionales, y manda a `inventory.escribir` los campos `cliente`, `nota`, `accesoriosTexto`, `precioAccesoriosBs`, `costoAccesoriosBs`, `fotoUrl`. `construirCalculo(producto, cuerpo)` sigue teniendo la misma firma.

- [ ] **Step 1: Escribí el test que falla**

`test/ventas-campos.test.js`. `server.js` no exporta la app (llama `app.listen` al cargarse), así que se usa el patrón de `test/cache-headers.test.js`: **extraer el código fuente** con `fs.readFileSync` + `indexOf` y evaluarlo en un `vm` con stubs. Tres casos:

```js
test('el limite del cuerpo alcanza para una foto de 1.5 MB', () => {
    // extraer 'app.use(express.json(' del fuente y comprobar que el limite
    // NO es '32kb' y que su valor numérico supera 1.6 MB.
    // Si el limite queda por debajo, el servidor rebota la venta con foto
    // con 'request entity too large' y la foto nunca llega a Drive.
});

test('construirCalculo pasa los accesorios a money.calcularVenta', () => {
    // extraer 'function construirCalculo' del fuente, correrlo en un vm con
    // un stub de money y un stub de entero/decimal, y comprobar que el
    // objeto que recibe calcularVenta trae `accesorios` con precioBs/costoBs
    // ya como números, y [] cuando el cuerpo no trae la clave
});

test('el payload a inventory.escribir lleva los campos nuevos', () => {
    // extraer el bloque de POST /api/ventas del fuente y comprobar que el
    // objeto que se manda a inventory.escribir incluye cliente, nota,
    // accesoriosTexto, precioAccesoriosBs, costoAccesoriosBs y fotoUrl
});
```

Los tres leen el fuente, no ejecutan el servidor. Es el patrón que ya usa el repo; no introduzcas supertest ni otra dependencia.

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/ventas-campos.test.js
```
Expected: FAIL en los tres.

- [ ] **Step 3: Cambios en `server.js`**

1. **Línea 24:** `app.use(express.json({ limit: '32kb' }))` → `limit: '2mb'`. Con el valor actual, cualquier venta con foto rebota antes de llegar a Apps Script. Es el bug más probable de esta tarea y el más difícil de ver sin probarlo.
2. En `construirCalculo`, pasale a `money.calcularVenta` un `accesorios` ya normalizado: `Array.isArray(c.accesorios) ? c.accesorios.map(a => ({ nombre: String(a.nombre || ''), precioBs: Number(a.precioBs) || 0, costoBs: Number(a.costoBs) || 0 })) : []`.
3. En `POST /api/ventas`: agregá al objeto `registro` y al `inventory.escribir({...})` los campos `cliente`, `nota`, `accesoriosTexto` (llamá a `textoAccesorios`-equivalente: acá es Node, así que armalo con un `map` + `join(', ')` sobre los nombres no vacíos, recortados a 300), `precioAccesoriosBs` y `costoAccesoriosBs` (los que devuelve `calculo`, ya en centavos) y `fotoUrl` (lo que el `.gs` resuelva; mandalo como `undefined` y que el `.gs` lo resuelva, no lo inventes en Node).
4. **No** agregues validación que rechace la venta: `cliente`, `nota`, `accesorios` y `fotoBase64` son opcionales. Lo único que debe seguir rechazando es lo que ya rechaza (`precioUnitarioBs > 0`).
5. El `fotoBase64` viaja tal cual en el cuerpo. No lo guardes en memoria ni lo registres en logs.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/ventas-campos.test.js && npm test
```
Expected: los 3 PASS y la suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add server.js test/ventas-campos.test.js
git commit -m "Acepta cliente, nota, accesorios y foto en el registro de venta"
```

---

### Task 6: El formulario del vendedor

**Files:**
- Modify: `public/index.html` (`#formVenta`, `cuerpoVenta()`, `registrarVenta()`, `#detallePrecio`)
- Test: `test/interfaz-venta.test.js` (crear)

**Interfaces:**
- Consumes: los nombres del cuerpo que acepta `POST /api/ventas` (Task 5) y el shape que devuelve `money.calcularVenta` (Task 1).
- Produces: `#clienteVenta`, `#notaVenta`, `#listaAccesorios` con filas `[nombre | precioBs | costoBs]` y botón `#btnAgregarAccesorio`, `#btnTomarFoto` + `#miniaturaFoto` + `#btnQuitarFoto`, `#txtAccesoriosTotal`. `cuerpoVenta()` incluye `cliente`, `nota`, `accesorios` y `fotoBase64`.

- [ ] **Step 1: Escribí el test que falla**

`test/interfaz-venta.test.js`, leyendo `public/index.html` como texto (patrón de `test/vercel-config.test.js`) y con `node:test` para el JS. Seis casos:

```js
test('el formulario tiene los 4 bloques nuevos', () => {
    ['clienteVenta', 'notaVenta', 'listaAccesorios', 'btnAgregarAccesorio',
     'btnTomarFoto', 'miniaturaFoto', 'btnQuitarFoto'].forEach((id) =>
        assert.ok(html.includes(`id="${id}"`), id));
});

test('la nota tiene el ejemplo que pidio el cliente', () => {
    // placeholder que contenga 'regal' y 'vidrio'
});

test('cuerpoVenta manda los 4 campos nuevos', () => {
    // assert sobre el texto que contiene
    // 'cliente:', 'nota:', 'accesorios:' y 'fotoBase64:'
});

test('los 6 scripts inline siguen siendo JavaScript valido', () => {
    // extraer cada <script> sin src con un regex y compilarlo con
    // new Function(src) — si el JS tiene un error de sintaxis, esto falla
});

test('la foto se redimensiona a 1200 px y se convierte en JPEG', () => {
    // el fuente contiene el ancho maximo 1200 y el tipo image/jpeg
});

test('el total de accesorios se suma en el detalle de precio', () => {
    // pedirPreview manda `accesorios` al preview, y el total que se muestra
    // en #detallePrecio incluye los accesorios
});
```

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/interfaz-venta.test.js
```
Expected: FAIL — no existe ninguno de los ids nuevos.

- [ ] **Step 3: La interfaz**

En `public/index.html`, dentro de `#formVenta`, después de `#ventaPrecioCobrado` y antes de `#btnRegistrarVenta`:

1. **Cliente**: un `<input id="clienteVenta">`, sin `required`, placeholder `"Ej: Doña María"`.
2. **Nota**: un `<textarea id="notaVenta">` de una línea, placeholder `"Ej: se le regaló un vidrio"`.
3. **Accesorios**: botón `#btnAgregarAccesorio` (`+ Agregar`), contenedor `#listaAccesorios` donde cada fila es `[input nombre | input precio Bs | input costo Bs | botón Quitar]`, y `#txtAccesoriosTotal` con la suma de los precios. Todo opcional.
4. **Foto**: `#btnTomarFoto` (`Tomar foto`), `#miniaturaFoto` (img oculta) y `#btnQuitarFoto`. Al elegir la foto, leerla con `FileReader`, dibujarla en un `<canvas>`, escalar a **máximo 1200 px de ancho** conservando la proporción, y exportar con `canvas.toDataURL('image/jpeg', 0.7)`. Ese data URL es `ESTADO.fotoBase64`. Si la foto es más alta que ancha, el límite se aplica al lado mayor. Guardá el `ESTADO.fotoBase64` en una variable, no en un input oculto.
5. `cuerpoVenta()` suma `cliente: valorDe('clienteVenta'), nota: valorDe('notaVenta'), accesorios: leerAccesorios(), fotoBase64: ESTADO.fotoBase64 || null`.
6. `pedirPreview()` debe recargar el preview cuando cambian los precios de los accesorios, para que `#detallePrecio` muestre el total y la ganancia ya con los accesorios incluidos.
7. Tras un cobro exitoso, **limpiá también los campos nuevos** (cliente, nota, filas de accesorios, foto y `ESTADO.fotoBase64`), junto con los que ya se limpian. Sin esto, el siguiente cobro hereda la nota del anterior.
8. Todo texto dinámico que venga del usuario y se pinte en pantalla pasa por `escapeHtml()`, como ya hace el resto del archivo. El tema es el oscuro existente: bordes `#2A2F3A`, acentos `#4C8DFF` y `#34D399`, tipografías `font-display` y `font-data`.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/interfaz-venta.test.js && npm test
```
Expected: los 6 PASS y la suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/interfaz-venta.test.js
git commit -m "Agrega cliente, nota, accesorios y foto al formulario de venta"
```

---

### Task 7: El Dueño ve la nota y la foto en Reportes

**Files:**
- Modify: `public/index.html` (`renderVentas`)
- Test: `test/interfaz-reportes.test.js` (crear)

**Interfaces:**
- Consumes: el shape que devuelve `ledger.normalizarVenta` (Task 2), que `/api/reportes` ya reenvía sin cambios.
- Produces: `renderVentas(ventas)` pinta por venta la línea de cliente, la nota, los accesorios y una miniatura de 80 px que abre la foto en pestaña nueva.

- [ ] **Step 1: Escribí el test que falla**

`test/interfaz-reportes.test.js`, leyendo `public/index.html` como texto. Cuatro casos:

```js
test('renderVentas pinta cliente, nota y accesorios', () => {
    // el cuerpo de renderVentas menciona cliente, nota y accesorios
});

test('la foto se muestra como miniatura de 80 px', () => {
    // el fuente contiene 80px junto al tag de la miniatura
});

test('la miniatura abre la foto en pestana nueva con seguridad', () => {
    // target="_blank" y rel="noopener" juntos
});

test('una venta sin foto ni nota no rompe el render', () => {
    // renderVentas debe decidir por el valor, no asumir que las claves
    // existen: el fuente protege los 6 campos con un chequeo de valor
    // (|| '') antes de pintar
});
```

- [ ] **Step 2: Corré el test y verificá que falla**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/interfaz-reportes.test.js
```
Expected: FAIL.

- [ ] **Step 3: Mostrar la evidencia**

En `renderVentas` (`public/index.html`), debajo de la línea que ya pinta modelo, cantidad y fecha:

1. Si `cliente` tiene valor, una línea `→ {cliente}`.
2. Si `nota` tiene valor, una línea con la nota, en el acento `#FBBF24` para que destaque como información aparte.
3. Si `accesorios` tiene valor, una línea `Accesorios: {accesorios} — Bs {accesoriosBs}`.
4. Si `foto` tiene valor, una `<img>` de 80 px con `target="_blank"` y `rel="noopener"` que apunte a la URL. Si no hay foto, **no** muestres un ícono de imagen roto: la venta es válida sin foto.

Los cuatro bloques usan `|| ''` antes de pintar, porque las ventas viejas llegan con los campos vacíos.

**No** agregues estado de revisión, ni checkbox de "revisada", ni nada que el Dueño tenga que marcar: la spec lo dejó explícitamente fuera de alcance.

- [ ] **Step 4: Corré el test y verificá que pasa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
node --test test/interfaz-reportes.test.js && npm test
```
Expected: los 4 PASS y la suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/interfaz-reportes.test.js
git commit -m "Muestra cliente, nota, accesorios y la foto en los reportes"
```

---

### Task 8: Publicar y entregar

Este task no lleva TDD: verifica lo que ya está escrito y prepara el despliegue. **Nada de lo que sigue es opcional.**

**Files:**
- Deliver: `~/Documents/Obsidian Vault/01 Proyectos/Sis Zamir/Código/Code.gs v4 - nota de ventas y foto.gs` (crear, con otro nombre del v3 del 10-oct)
- Modify: `~/Documents/Obsidian Vault/01 Proyectos/Sis Zamir/Jhsel Tech Mobiles.md`
- Create: `~/Documents/Obsidian Vault/04 Sesiones/2026-10-12.md`

- [ ] **Step 1: Suite completa**

```bash
export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"
npm test
```
Expected: todos en verde (8 previos + 29 nuevos = 37).

- [ ] **Step 2: Subir a GitHub y verificar Render**

```bash
GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0 git push origin main
```
Después esperá el autoDeploy de Render y:

```bash
curl -s https://sis-zamir.onrender.com/api/diagnostico
```
Expected: los 4 pasos `ok:true`. El paso 3 **va a seguir diciendo `version 3`**: eso es correcto hasta que Milo pegue el `.gs` v4 y haga *Nueva versión*. No lo declares roto.

- [ ] **Step 3: Desplegar la interfaz en Vercel**

Vercel **no** está conectado a GitHub: se despliega con la CLI.

```bash
cd ~/Desktop/sis_zamir && npx vercel --prod --yes
```
Expected: URL de producción; verificá que `https://jhsel-tech-mobiles.vercel.app` sirva el `index.html` nuevo.

- [ ] **Step 4: Entregar el `Code.gs` v4 en el vault y explicarle los 3 pasos**

Copiá el `apps-script/Code.gs` al vault como **`Code.gs v4 - nota de ventas y foto.gs`** (nombre nuevo a propósito: el archivo que ya está ahí es el v3 del 10-oct, y confundir los dos es el error que ya le hizo dudar esta semana).

En el mensaje a Milo, estos 3 pasos y **nada más**:

1. En Apps Script: `Configuración del proyecto` → *Mostrar el manifiesto `appsscript.json`* → agregar `"https://www.googleapis.com/auth/drive"` en `oauthScopes` (Drive **completo**, no `drive.file`) → guardar → aceptar la reautorización.
2. Pegar el `Code.gs` v4 completo, reemplazando todo el contenido.
3. `Implementar` → *Administrar implementaciones* → `⋮` → **Nueva versión** → `Implementar`.

Y decirle explícitamente lo que **no** tiene que hacer: no agregar columnas a mano, no cambiar el orden de las existentes, no completar las ventas viejas, no tocar Render, no crear la carpeta de fotos a mano.

- [ ] **Step 5: Verificar el despliegue después de que Milo lo haga**

```bash
curl -s https://sis-zamir.onrender.com/api/diagnostico
```
Expected: el paso 3 dice **`version 4`**. Recién ahí la columna `Foto` se está escribiendo.

Y después: **una venta de prueba real**, con foto, y verificar que (a) la fila nueva tiene las 6 columnas llenas, (b) el archivo aparece en Drive junto a la hoja, (c) la miniatura se ve en Reportes. Una venta de prueba con un modelo cualquiera y precio 0 no sirve: `POST /api/ventas` exige `precioUnitarioBs > 0`.

- [ ] **Step 6: Registrar en el vault**

En `Jhsel Tech Mobiles.md`, agregá la **URL nueva del web app** que nunca había quedado anotada:

`https://script.google.com/macros/s/AKfycbygb4KkpiOuV6c91KSwsnt7M3FWJRmZ6uFwyUwMNTluwQZW0gSKi6qMH6NAXCP5U1DO2A/exec`

(no es secreto; lo que viaja en `?key=` y **no** se anota es `SHEETS_API_KEY`).

Creá `04 Sesiones/2026-10-12.md` con la nota de sesión, y en ella marcá **explícitamente** las tres categorías, que es la regla del AGENTS.md:

- **aplicado y verificado** (lo que confirmó un comando o una URL)
- **escrito pero sin aplicar** (el `.gs` v4 está en el vault hasta que Milo lo pegue; hasta ese momento `Foto` no se escribe)
- **sin verificar** (la venta de prueba con foto, si llega a hacerla)