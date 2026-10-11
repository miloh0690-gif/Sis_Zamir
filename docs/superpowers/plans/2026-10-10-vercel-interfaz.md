# Publicar la interfaz en Vercel (proxy a Render) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la interfaz de Jhsel Tech Mobiles se sirva desde `proyecto.vercel.app` y siga hablando con el backend de Render bajo el mismo origen, sin modificar una sola línea de `public/index.html`.

**Architecture:** Vercel sirve `public/` como sitio estático puro (`framework: null`, `buildCommand: null`, `outputDirectory: public`) y un `rewrite` de `/api/:path*` a `https://sis-zamir.onrender.com/api/:path*`. Como el navegador sigue viendo un solo origen, la cookie `sz_sesion` (`SameSite=Strict`) continúa funcionando sin CORS y sin tocar el backend. El backend se refuerza con `Cache-Control: no-store` para que el proxy no sirva respuestas viejas.

**Tech Stack:** Vercel (Hobby, estático + rewrites a origen externo) · Render (Node 26 / Express 4) · `node:test` para las pruebas · MCP de Vercel para crear el proyecto.

**Spec:** `docs/superpowers/specs/2026-10-10-vercel-design.md` — el plan razona desde el spec, así que el spec viaja con él.

## Global Constraints

- **No se modifica `public/index.html`.** Ya llama a `/api/...` con rutas relativas; el rewrite cubre ese caso. Si algún cambio parece necesitar tocarlo, es señal de que el diseño cambió: parar y revisar el spec.
- **El destino del proxy es `https://sis-zamir.onrender.com/api/:path*`.** Es el servicio `Sis_Zamir` = `srv-davt4m5g1s2s73bpk9dg` del workspace `tea-dagf9grl550s73bfh1hg`. Un typo acá manda las ventas a un 404 silencioso.
- **El origen del rewrite es `/api/:path*`, no `/api`.** Con `/api` solo casaría la raíz de la API y `/api/reportes` nunca llegaría al backend.
- **`Cache-Control: no-store` en el servidor, siempre.** Vercel respeta el `Cache-Control` del origen en las rutas proxeadas desde el 6 de abril de 2026; sin esa cabecera Vercel aplica su política por defecto y el POS muestra stock viejo.
- **Commits en español, minúsculas y sin tildes.** Ejemplos del repo: `"Cierra endpoints publicos y agrega codigo de tienda opcional"`.
- **Node 26.10.0 no está en el PATH.** Antes de cualquier comando con Node: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH"`.
- **Push sin credenciales en el keychain:** `GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0 git push origin main` (usuario `miloh0690-gif`, token en `~/.config/opencode/github-token`). El helper `credential.helper` inline **no** funciona.
- **Si algo falla, el POS sigue entrando por `https://sis-zamir.onrender.com`.** Ninguna tarea de este plan puede dejar ese camino roto; por eso todas son aditivas.

## Review Focus

Cinco condiciones que el spec implica y que ningún test unitario cubre, en orden de probabilidad de morder a alguien usando el sistema:

1. **Render duerme por inactividad (plan free) y el proxy tiene timeout de 120 s.** El primer request de la mañana puede tardar medio minuto y parecer que la app está colgada, o pasarse del timeout. Un usuario razonable espera que la app abra rápido aunque nadie la haya tocado en horas.
2. **`Set-Cookie` del login podría no reenviarse a través del proxy.** Si Vercel se la come, el Dueño escribe el PIN correcto y nunca entra, sin mensaje de error.
3. **`SameSite=Strict` con el proxy como "otro sitio".** Aunque la cookie llegue, el navegador podría rechazarla en los requests siguientes. Dueño que "se cierra solo" después de entrar.
4. **El header `X-Tienda` podría no reenviarse.** El código de tienda es un header propio; si el proxy lo dropea, *toda* venta responde 401 aunque la llave sea correcta.
5. **Caché de `/api/inventario`.** El POS mostrando stock y precios viejos, en silencio, y el vendedor cobra algo que ya no hay.

Las 5 se chequean en la Task 4; las 4 y 5 quedan ancladas por configuración en las Tasks 1 y 2.

---

### Task 1: `Cache-Control: no-store` en el backend

**Files:**
- Modify: `server.js:26-32` (el middleware `app.use((req, res, next) => {...})` que ya pone las cabeceras de seguridad)
- Test: `test/cache-headers.test.js` (nuevo)

