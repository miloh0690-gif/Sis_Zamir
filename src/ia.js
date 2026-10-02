'use strict';

// Solo los ARGUMENTOS DE VENTA. Las especificaciones nunca salen de
// aqui: llegan de src/specs.js, y este modulo las recibe como contexto
// para redactar. Asi el modelo no puede inventar una capacidad de
// bateria que no esta en los datos.
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

const ESQUEMA = {
  type: 'object',
  properties: {
    puntosDeVenta: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
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
  ].join('\n');
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

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  try {
    const respuesta = await fetch(URL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey(),
      },
      signal: controlador.signal,
      body: JSON.stringify({
        model: modelo(),
        messages: [{ role: 'user', content: construirPrompt(ficha) }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'argumentos_venta',
            strict: true,
            schema: ESQUEMA,
          },
        },
        max_tokens: 400,
      }),
    });

    const texto = await respuesta.text();
    let datos;
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      datos = {};
    }

    if (!respuesta.ok) {
      const mensaje =
        (datos && datos.error && (datos.error.message || datos.error.type)) ||
        'Groq respondio HTTP ' + respuesta.status;
      const e = new Error('Groq: ' + mensaje);
      e.codigo = 502;
      throw e;
    }

    const contenido = datos && datos.choices && datos.choices[0];
    const parte = contenido && contenido.message && contenido.message.content;
    if (!parte) {
      const e = new Error('Groq no devolvio contenido.');
      e.codigo = 502;
      throw e;
    }

    let lista;
    try {
      lista = JSON.parse(parte).puntosDeVenta;
    } catch (e) {
      lista = null;
    }

    if (!Array.isArray(lista) || !lista.length) {
      const e = new Error('Groq no devolvio argumentos utilizables.');
      e.codigo = 502;
      throw e;
    }

    return lista.map((p) => String(p).trim()).filter(Boolean).slice(0, 3);
  } catch (e) {
    if (e.codigo) throw e;
    const fallo = new Error(
      e.name === 'AbortError'
        ? 'Groq tardo demasiado. Intenta de nuevo.'
        : 'No se pudo contactar a Groq.'
    );
    fallo.codigo = 502;
    throw fallo;
  } finally {
    clearTimeout(temporizador);
  }
}

module.exports = {
  argumentosDeVenta: argumentosDeVenta,
  habilitado: habilitado,
  modelo: modelo,
};