'use strict';

// Fuente de ficha por BUSQUEDA en el espejo de GSMArena.
//
// Existe porque src/specs.js solo probaba /phone?name= con el nombre tal
// cual viene de la tienda, y ahi casi nunca hay coincidencia exacta: la base
// guarda el nombre como lo escribe GSMArena, con la marca y la serie
// separadas. Medido 2026-10-03:
//
//   "SAMSUNG A06"      -> 0 resultados   |  "Samsung Galaxy A06" -> 2
//   "MOTOROLA G06"    -> 0 resultados   |  "Motorola Moto G06"  -> 2
//   "POCO X8 PRO"      -> 0 resultados   |  "Xiaomi Poco X8 Pro" -> 2
//
// Ademas el fallback de specs.js pasaba el slug a /phone?name=, y ese
// endpoint acepta el NOMBRE: con el slug responde 404 siempre. Por eso la
// via de busqueda de specs.js no encontraba nada.
//
// A diferencia de la ficha con IA (src/iaficha.js), esto son DATOS: la
// misma verificacion por tokens de identidad de src/modelo.js se sigue
// aplicando en ficha.js antes de devolverlo.

const URL_BASE = String(
  process.env.SPECS_API_URL || 'https://mobile-specs-api-sandy.vercel.app'
)
  .trim()
  .replace(/\/+$/, '');

const TIMEOUT_MS = 25000;
const CACHE_MS = 12 * 60 * 60 * 1000;

const specs = require('./specs');
const modelo = require('./modelo');

const cache = new Map();

// El nombre oficial depende de la marca: Samsung mete "Galaxy", Motorola
// escribe "Moto", Apple usa "iPhone", y los plegables van "Z Fold5" con el
// numero PEGADO al nombre ("Fold 5" no coincide).
const PREFIJOS = {
  samsung: 'samsung galaxy ',
  tab: 'samsung galaxy tab ',
  moto: 'motorola moto ',
  motorola: 'motorola ',
  iphone: 'apple iphone ',
  ipad: 'apple ipad ',
  macbook: 'apple macbook ',
  redmi: 'xiaomi redmi ',
  xiaomi: 'xiaomi ',
  poco: 'xiaomi poco ',
  honor: 'honor ',
  realme: 'realme ',
  infinix: 'infinix ',
  tecno: 'tecno ',
  spark: 'tecno spark ',
  pova: 'tecno pova ',
  zte: 'zte ',
  tcl: 'tcl ',
  meizu: 'meizu ',
  cubot: 'cubot ',
  oneplus: 'oneplus ',
  oppo: 'oppo ',
  vivo: 'vivo ',
  nokia: 'nokia ',
  itel: 'itel ',
  google: 'google pixel ',
  nubia: 'nubia ',
};

// Marca del nombre de la tienda -> prefijos oficiales a probar.
const DETECTAR = [
  [/^samsung\s+sh\s+/, ['samsung']],
  [/^samsung\s+/, ['samsung']],
  [/^tab\s+/, ['tab', 'samsung']],
  [/^redmi\s+/, ['redmi']],
  [/^poco\s+/, ['poco']],
  [/^xiaomi\s+/, ['xiaomi']],
  [/^motorola\s+/, ['motorola', 'moto']],
  [/^moto\s+/, ['moto']],
  [/^iphone\s+/, ['iphone']],
  [/^ipad\s+/, ['ipad']],
  [/^macbook\s+/, ['macbook']],
  [/^honor\s+/, ['honor']],
  [/^realme\s+/, ['realme']],
  [/^infinix\s+/, ['infinix']],
  [/^tecno\s+(pova|spark|camon)/, ['tecno']],
  [/^pova\s+/, ['pova']],
  [/^spark[a-z]*\s+/, ['spark']],
  [/^zte\s+/, ['zte']],
  [/^tcl\s+/, ['tcl']],
  [/^meizu\s+/, ['meizu']],
  [/^cubot\s+/, ['cubot']],
  [/^oneplus\s+/, ['oneplus']],
  [/^oppo\s+/, ['oppo']],
  [/^vivo\s+/, ['vivo']],
  [/^iqoo\s+/, ['vivo']],
  [/^nokia\s+/, ['nokia']],
  [/^itel\s+/, ['itel']],
  [/^pixel\s+/, ['google']],
  [/^black\s+shark\s+/, ['nubia']],
  [/^red\s*magic\s+/, ['nubia']],
];

// Palabras que describen la unidad concreta, no el modelo.
const RUIDO = new Set(
  ('chip esim wifi wificnp np homo homogenizado vietnam arabe original nuevo ' +
   'importado sri lanka global dual sim dual sim sh lila blanco negra negro azul ' +
   'caja grande premium edicion m1 m2 m3 m4 m5 gen lamborghini ' +
   '5g 4g 3g lte td new').split(' ')
);