**Interfaces:**
- Consumes: nada. Es la primera tarea.
- Produces: el servidor responde `Cache-Control: no-store` en **toda** ruta, incluidas las proxeadas por Vercel. La Task 2 depende de que este header exista para reinforcear el opt-out de Vercel.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/cache-headers.test.js`. La técnica es la misma de `test/manual-sale.test.js`: correr el código real en un `vm` con stubs, no reescribir la función.

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');

function extraerMiddleware() {
    const inicio = source.indexOf('app.use((req, res, next) => {');
    assert.notEqual(inicio, -1, 'server.js debe seguir teniendo el middleware de seguridad');
    const fin = source.indexOf('\n});', inicio);
    assert.notEqual(fin, -1, 'no se pudo cerrar el middleware de seguridad');
    return source.slice(inicio, fin + 4);
}

test('el middleware de seguridad marca toda respuesta como no cacheable', () => {
    let manejador = null;
    vm.runInNewContext(extraerMiddleware(), {
        app: { use: (fn) => { manejador = fn; } },
    }, { filename: 'server.js' });
    assert.ok(manejador, 'el middleware debe registrarse con app.use');

    const puestas = {};
    let siguiente = false;
    manejador({}, { setHeader: (k, v) => { puestas[k] = v; } }, () => { siguiente = true; });

    assert.equal(puestas['Cache-Control'], 'no-store');
    assert.equal(siguiente, true, 'el middleware debe seguir la cadena');
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

Run: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH" && node --test test/cache-headers.test.js`
Expected: FAIL con `undefined !== 'no-store'` en el `assert.equal(puestas['Cache-Control'], ...)`.

- [ ] **Step 3: Agregar la línea**

En `server.js`, dentro del middleware de L26-32, agregar **una** línea después de `res.setHeader('Permissions-Policy', ...)` (L30) y antes del `next();`:

```js
  // Vercel proxea /api hacia este servidor y respeta el Cache-Control del
  // origen. Sin esto serviria respuestas viejas: stock, precios y sesiones.
  res.setHeader('Cache-Control', 'no-store');
```

- [ ] **Step 4: Correr el test y verlo pasar**

Run: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH" && node --test test/cache-headers.test.js`
Expected: PASS.

- [ ] **Step 5: Correr la suite completa**

Run: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH" && npm test`
Expected: `pass 5`, `fail 0` (los 4 tests previos más este).

- [ ] **Step 6: Commit y push**

```bash
git add server.js test/cache-headers.test.js
git commit -m "Marca las respuestas del backend como no cacheables"
GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0 git push origin main
```

- [ ] **Step 7: Esperar el deploy de Render y confirmar la cabecera en producción**

Render hace autoDeploy por commit en `main`. Esperar a que `render_list_deploys` (service `srv-davt4m5g1s2s73bpk9dg`) muestre el deploy del commit nuevo como `live`.

Run: `curl -sI https://sis-zamir.onrender.com/api/health | grep -i '^cache-control'`
Expected: `cache-control: no-store`

Si no aparece, **parar acá**: la Task 2 no se hace hasta que el backend mande la cabecera, porque el opt-out de `vercel.json` sin `no-store` en el origen deja el caché de Vercel funcionando.

---

### Task 2: `vercel.json` en la raíz del repo

**Files:**
- Create: `vercel.json`
- Test: `test/vercel-config.test.js` (nuevo)

**Interfaces:**
- Consumes: nada del código. Depende **operativamente** de que la Task 1 haya verificado el header en producción (Step 7).
- Produces: la configuración que la Task 3 envía a Vercel al crear el proyecto. Si Vercel pide importar settings del repo, estos son los valores correctos.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/vercel-config.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const config = JSON.parse(fs.readFileSync(require.resolve('../vercel.json'), 'utf8'));

test('Vercel sirve la interfaz estatica desde public sin build de Node', () => {
    assert.equal(config.framework, null);
    assert.equal(config.buildCommand, null);
    assert.equal(config.outputDirectory, 'public');
});

test('el proxy manda todo /api al backend de Render', () => {
    assert.deepEqual(config.rewrites, [
        { source: '/api/:path*', destination: 'https://sis-zamir.onrender.com/api/:path*' },
    ]);
});

test('las respuestas del proxy nunca se cachean', () => {
    const regla = config.headers.find((h) => h.source === '/api/:path*');
    assert.ok(regla, 'debe existir una regla de headers para /api/:path*');
    const claves = Object.fromEntries(regla.headers.map((h) => [h.key, h.value]));
    assert.equal(claves['x-vercel-enable-rewrite-caching'], '0');
    assert.equal(claves['Cache-Control'], 'no-store, no-cache, must-revalidate');
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

Run: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH" && node --test test/vercel-config.test.js`
Expected: FAIL con `ENOENT` al hacer `readFileSync` de `vercel.json`.

- [ ] **Step 3: Crear `vercel.json`**

Contenido exacto, en la raíz del repo:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "buildCommand": null,
  "outputDirectory": "public",
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://sis-zamir.onrender.com/api/:path*" }
  ],
  "headers": [
    {
      "source": "/api/:path*",
      "headers": [
        { "key": "x-vercel-enable-rewrite-caching", "value": "0" },
        { "key": "Cache-Control", "value": "no-store, no-cache, must-revalidate" }
      ]
    }
  ]
}
```

Los tres primeros campos son obligatorios: el repo tiene `package.json` y sin ellos Vercel trata el proyecto como Node e intenta un build que no existe.

- [ ] **Step 4: Correr el test y verlo pasar**

Run: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH" && node --test test/vercel-config.test.js`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Correr la suite completa**

