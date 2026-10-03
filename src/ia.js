'use strict';

// Solo los ARGUMENTOS DE VENTA. Las especificaciones nunca salen de
// aqui: llegan del indice o de src/specs.js, y este modulo las recibe
// como contexto para redactar. Asi el modelo no puede inventar una
// capacidad de bateria que no esta en los datos.
//
// Groq es el proveedor con el plan gratuito mas generoso y el unico que
// sigue publicando su tabla de limites completa:
//   openai/gpt-oss-120b -> 30 req/min, 1.000 req/dia, 200k tokens/dia
// (Ojo: la capacidad gratuita es del MODELO, no de la cuenta. Pasar de
// gpt-oss-120b a un modelo mas grande te puede recortar el dia a 1/14.)

const URL_API = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 30000;

function apiKey() {
  return String(process.env.GROQ_API_KEY || '').trim();
}

function modelo() {
  return String(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
}

function habilitado() {
  return Boolean(apiKey());
}

// -----------------------------------------------------------------
// Rate limit por IP
// -----------------------------------------------------------------

const golpes = new Map();

function consumirCupo(ip) {
  const ahora = Date.now();
  const ventana = ahora - 60000;
  const lista = (golpes.get(ip) || []).filter((t) => t > ventana);
  if (lista.length >= 8) {
    golpes.set(ip, lista);
    return { permitido: false, faltan: Math.ceil((lista[0] + 60000 - ahora) / 1000) };
  }
  lista.push(ahora);
  golpes.set(ip, lista);
  return { permitido: true };
}

setInterval(() => {
  const limite = Date.now() - 60000;
  for (const [ip, lista] of golpes) {
    const filtrada = lista.filter((t) => t > limite);
    if (filtrada.length === 0) golpes.delete(ip);
    else golpes.set(ip, filtrada);
  }
}, 60000).unref();

// -----------------------------------------------------------------
// Peticion
// -----------------------------------------------------------------

// minItems/maxItems NO van aqui. La decodificacion restringida de Groq
// no los soporta en el subconjunto de JSON Schema que acepta, y con ellos
// presentes la generacion falla. El conteo se fuerza en el codigo, que es
// mas barato que un 400 de Groq.
const ESQUEMA = {
  type: 'object',
  properties: {
    puntosDeVenta: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['puntosDeVenta'],
  additionalProperties: false,
};

function construirPrompt(ficha) {
  const datos = [
    'Modelo: ' + (ficha.nombre || ''),
    ficha.procesador ? 'Procesador: ' + ficha.procesador : '',
    ficha.pantalla ? 'Pantalla: ' + ficha.pantalla : '',
    ficha.camaras ? 'Camaras: ' + ficha.camaras : '',
    ficha.bateria ? 'Bateria: ' + ficha.bateria : '',
    ficha.carga ? 'Carga: ' + ficha.carga : '',
    ficha.ramAlmacenamiento ? 'Memoria: ' + ficha.ramAlmacenamiento : '',
    ficha.conectividad ? 'Conectividad: ' + ficha.conectividad : '',
    ficha.sistema ? 'Sistema: ' + ficha.sistema : '',
    ficha.releaseDate ? 'Lanzamiento: ' + ficha.releaseDate : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    'Eres un vendedor experto en telefonia movil. Escribes en espanol,',
    'con tono natural de tienda, sin emojis ni signos de exclamacion.',
    '',
    'REGLA INNEGOCIABLE: usa UNICAMENTE los datos de abajo. No agregues',
    'ninguna cifra, modelo ni característica que no este ahi. Si un dato',
    'no aparece, no lo menciones. Inventar una especificacion es peor que',
    'callarse.',
    '',
    'ESPECIFICACIONES VERIFICADAS:',
    datos,
    '',
    'TAREA: escribe 3 argumentos de venta. Cada uno en una frase corta.',
    'Cada argumento debe apoyarse en un dato concreto de las',
    'especificaciones de arriba, con su numero exacto.',
    'Los tres deben atacar sudut distintos: uno de potencia/rendimiento,',
    'uno de camara o pantalla, y uno de bateria, memoria o conectividad.',
    'Piensa en que le importa a alguien que esta pagando: no digas "gran',
    'bateria", di la capacidad real.',
    '',
    'Responde SOLO con este JSON y nada mas, sin texto antes ni despues:',
    '{"puntosDeVenta": ["...","...","..."]}',
  ].join('\n');
}

/**
 * Pide los argumentos a Groq. Intenta primero con el esquema estricto y,
 * si la generacion falla, reintenta sin response_format pidiendo el JSON
 * en el prompt. El motivo: gpt-oss-120b es un modelo de RAZONAMIENTO y con
 * max_tokens chico se agota pensando antes de emitir el JSON. Medido el
 * 2026-10-03: con 400 tokens la mitad de las fichas salian sin argumentos
 * y el log decia "Failed to validate JSON".
 */
async function pedir(ficha, usarEsquema) {
  const cuerpo = {
    model: modelo(),
    // Groq recomienda meter todas las instrucciones en el mensaje de
    // usuario, no en un system prompt.
    messages: [{ role: 'user', content: construirPrompt(ficha) }],
    // low = razonamiento corto. Un argumento de venta no necesita pensar
    // mucho, y cada token de razonamiento sale del presupuesto del JSON.
    reasoning_effort: 'low',
    include_reasoning: false,
    temperature: 0.6,
    // El default de Groq es 1024 y la doc avisa que para razonamiento puede
    // quedar corto. Con 400 fallaba de forma intermitente.
    max_completion_tokens: 1400,
  };

  if (usarEsquema) {
    cuerpo.response_format = {
      type: 'json_schema',
      json_schema: { name: 'argumentos_venta', strict: true, schema: ESQUEMA },
    };
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
      signal: controlador.signal,
      body: JSON.stringify(cuerpo),
    });

    const texto = await r.text();
    let datos = null;
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      datos = null;
    }

    if (!r.ok) {
      const mensaje =
        (datos && datos.error && (datos.error.message || datos.error.type)) ||
        'Groq respondio HTTP ' + r.status;
      const e = new Error('Groq: ' + mensaje);
      e.codigo = 502;
      throw e;
    }

    const opcion = datos && datos.choices && datos.choices[0];
    const parte = opcion && opcion.message && opcion.message.content;
    if (!parte) {
      const razon = opcion && opcion.finish_reason ? ' (' + opcion.finish_reason + ')' : '';
      const e = new Error('Groq no devolvio contenido' + razon + '.');
      e.codigo = 502;
      throw e;
    }

    return listaDe(parte);
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Saca los 3 strings del texto. Tolera que el modelo lo envuelva en ```json
 * o que de 4 o 2: se recorta a 3 y se descarta lo que no sea texto.
 */
function listaDe(texto) {
  let limpio = String(texto).trim();
  const cerca = limpio.indexOf('{');
  const lejos = limpio.lastIndexOf('}');
  if (cerca >= 0 && lejos > cerca) limpio = limpio.slice(cerca, lejos + 1);

  let datos = null;
  try {
    datos = JSON.parse(limpio);
  } catch (e) {
    datos = null;
  }
  if (!datos || !Array.isArray(datos.puntosDeVenta)) return null;

  const lista = datos.puntosDeVenta
    .map(function (p) {
      return String(p === undefined || p === null ? '' : p).trim();
    })
    .filter(Boolean)
    .slice(0, 3);
  return lista.length ? lista : null;
}

async function argumentosDeVenta(ficha, ip) {
  if (!habilitado()) {
    const e = new Error('Los argumentos de venta con IA no estan habilitados (falta GROQ_API_KEY).');
    e.codigo = 503;
    throw e;
  }

  const cuota = consumirCupo(ip || 'desconocido');
  if (!cuota.permitido) {
    const e = new Error('Demasiadas consultas seguidas. Espera ' + cuota.faltan + ' segundos.');
    e.codigo = 429;
    throw e;
  }

  const problemas = [];
  for (const usarEsquema of [true, false]) {
    try {
      const lista = await pedir(ficha, usarEsquema);
      if (lista) return lista;
      problemas.push('respuesta sin argumentos utilizables');
    } catch (e) {
      problemas.push(e.message);
    }
  }

  const e = new Error('Groq: ' + problemas.join(' | '));
  e.codigo = 502;
  throw e;
}

module.exports = {
  argumentosDeVenta: argumentosDeVenta,
  habilitado: habilitado,
  modelo: modelo,
};