function sinAcentos(t) {
  return String(t === undefined || t === null ? '' : t)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizar(texto) {
  return sinAcentos(texto).replace(/\s+/g, ' ').trim();
}

/**
 * El nucleo del nombre de la tienda, sin memoria ni relleno:
 * "SAMSUNG SH S22+ 256/13" -> "s22+"
 */
function nucleo(texto) {
  let t = String(texto === undefined || texto === null ? '' : texto);
  t = t.replace(/(\d+)\s*\/\s*\d+\b/g, ' ');
  t = t.replace(/\b\d+\s*(gb|tb)\b/gi, ' ');
  t = t.replace(/\b\d+[.,]\d+\b/g, ' ');
  t = normalizar(t);

  const palabras = t.split(' ').filter(Boolean);
  let i = 0;

  // fuera la marca y sus series ("samsung sh ", "tab ", "moto ")
  const unido = palabras.join(' ') + ' ';
  for (const par of DETECTAR) {
    const m = par[0].exec(unido);
    if (!m) continue;
    i = m[0].split(' ').length;
    break;
  }

  const salida = [];
  for (let j = i; j < palabras.length; j++) {
    const p = palabras[j];
    if (!RUIDO.has(p)) salida.push(p);
  }

  // Numeros sueltos al final que no son parte del modelo:
  //   "g06 4"    -> RAM de 4 GB
  //   "iphone 17 pro max 256" -> 256 GB de almacenamiento
  // Se quitan SOLO si queda otro token con digito que siga identificando.
  // Para "ipad air 11" el 11 no se toca: es lo unico que lo distingue de un
  // iPad Air de 2013.
  while (salida.length > 1 && /^[0-9]+$/.test(salida[salida.length - 1])) {
    const n = Number(salida[salida.length - 1]);
    const esRam = n <= 16;
    const esAlmacenamiento = n >= 32;
    if (!esRam && !esAlmacenamiento) break;
    let conDigito = false;
    for (let j = 0; j < salida.length - 1; j++) if (/[0-9]/.test(salida[j])) conDigito = true;
    if (!conDigito) break;
    salida.pop();
  }

  return salida.join(' ');
}

function oficial(marca, base) {
  let t = normalizar(base);
  if (!t) return '';

  // "z fold 5" -> "z fold5" (el numero va pegado en GSMArena)
  t = t.replace(/^z\s*fold\s*(\d+)/, 'z fold$1');
  t = t.replace(/^z\s*flip\s*(\d+)/, 'z flip$1');
  // "galaxy ..." se agrega despues con el prefijo
  t = t.replace(/^galaxy\s+/, '');

  const pre = PREFIJOS[marca];
  if (pre === undefined) return '';
  return (pre + t).trim();
}

function consultas(modelo) {
  const base = nucleo(modelo);
  if (!base) return [];

  const salida = [base];
  const anadir = (t) => {
    const v = normalizar(t);
    if (v && salida.indexOf(v) === -1) salida.push(v);
  };

  for (const par of DETECTAR) {
    if (!par[0].test(normalizar(modelo) + ' ')) continue;
    for (const marca of par[1]) anadir(oficial(marca, base));
  }

  return salida;
}

async function pedirJson(url) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controlador.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * /phone?name= acepta el NOMBRE del equipo. Con el slug responde 404.
 * Este detalle era el que hacia inutil el fallback de busqueda.
 */
async function porNombre(nombre) {
  const url = URL_BASE + '/phone?name=' + encodeURIComponent(nombre);
  return pedirJson(url);
}

async function buscar(modeloTexto) {
  const k = normalizar(modeloTexto);
  if (!k) return null;
  if (!URL_BASE) return null;

  const guardado = cache.get(k);
  if (guardado && Date.now() - guardado.fecha < CACHE_MS) {
    return { ficha: guardado.ficha, cache: true, fuente: 'gsm-busqueda' };
  }

  const lista = consultas(modeloTexto);
  if (!lista.length) return null;

  for (const consulta of lista) {
    let bruto = await porNombre(consulta);
    if (!bruto || bruto.status !== true || !bruto.data) {
      const busqueda = await pedirJson(URL_BASE + '/search?query=' + encodeURIComponent(consulta));
      if (busqueda && busqueda.status === true && Array.isArray(busqueda.data) && busqueda.data.length) {
        const elegido = busqueda.data[0];
        const nombreReal = elegido.name || elegido.slug;
        if (nombreReal) bruto = await porNombre(nombreReal);
      }
    }
    if (!bruto || bruto.status !== true || !bruto.data) continue;

    const ficha = specs.mapear(bruto, consulta);
    if (!ficha) continue;

    // Mismo gate que el resto: si el nombre devuelto no es el modelo
    // pedido, se sigue probando con la siguiente variante.
    if (modelo.verificar(modeloTexto, ficha.nombre)) continue;

    const salida = { ficha: ficha, cache: false, fuente: 'gsm-busqueda' };
    cache.set(k, { ficha: ficha, fecha: Date.now() });
    return salida;
  }

  return null;
}

module.exports = {
  buscar: buscar,
  consultas: consultas,
  nucleo: nucleo,
  oficial: oficial,
  habilitado: function () {
    return Boolean(URL_BASE);
  },
};