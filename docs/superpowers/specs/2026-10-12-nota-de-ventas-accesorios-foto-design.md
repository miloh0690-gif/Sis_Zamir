# Nota de ventas, accesorios y foto de la nota a mano

- **Fecha:** 2026-10-12
- **Cliente:** Jhsel Tech Mobiles (alias en pantalla y repo: "Jhessel")
- **Repo:** https://github.com/miloh0690-gif/Sis_Zamir
- **Estado:** diseño aprobado por el cliente (2026-10-12). Pendiente: plan de implementación.

## Qué pidió el cliente

1. Una nota de ventas en el área de ventas.
2. Poder registrar todo lo que vendió **un trabajador** en un solo reporte.
3. Añadir **a quién** se le vendió.
4. Un campo de nota libre, por ejemplo "se le regaló un vidrio".
5. Que el vendedor pueda **subir la foto de la nota de ventas que hizo a mano** para entregarle al cliente.
6. Que el jefe, al revisar las ventas, pueda ver la nota y la foto y verificar que fue así.

## Decisiones tomadas con el cliente

| # | Decisión |
|---|---|
| 1 | La foto se guarda en **Google Drive, vía Apps Script**. Sin cuentas nuevas, sin costos, y la foto viaja en la misma llamada que escribe la venta. Descartado: Supabase Storage, buckets externos, disco de Render. |
| 2 | La foto se **redimensiona en el navegador**: máximo 1200 px de ancho, JPEG calidad 70%, ~100-200 KB. |
| 3 | El jefe **solo ve** foto y nota. No hay columna de estado de revisión ni módulo de aprobación. |
| 4 | Hay **una nota y una foto por venta**. Además, una venta puede llevar **accesorios** (vidrio, cargador, estuche) con **precio en Bs**. |
| 5 | Los accesorios van **en la misma fila de la venta**, no en filas propias. |
| 6 | Los accesorios tienen **precio y costo**, para que la ganancia sea real. |
| 7 | La comisión del vendedor se calcula sobre la **ganancia total** (celular + accesorios). |
| 8 | `Cliente` y `Nota` son **opcionales**. `AccesoriosCostoBs` sí va. |
| 9 | La carpeta de fotos se crea como **carpeta hermana de la hoja**, porque la hoja la creó el dueño y el jefe ya tiene acceso a ella. El jefe ve las fotos desde Reportes. |

## Modelo de datos

Seis columnas nuevas en la hoja `Ventas`. Las agrega solas `asegurarEncabezados()` al final, así que la hoja pasa de 15 a 21 columnas sin intervención manual y sin mover las existentes.

| Columna | Qué guarda | Ejemplo |
|---|---|---|
| `Cliente` | a quién se le vendió | `María Fernández` |
| `Nota` | texto libre | `se le regaló un vidrio` |
| `Accesorios` | nombres de los accesorios, separados por coma | `vidrio, cargador, estuche` |
| `AccesoriosBs` | precio total de los accesorios | `180` |
| `AccesoriosCostoBs` | costo total de los accesorios | `95` |
| `Foto` | URL de la foto en Drive | `https://drive.google.com/...` |

### Reglas que ya no se rompen

- Toda columna se escribe **por nombre**, nunca por posición. La escritura posicional ya costó una vez: la hoja real tiene 15 columnas en otro orden que las 13 que el script conocía, y las ventas quedaron corridas (la Fecha caía en la columna Vendedor). Ese fix es el commit `8082839`.
- `filaCorrida()` solo mira las posiciones 0..11 de las filas viejas. Una columna nueva al final no lo afecta.
- **No se inventa** el significado de `TotalCobrado` (columna 5) ni de `GananciaEquipo` (columna 6) de la hoja real: el script no las llena y nadie sabe qué son. Se dejan como están.
- **La hoja no se toca a mano.** Precedente: el arreglo del 4 de octubre funcionó sin tocar la hoja.

### Cálculo del dinero (siempre en el servidor, en centavos enteros)

```
totalCobradoBs = (precioCelular × cantidad) + precioAccesorios
costoTotalBs   = (costoCelular  × cantidad) + costoAccesorios
gananciaBs     = totalCobradoBs − costoTotalBs
comisionBs     = round(gananciaBs × tasaComision)
```

