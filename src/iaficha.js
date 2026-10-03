'use strict';

// Ficha TECNICA redactada por IA. Es el ULTIMO recurso, cuando ninguna base
// de datos tiene el equipo.
//
// CONTRASTE CON LA REGLA DE SIS ZAMIR
//
// La regla del proyecto es "la IA redacta, la base decide": las
// especificaciones salen de la base de datos y la IA solo arma argumentos de
// venta. Este modulo rompe esa regla a proposito, asi que deja de ser una
// excepcion invisible:
//
//   - La ficha viene marcada `fuenteDatos: 'ia'` y `verificado: false`.
//   - `especifico: true` cuando el modelo NO conoce el equipo.
//   - Se pregunta DOS VEZES, por separado. Si los numeros no coinciden
//     entre las dos respuestas, `estable: false`: el modelo esta inventando
//     y el numero sale con toda seguridad.
//
// Por que no se pregunta una vez y ya: un modelo de lenguaje que no conoce
// un telefono NO dice "no lo se". Rellena. Y sus rellenos son plausibles:
// "5000 mAh", "108 MP", "AMOLED 6.7". Un vendedor con eso delante de un
// cliente no tiene forma de saber que se lo invento.
//
// ESTO NO SIRVE PARA MODELOS RECIENTES
//
// gpt-oss-120b tiene corte de entrenamiento en 2025. Los telefonos que la
// tienda vendio en 2026 (Redmi A7, Honor 600, POCO X8, TCL 60 Ultra, ZTE
// V80, CUBOT) estan fuera de su conocimiento con casi seguridad. Para esos
// esta fuente devuelve `loConoce: false` y no inventa. Para los mas viejos
// (2024 y anteriores) suele acertar, y las dos respuestas coinciden.
//
// Cuando se necesitan datos de un equipo nuevo, la salida correcta no es una
// IA: es la ficha del fabricante o la de GSMArena. Una IA sin fuente es una
// opinion con numeros.

const URL_API = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 40000;
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 1600;

function apiKey() {
  return String(process.env.GROQ_API_KEY || '').trim();
}

function modelo() {
  return String(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
}

function habilitado() {
  return Boolean(apiKey());
}

const cache = new Map();

// ---------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------

const ESQUEMA = {
  type: 'object',
  properties: {
    loConozco: { type: 'boolean' },
    nombreOficial: { type: 'string' },
    lanzamiento: { type: 'string' },
    procesador: { type: 'string' },
    pantalla: { type: 'string' },
    camaras: { type: 'string' },
    bateria: { type: 'string' },
    carga: { type: 'string' },
    ram: { type: 'string' },
    almacenamiento: { type: 'string' },
    conectividad: { type: 'string' },
    sistema: { type: 'string' },
    nota: { type: 'string' },
  },
  required: [
    'loConozco', 'nombreOficial', 'lanzamiento', 'procesador', 'pantalla',
    'camaras', 'bateria', 'carga', 'ram', 'almacenamiento', 'conectividad',
    'sistema', 'nota',
  ],
  additionalProperties: false,
};

function prompt(nombre) {
  return [
    'Eres un catalogador tecnico de telefonos. Tienes que rellenar la ficha',
    'de UN equipo: "' + nombre + '".',
    '',
    'REGLA PRINCIPAL, no la ignores: si NO estas seguro de que ese equipo',
    'existe y de sus especificaciones, pon loConozco en false y deja los',
    'campos vacios. Es MIL veces mejor decir que no lo sabes que inventar',
    'un numero. Un vendedor va a leer esto a un cliente.',
    '',
    'Tienes en cuenta la fecha de hoy. Si el equipo es de 2026 casi seguro',
    'no esta en tus datos: pon loConozco en false.',
    '',
    'Si lo conoces, responde con lo que sepas de memoria, sin adivinar.',
    'En "nota" explica en una frase de donde sale la info (por ejemplo',
    '"ficha de GSMArena de 2024") o di que no recuerdas la fuente.',
    '',
    'Responde SOLO con el JSON del esquema.',
  ].join('\n');
}

// ---------------------------------------------------------------
// Peticion
// ---------------------------------------------------------------

async function preguntar(nombre) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
      signal: controlador.signal,
      body: JSON.stringify({
        model: modelo(),
        messages: [{ role: 'user', content: prompt(nombre) }],
        reasoning_effort: 'low',
        include_reasoning: false,
        temperature: 0.3,
        max_completion_tokens: MAX_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'ficha_tecnica', strict: true, schema: ESQUEMA },
        },
      }),
    });

    const texto = await r.text();
    let datos = null;
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      datos = null;
    }
    if (!r.ok || !datos || !datos.choices || !datos.choices[0]) return null;

    const parte = datos.choices[0].message && datos.choices[0].message.content;
    if (!parte) return null;

    let limpio = String(parte).trim();
    const a = limpio.indexOf('{');
    const b = limpio.lastIndexOf('}');
    if (a >= 0 && b > a) limpio = limpio.slice(a, b + 1);
    try {
      return JSON.parse(limpio);
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

function texto(v) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  return t === 'null' || t === 'undefined' ? '' : t;
}