Run: `export PATH="/Users/milo25/.proto/tools/node/26.10.0/bin:$PATH" && npm test`
Expected: `pass 8`, `fail 0`.

- [ ] **Step 6: Commit y push**

```bash
git add vercel.json test/vercel-config.test.js
git commit -m "Agrega la configuracion de Vercel para publicar la interfaz"
GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0 git push origin main
```

El push dispara el deploy de Render otra vez. Es inocuo: Render lee `package.json` y nunca mira `vercel.json`.

---

### Task 3: Crear el proyecto en Vercel

**Files:** ninguno. Esta tarea es operativa.

**Interfaces:**
- Consumes: el `vercel.json` commiteado en la Task 2 y el repo `miloh0690-gif/Sis_Zamir`.
- Produces: una URL `*.vercel.app` que sirve la interfaz y proxea `/api`. Es el Insumo de la Task 4.

> **BLOQUEANTE — depende de Milo, no de código.** El MCP de Vercel hoy responde `vercel_list_teams → {"teams":[],"count":0}` y `vercel_get_auth_user → 404 not_found`. Milo dijo que tiene cuenta y que ya usó Vercel, así que hay que conectar su cuenta al MCP o que diga con qué correo está. **Si sigue sin equipo, esta tarea no se puede ejecutar y el POS sigue intacto en Render.** No inventar un `teamId`.

- [ ] **Step 1: Confirmar que hay un equipo**

Run: `vercel_list_teams`
Expected: un objeto con `count >= 1` y un `teamId`. Si sigue en 0, **parar y pedirle a Milo que conecte la cuenta**; seguir con las tareas 1 y 2 igual, que no dependen de esto.

- [ ] **Step 2: Crear el proyecto conectado al repo**

Run: `vercel_create_git_project` con `teamId` = el del Step 1, `repo` = `miloh0690-gif/Sis_Zamir`, `projectName` = `jhsel-tech-mobiles`, `provider` = `github`, `deploy` = `true`.

Expected: la herramienta devuelve el proyecto creado y un deployment. Vercel lee `vercel.json` del repo y aplica el `outputDirectory: public` solo, sin build.

- [ ] **Step 3: Guardar la URL del deployment**

Anotar el `url` devuelto (formato `https://<algo>.vercel.app`). Todas las verificaciones de la Task 4 usan esa URL.

Si el deployment falla, el log del build dice por qué: lo más probable es que Vercel haya ignorado `outputDirectory` y esté sirviendo la raíz (donde no hay `index.html`) — en ese caso, revisar que `vercel.json` esté efectivamente en la raíz del repo en `main`.

---

### Task 4: Verificar en producción a través de Vercel

**Files:** ninguno.

**Interfaces:**
- Consumes: la URL de la Task 3.
- Produce: evidencia de que el proxy no rompe ninguno de los cinco riesgos de Review Focus.

> Todo esto se corre contra la URL de Vercel. Si algo falla, el POS **sigue funcionando** en `https://sis-zamir.onrender.com`; no hay que revertir nada de este plan.

- [ ] **Step 1: La interfaz se sirve (spec §6.3)**

Run: `curl -s <URL_VERCEL>/ | grep -c 'Jhessel Tech Mobiles'`
Expected: `4` (title, meta apple-web-app-title, manifest name y `<h1>`).

- [ ] **Step 2: El health check pasa por el proxy (spec §6.2)**

Run: `curl -s -o /dev/null -w '%{http_code}' <URL_VERCEL>/api/health`
Expected: `200`.

- [ ] **Step 3: Riesgo 5 — el caché no sirve respuestas viejas**

Pedir el inventario dos veces separadas por al menos un segundo y comparar.

Run: `curl -s <URL_VERCEL>/api/inventario > /tmp/v1.json; sleep 2; curl -s <URL_VERCEL>/api/inventario > /tmp/v2.json; diff -q /tmp/v1.json /tmp/v2.json`
Expected: idénticos **solo si** no cambió nada en el inventario; para probarlo de verdad, cambiar un stock en Render entre las dos llamadas y confirmar que el segundo `/tmp/v2.json` refleja el cambio. Lo que se busca es que la cabecera `x-vercel-enable-rewrite-caching` y el `no-store` impongan el refresco.

