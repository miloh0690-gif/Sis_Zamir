'use strict';

const MODELO = (process.env.GEMINI_MODEL || 'gemini-3.5-flash').trim();
const LIMITE_POR_MIN = Math.max(1, Number(process.env.AI_RATE_LIMIT_POR_MIN) || 6);
const VIGENCIA_CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 30000;

const ESQUEMA = {
  type: 'object',
  properties: {
    nombre: { type: 'string' },
    marca: { type: 'string' },
    procesador: { type: 'string' },
    pantalla: { type: 'string' },
    camaras: { type: 'string' },
    bateria: { type: 'string' },
    carga: { type: 'string' },
    ramAlmacenamiento: { type: 'string' },
    conectividad: { type: 'string' },
    sistema: { type: 'string' },
    resumen: { type: 'string' },
    puntosDeVenta: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'string' },
    },
  },
  required: [
    'nombre',
    'marca',
    'procesador',
    'pantalla',
    'camaras',
    'bateria',
    'carga',
    'ramAlmacenamiento',
    'conectividad',
    'sistema',
    'resumen',
    'puntosDeVenta',
  ],
};

const cache = new Map();
const golpes = new Map();

function claveNormalizada(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function habilitado() {
  return Boolean((process.env.GEMINI_API_KEY || '').trim());
}

function consumirCupo(ip) {
  const ahora = Date.now();
  const ventana = ahora - 60000;
  const lista = (golpes.get(ip) || []).filter((t) => t > ventana);
  if (lista.length >= LIMITE_POR_MIN) {
    golpes.set(ip, lista);
    return { permitido: false, faltan: Math.ceil((lista[0] + 60000 - ahora) / 1000) };
  }
  lista.push(ahora);
  golpes.set(ip, lista);
  return { permitido: true };
}

function limpiarGolpes() {
  const ventana = Date.now() - 60000;
  for (const [ip, lista] of golpes) {
    const filtrada = lista.filter((t) => t > ventana);
    if (filtrada.length === 0) golpes.delete(ip);
    else golpes.set(ip, filtrada);
  }
}

setInterval(limpiarGolpes, 60000).unref();

function construirPrompt(modelo) {
  return [
    'Eres un asesor tecnico experto en telefonia movil.',
    'Devuelve solo informacion verificable del modelo exacto. No inventes datos.',
    'Si un dato no lo conoces con certeza, escribe "No verificado" en ese campo.',
    'Responde en espanol, de forma breve y comercial, usando el esquema indicado.',
    '',
    'Modelo consultado: "' + modelo + '"',
    '',
    'Reglas para los 3 argumentos de venta:',
    '- Deben ser concretos y verificables, porque el cliente compara marcas.',
    '- Cada argumento en una frase corta.',
    '- Nada de afirmaciones vacias como "gran camara" o "mucha bateria" sin numeros.',
    '- Si el modelo no existe o es ambiguo, indicalo en el campo resumen.',
  ].join('\n');
}

async function consultarFicha(modelo) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(MODELO) +
    ':generateContent';

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  try {
    const respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controlador.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: construirPrompt(modelo) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: ESQUEMA,
        },
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
      const error = new Error(
        (datos && datos.error && datos.error.message) || 'Gemini respondio HTTP ' + respuesta.status
      );
      error.codigo = 502;
      throw error;
    }

    const candidato = datos && datos.candidates && datos.candidates[0];
    const partes = candidato && candidato.content && candidato.content.parts;
    const bruto = partes && partes[0] && partes[0].text;
    if (!bruto) {
      const error = new Error('Gemini no devolvio contenido para ese modelo.');
      error.codigo = 502;
      throw error;
    }

    return JSON.parse(bruto);
  } catch (e) {
    if (e.codigo) throw e;
    const error = new Error(
      e.name === 'AbortError'
        ? 'La consulta a la IA tardo demasiado. Intenta de nuevo.'
        : 'No se pudo consultar la IA. Revisa la configuracion de GEMINI_API_KEY.'
    );
    error.codigo = 502;
    throw error;
  } finally {
    clearTimeout(temporizador);
  }
}

async function fichaTecnica(modelo, ip) {
  if (!habilitado()) {
    const error = new Error('La consulta con IA no esta habilitada todavia (falta GEMINI_API_KEY).');
    error.codigo = 503;
    throw error;
  }

  const cuota = consumirCupo(ip);
  if (!cuota.permitido) {
    const error = new Error('Demasiadas consultas seguidas. Espera ' + cuota.faltan + ' segundos.');
    error.codigo = 429;
    throw error;
  }

  const clave = claveNormalizada(modelo);
  const guardado = cache.get(clave);
  if (guardado && Date.now() - guardado.fecha < VIGENCIA_CACHE_MS) {
    return { datos: guardado.datos, cache: true };
  }

  const datos = await consultarFicha(modelo);
  cache.set(clave, { datos, fecha: Date.now() });
  return { datos, cache: false };
}

module.exports = { fichaTecnica, habilitado, modelo: MODELO, claveNormalizada };