La comisión ya incluye la ganancia de los accesorios, sin campos extra. Si la venta es de un celular con precio manual, el total y la ganancia no cambian respecto de hoy.

El navegador solo manda los dos números que escribe el vendedor (precio y costo de los accesorios). Nunca calcula dinero.

## El viaje de la foto

**En el navegador.** Un botón "Tomar foto" abre el selector de archivos con `capture` para que en el celular abra directo la cámara. La imagen se dibuja en un `<canvas>` a lo ancho máximo de 1200 px, se exporta como JPEG 70% y queda como base64 de ~180 KB. Una miniatura previa muestra lo que se va a subir, con un botón para quitarla. Sin librerías nuevas.

**En Render.** El base64 viaja dentro del mismo `POST /api/ventas` que ya existe. Hay que **subir el límite de `express.json()`**, que hoy está en el default de 100 KB: con la foto el body pasa a ~240 KB y rebotaría con *request entity too large*.

**En Apps Script.** En este orden exacto:

1. Lock de script (15 s) + `filaYaRegistrada(...)`. Si la venta ya existe, se devuelve `YA_REGISTRADA` con `duplicada: true` y **se salta el guardado de la foto**. Un reintento no deja archivos basura en Drive.
2. Guardar el base64 en Drive:
   - La carpeta se resuelve por `ID_CARPETA_FOTOS` en Propiedades del script.
   - Si no existe: `DriveApp.getFileById(ss.getId()).getParentFolder()` da la carpeta padre de la hoja (el script es *container-bound*: `doPost` usa `SpreadsheetApp.getActiveSpreadsheet()`), y ahí se crea `Fotos de ventas`. El ID se guarda en Propiedades para no recrearla.
   - Se valida que el base64 sea `data:image/jpeg` o `data:image/png` y que pese menos de un tope. Texto plano nunca llega a Drive.
   - El archivo se nombra `venta-<claveIdempotencia>.<ext>` y se comparte con `Sharing.ANYONE_WITH_LINK, VIEW`, que es lo que necesita el jefe para abrirlo desde Reportes sin pedirle a nadie que le cambie los permisos. La miniatura y el enlace usan la forma `https://drive.google.com/uc?export=view&id=<ID>` para que abran en el navegador.
3. `registrarVenta(...)` escribe la fila **con la URL de la foto ya resuelta**, así la fila y la foto nacen juntas.

**Por qué la foto antes que la fila:** si la fila falla queda un archivo huérfano en Drive, que es invisible, tolerable y queda logueado. Al revés quedaría una venta visible sin foto, que es justo lo que el jefe tiene que poder verificar.

## Lectura y reporte

- `leerVentas()` en Apps Script devuelve hoy `{fecha, vendedor, modelo, tipo, cantidad, tipoCambio, precioUnitarioBs, costoTotalBs, totalCobradoBs, gananciaBs, comisionBs, sucursal}`. Hay que **ampliar ese shape** con `cliente`, `nota`, `accesorios`, `accesoriosBs`, `accesoriosCostoBs` y `foto`, leyendo cada columna **por encabezado** con `columna(cab, nombre, porDefecto)`.
- `normalizarVenta()` en `src/ledger.js` suma los mismos seis campos al shape del dominio, tolerando vacío en las ventas viejas.
- `calcularResumen()` ya agrupa por vendedor y `/api/reportes?vendedor=` ya filtra. **El reporte por trabajador ya existe**: no se construye de cero, se le agregan los campos nuevos. Las ventas viejas devuelven los campos vacíos, que es lo correcto, no un bug.

## Interfaz

**Vendedor** (`#formVenta`), cuatro bloques nuevos, todos opcionales:

- **Cliente** — input de texto.
- **Nota** — textarea de una línea, placeholder `Ej: se le regaló un vidrio`.
- **Accesorios** — botón "+ Agregar" que agrega filas `[nombre | precio Bs | costo Bs]`, cada una con su botón "Quitar", y un total en vivo que se suma al Total y a la Ganancia que ya muestra `#detallePrecio`.
- **Foto** — botón "Tomar foto", miniatura previa y "Quitar foto".

Tras cobrar bien se limpia también cliente, nota, accesorios y foto, igual que hoy se limpian vendedor, modelo y costo.