// Los campos que tienen que coincidir entre las dos respuestas para que el
// numero sea creible. "nota" y "lanzamiento" no cuentan: son texto libre.
const NUMERICOS = ['procesador', 'pantalla', 'camaras', 'bateria', 'carga', 'ram', 'almacenamiento'];

function comparar(p1, p2) {
  const diferencias = [];
  for (const campo of NUMERICOS) {
    const a = normalizarNumero(texto(p1[campo]));
    const b = normalizarNumero(texto(p2[campo]));
    if (!a && !b) continue;
    if (a !== b) diferencias.push(campo);
  }
  return diferencias;
}

function normalizarNumero(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,](?=\d{3}\b)/g, '')
    .trim();
}

// ---------------------------------------------------------------

async function buscar(modeloTexto, nombreConocido) {
  const k = String(modeloTexto || '').trim();
  if (!k || !habilitado()) return null;

  const guardado = cache.get(k);
  if (guardado) return guardado;

  const objetivo = nombreConocido || k;

  // Dos preguntas independientes. Si el modelo no conoce el equipo, las dos
  // lo dicen y listo. Si conoce, las dos deberian coincidir.
  const pareja = await Promise.all([preguntar(objetivo), preguntar(objetivo)]);
  const p1 = pareja[0];
  const p2 = pareja[1];
  if (!p1 && !p2) return null;

  const Known = (p) => Boolean(p && p.loConozco === true);
  if (!Known(p1) && !Known(p2)) {
    const salida = {
      ficha: null,
      fuenteDatos: 'ia',
      verificado: false,
      loConoce: false,
      estable: false,
      diferencias: [],
      mensaje:
        'Ninguna base de datos tiene "' + objetivo + '" y la IA tampoco lo ' +
        'conoce. Salio hace poco y no hay ficha verificada. No inventar: ' +
        'preguntale al fabricante o a un mayorista.',
    };
    cache.set(k, salida);
    return salida;
  }

  const buena = Known(p1) ? p1 : p2;
  const otra = Known(p1) ? p2 : p1;
  const diferencias = otra ? comparar(buena, otra) : NUMERICOS.slice();

  const resumen = [
    buena.procesador ? 'procesador ' + texto(buena.procesador) : '',
    buena.pantalla ? 'pantalla ' + texto(buena.pantalla) : '',
    buena.bateria ? 'bateria ' + texto(buena.bateria) : '',
    buena.ram ? texto(buena.ram) : '',
    buena.almacenamiento ? texto(buena.almacenamiento) : '',
  ]
    .filter(Boolean)
    .join(', ');

  const ficha = {
    nombre: texto(buena.nombreOficial) || objetivo,
    marca: '',
    procesador: texto(buena.procesador),
    pantalla: texto(buena.pantalla),
    camaras: texto(buena.camaras),
    bateria: texto(buena.bateria),
    carga: texto(buena.carga),
    ramAlmacenamiento: [texto(buena.ram), texto(buena.almacenamiento)].filter(Boolean).join(' · '),
    conectividad: texto(buena.conectividad),
    sistema: texto(buena.sistema),
    resumen: resumen ? resumen + '.' : '',
    imagenUrl: '',
    releaseDate: texto(buena.lanzamiento),
    verificado: false,
    fuenteDatos: 'ia',
    esFichaDeIa: true,
    estable: diferencias.length === 0,
    diferencias: diferencias,
    nota: texto(buena.nota),
    fuentes: [],
  };

  const salida = {
    ficha: ficha,
    cache: false,
    fuenteDatos: 'ia',
    verificado: false,
    loConoce: true,
    estable: ficha.estable,
    diferencias: diferencias,
  };
  cache.set(k, salida);
  return salida;
}

module.exports = {
  buscar: buscar,
  habilitado: habilitado,
  modelo: modelo,
  comparar: comparar,
};