Run alternativo para ver las cabeceras: `curl -sI <URL_VERCEL>/api/inventario | grep -iE 'cache-control|x-vercel-cache'`
Expected: `cache-control` con `no-store` o `no-cache`, y `x-vercel-cache` ausente o `MISS`.

- [ ] **Step 4: Riesgos 2 y 3 — la cookie del Dueño viaja y el navegador la acepta (spec §6.4)**

```bash
curl -s -i -c /tmp/jar.txt -X POST <URL_VERCEL>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"pin":"517120"}'
```
Expected: `http` 200 y una línea `Set-Cookie: sz_sesion=...` **en la respuesta**.

Luego, con ese jar:
```bash
curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar.txt <URL_VERCEL>/api/reportes
```
Expected: `200`. Si devolviera 401, el problema es `SameSite=Strict` a través del proxy (riesgo 3) y hay que parar y revisarlo, no seguir.

- [ ] **Step 5: Riesgo 4 — el header `X-Tienda` llega al backend (spec §6.5)**

```bash
curl -s -o /dev/null -w 'sin llave: %{http_code}\n' -X POST <URL_VERCEL>/api/ventas \
  -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w 'con llave: %{http_code}\n' -X POST <URL_VERCEL>/api/ventas \
  -H 'Content-Type: application/json' -H 'X-Tienda: HP9AM9-PMXQ85' -d '{}'
```
Expected: `sin llave: 401` y `con llave: 400`. El 400 es el cuerpo vacío validado por el backend — prueba que la llave atravesó el proxy. Si el `con llave` también da 401, el header no se reenvía (riesgo 4).

- [ ] **Step 6: Riesgo 1 — el cold start de Render no rompe el proxy**

Run: `curl -s -o /dev/null -w 'primer request: %{time_total}s\n' <URL_VERCEL>/api/health`
Expected: menos de 120 s (el timeout del proxy) y, en la práctica, menos de 60 s. Si pasa de 120 s, el proxy corta antes que Render: avisarle a Milo y considerar activar el plan always-on de Render.

- [ ] **Step 7: Confirmar que el POS viejo sigue entero**

Run: `curl -s -o /dev/null -w '%{http_code}' https://sis-zamir.onrender.com/api/health`
Expected: `200`. Si esto falla, Vercel no es el culpable — es que Render se cayó, y el POS del Dueño tampoco entra.

- [ ] **Step 8: Reportar a Milo**

Comunicar: la URL de Vercel, el resultado de los siete chequeos con su evidencia, y los dos avisos que importan — **(a)** que el plan Hobby prohíbe uso comercial y Vercel puede apagar el proyecto sin aviso, así que Render queda como respaldo y conviene abrir el POS desde ahí si algún día falla, y **(b)** que el logout del Dueño sigue funcionando en la URL nueva, que es exactamente el motivo de haber elegido el proxy en vez de mover el backend.

---

## Self-review

**1. Cobertura del spec.** §1-2 (decisión) → Task 3. §3.1 (`vercel.json`) → Task 2. §3.2 (`server.js`) → Task 1. §3.3 (lo que no se toca) → Global Constraints. §4 (trampa del caché) → Steps 3 de Tasks 1 y 2, y Step 3 de Task 4. §5 (riesgos) → Global Constraints y Review Focus. §6 (7 verificaciones) → Steps 1-5 y 7 de Task 4; el punto 7 del spec (`node --test` en verde) está en los Steps 5 de ambas Tasks 1 y 2. §7 (orden) → Task 1, Task 2, Task 3, Task 4, en ese orden. §8 (lo que no resuelve) → no es trabajo de este plan.

**2. Barrido de pasos.** Cada paso dice exactamente una cosa. No hay "TBD" ni "agregar validación apropiada". Los dos únicos bloques de código largo son los tests completos, que sí son el contenido del paso.

**3. Consistencia de tipos.** `extraerMiddleware()` y `config` se definen y se usan en el mismo archivo de test. `URL_VERCEL` se introduce en el Step 3 de Task 3 y lo usan los Steps 1-7 de Task 4. `teamId` se introduce en el Step 1 de Task 3 y lo usa el Step 2. Consistente.

**4. Review Focus.** Las 5 líneas tienen dueño: 1, 2, 3 y 4 → Task 4 Steps 4, 5, 4 y 6; la 5 → Task 4 Step 3, anclada además por los tests de las Tasks 1 y 2.

**5. Proporción.** El spec tiene 153 líneas y el plan tiene ~200. La diferencia es el header obligatorio (Global Constraints, Review Focus) y los tests completos, que son insustituibles aquí porque describen archivos nuevos enteros.