**Jefe** (`#seccion-reportes`): cada venta de `renderVentas()` suma una línea con cliente, nota, accesorios y una **miniatura de 80 px clicable** que abre la foto en una pestaña nueva. Los KPIs y las tablas no cambian.

Todo el texto dinámico pasa por `escapeHtml()`, como ya se hace.

## Autenticación y autorización

Los campos nuevos entran por `POST /api/ventas`, que ya está protegido: rate limit de 60/min y `exigirLlaveTienda` (header `X-Tienda`, comparación en tiempo constante). No hay endpoints nuevos, así que no hay superficie de ataque nueva.

La foto es una imagen de una nota escrita a mano: contiene nombre del cliente y datos de la venta, no datos de pago. Se guarda en la carpeta hermana de la hoja, que el jefe ya puede ver. El acceso de lectura depende de que el jefe tenga permiso en esa carpeta, que queda resuelto porque la hoja es suya.

`/api/reportes` ya pide sesión de dueño. El jefe necesita iniciar sesión como antes; no se agrega un rol nuevo.

## Límites y fallos

| Límite | Valor | Qué pasa si se excede |
|---|---|---|
| Payload HTTP en Render | 1 MB | Con `express.json({limit})` explícito; 240 KB reales quedan holgados |
| Tamaño del base64 en Apps Script | 1.5 MB (~1 MB binario) | Se rechaza la foto y se avisa, **la venta se guarda igual** |
| Apps Script `getUrl()` | 30 s por ejecución | Con lock de 15 s no debería alcanzarse; si ocurre, la venta se guarda sin foto y queda logueado |
| Formato de imagen | solo `data:image/jpeg` y `data:image/png` | Cualquier otro prefijo se rechaza |
| Texto en base64 | máximo 500 caracteres por texto, 300 por nombre de accesorio | Se recorta, no se rechaza la venta |
| Base64 que no sea imagen | prefijo distinto de `data:image/jpeg` o `data:image/png` | Se ignora la foto y se avisa; la venta se guarda |

**La venta nunca se pierde por culpa de la foto.** Es la regla que manda: el celular y los accesorios se registran siempre; la foto es evidencia y es la única parte que puede fallar.

## Qué tiene que hacer el cliente a mano

Solo tres pasos, y ninguno es tocar la hoja:

1. **Permiso de Drive.** En Google Apps Script: *Configuración del proyecto* → *Mostrar el manifiesto `appsscript.json`* → agregar `https://www.googleapis.com/auth/drive` en `oauthScopes`. Es Drive completo, **no** `drive.file`: `drive.file` solo deja ver archivos creados por la propia app, y necesitamos leer la carpeta padre de la hoja que ya existía. Guardar y aceptar la reautorización.
2. **Pegar el `Code.gs` v4** completo. Se entrega en `01 Proyectos/Sis Zamir/Código/` del vault con nombre propio, para no confundirlo con el v3 del 10 de octubre.
3. **Nueva versión.** *Implementar* → *Administrar implementaciones* → `⋮` → **Nueva versión** → *Implementar*. Guardar el código no basta: `/exec` sirve la última versión desplegada.

Y después, nada: no agregar columnas a mano, no cambiar el orden, no completar ventas viejas, no tocar Render, no crear la carpeta de fotos.

## Cómo se verifica que quedó desplegado de verdad

El `Code.gs` lleva su número de versión y `/api/diagnostico` lo devuelve. Esto sube a **4**.

- `version 3` → pegaste el código pero **no** desplegaste. Las ventas se guardan, la foto falla en silencio. Es el peor estado porque no se nota.
- `version 4` → desplegado de verdad.

Verificación después de los 3 pasos:

```
GET /api/diagnostico  →  paso 3 debe decir "Code.gs desplegado, version 4"
```

Y una venta de prueba desde el panel: cargar cliente, nota, un accesorio con precio y costo, y una foto. Después, en Reportes, la venta debe verse con la miniatura y los KPIs deben incluir el accesorio.

## Fuera de alcance

- Marcar ventas como revisadas, aprobarlas o rechazarlas.
- Filas propias por accesorio, o conteo de "cuántos cargadores se vendieron".
- Migrar o rellenar las 8 ventas viejas con estos campos.
- Un rol nuevo de usuario, o login por vendedor.
- Cambiar `TASA_COMISION`, el precio automático, ni el margen comercial.
