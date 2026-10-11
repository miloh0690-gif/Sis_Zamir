# Diseño: publicar la interfaz en Vercel con proxy al backend de Render

- **Fecha:** 2026-10-10
- **Proyecto:** Jhsel Tech Mobiles (ex Sis_Zamir / MooN Tech Mobiles)
- **Estado:** propuesto, pendiente de aprobación de Milo
- **Alcance:** hosting de la interfaz web. **No** cambia la base de datos, ni la lógica de ventas, ni la autenticación.

## 1. Qué quiere Milo

Milo pidió «desplegalo ya en supabase y vercel». Al preguntarle el objetivo respondió que ya
resolvió lo de Google Sheets y quiere **solo Vercel**. Entre las opciones que le presenté
eligió **Vercel en plan gratuito (Hobby), solo la interfaz**, dejando el backend en Render.

Supabase queda **fuera** del proyecto: la base de datos sigue siendo Google Sheets con
Apps Script, y no se migra.

## 2. Decisión

Se publica la carpeta `public/` en Vercel como sitio estático, y se agrega un **proxy
de rutas** que reenvía todas las peticiones `/api/*` al backend que ya vive en Render.

```
Navegador ──https──▶ proyecto.vercel.app          (Vercel Hobby, estático)
                          │
                          ├── /                 → archivo public/index.html
                          ├── /report-export.js → archivo public/report-export.js
                          └── /api/*            → https://sis-zamir.onrender.com/api/*
```

### Por qué un proxy y no mover el backend

Vercel es serverless: no tiene disco persistente ni procesos de larga duración. El backend
actual es un Express con estado que escribe en `data/ventas.json` (`esEfimero()` en
`src/ledger.js`), así que no puede correr allí tal cual sin reescribirlo entero.

El proxy evita por completo ese problema **y** trae una ventaja que no tienen las otras
opciones: **la URL que ve el navegador no cambia**. Todo sigue siendo *mismo origen*,
entonces la cookie de sesión del Dueño (`sz_sesion`, que es `SameSite=Strict`) sigue
funcionando sin tocar una sola línea del backend y sin configurar CORS.

Consecuencia: `public/index.html` **no se modifica**. Ya llama a `/api/...` con rutas
relativas y sigue funcionando tal cual.

## 3. Componentes

### 3.1 `vercel.json` (archivo nuevo, raíz del repo)

Vercel sirve el proyecto como estático puro, sin build de Node:

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

`framework: null` + `buildCommand: null` + `outputDirectory: public` son necesarios porque el
repo tiene un `package.json`: sin eso Vercel intentaría tratarlo como proyecto Node.

Este archivo no afecta a Render, que lee `package.json` y no lee `vercel.json`.

### 3.2 `server.js` (una línea)

Agregar `Cache-Control: no-store` a las respuestas, dentro del middleware de seguridad que ya
existe (`server.js` L26-30, que hoy pone `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy` y `Permissions-Policy`).

Motivo: hoy el servidor **no manda ninguna cabecera de caché**. Es la segunda capa de
defensa, para que el `no-store` viaje aunque alguien acceda al backend por Render
directamente.

### 3.3 Lo que no se toca

- `public/index.html` — las rutas relativas siguen válidas.
- La lógica de ventas, el Dueño, el PIN, el código de tienda, Google Sheets, Apps Script.
- La configuración de Render.

## 4. La trampa del caché, y por qué el header es obligatorio

Vercel permite proxear hacia orígenes externos en **todos los planes, incluido Hobby**
(el *Proxied Request Timeout* de 120 s figura en la tabla de límites generales, que aplica a
todas las cuentas; y la guía oficial *"Using Vercel as a CDN"* describe el patrón sin filtro
de plan).

El riesgo es otro. Desde el **6 de abril de 2026**, los proyectos **nuevos** respetan por
defecto el `Cache-Control` del origen en las rutas proxeadas. Como el backend hoy no manda
esa cabecera, Vercel aplicaría su política por defecto sobre `/api/*`.

El síntoma sería silencioso y grave: el POS mostrando **stock y precios viejos**, o una
sesión del Dueño que no se invalida al cerrar.

Por eso el opt-out es `x-vercel-enable-rewrite-caching: 0`, y se refuerza con
`Cache-Control: no-store` en el servidor. Las dos capas.

## 5. Riesgos aceptados

| Riesgo | Consecuencia | Mitigación |
|---|---|---|
| Hobby prohíbe uso comercial (términos §4: *"only use the Services under a Hobby plan for your personal or non-commercial use"*, y pueden cerrar sin aviso) | Vercel puede apagar el proyecto | **Riesgo asumido explícitamente por Milo.** Render queda funcionando como respaldo |
| Latencia extra del salto Vercel → Render (~100 ms) | Respuesta un poco más lenta | El debounce de 250 ms del preview de precio ya lo absorbe; para una venta es imperceptible |
| El proxy de Vercel ve el tráfico (incluido el PIN del Dueño) | Ninguna nueva: ya viaja cifrado por HTTPS | — |
| Límites Hobby: 100 deployments/día, 1M invocaciones/mes, 100 GB de transferencia | Ninguno foreseeable para el tráfico de un POS de tienda | — |
| Vercel no tiene cuenta conectada en este entorno | No se puede desplegar | **Bloqueante**: hay que conectar la cuenta de Vercel |

## 6. Verificación

Cada paso con evidencia, no con suposición:

1. `vercel_list_teams` devuelve un equipo (o se crea el proyecto con el `teamId` correcto).
2. `GET /api/health` a través de la URL de Vercel → **200**.
3. `GET /` a través de Vercel devuelve el HTML con el nombre `Jhessel Tech Mobiles`.
4. **`GET /api/reportes` sin cookie → 401**, y **con cookie de sesión → 200**. Esto prueba
   que la cookie `SameSite=Strict` sigue viajando a través del proxy, que es el riesgo
   principal de la opción descartada (CORS + `SameSite=None`).
5. `POST /api/ventas` sin header `X-Tienda` → **401**; con la llave correcta → **400** de
   validación. Prueba que el middleware de código de tienda sigue funcionando.
6. **Prueba de caché**: pedir `/api/inventario` dos veces con datos distintos en Render y
   confirmar que la segunda respuesta no es la primera repetida.
7. El repo sigue con `node --test` en verde (4 tests).

## 7. Orden de ejecución

1. Agregar `Cache-Control: no-store` en `server.js`. Commit + push. Render despliega.
2. Agregar `vercel.json`. Commit + push.
3. Conectar la cuenta de Vercel (bloqueante; depende de Milo).
4. Crear el proyecto en Vercel desde el repo `miloh0690-gif/Sis_Zamir`, rama `main`.
5. Pasar las verificaciones de la sección 6.

Si alguna falla, el POS sigue funcionando igual en `https://sis-zamir.onrender.com`: por eso
esta parte **no toca** la ruta de acceso que ya usan.

## 8. Lo que este diseño no resuelve

- **El reporte en 0 y la venta fuera de inventario.** Son independientes de Vercel y siguen
  esperando que Milo pegue el `Code.gs` corregido en Apps Script → Implementar → **Nueva
  versión** → Implementar → pasar la URL `/exec` nueva.
- El nombre de la nota del vault (`Jhsel Tech Mobiles.md`, una sola s) frente al sistema
  (`Jhessel`, doble l).
- Qué significan las columnas `TotalCobrado` y `GananciaEquipo` de la hoja de Ventas.