'use strict';

// Fuente PRINCIPAL de ficha tecnica: dataset abierto de especificaciones
// alojado en GitHub. Son datos ya estructurados (no hay que limpiar HTML),
// con apertura por lente, zoom optico, imagen y enlaces de origen.
//
// Si el modelo no aparece se cae al scraper de src/specs.js. Entre las dos
// cubren practicamente todo.
//
// Resolucion del archivo: categoria + marca + anio + slug.
//   - La categoria decide la carpeta: smartphone, tablet o laptop.
//   - La marca se detecta por sinonimos, porque en una tienda los
//     productos vienen por linea y no por marca: "REDMI A7 64/4" es
//     Xiaomi, "BLACK SHARK" es Nubia, "POVA" es Tecno, "PAD 7" es Xiaomi,
//     "TAB A9" es Samsung.
//   - El slug se adivina quitando primero los sufijos de memoria y
//     almacenamiento (256/8, 512GB, 8.7"), y despues los modificadores
//     del final (PRO, MAX, 5G, +...). Se generan varias candidatas, de la
//     mas especifica a la mas corta.
//
// Se prueban primero los intentos directos contra raw.githubusercontent.com,
// que no tiene rate limit. Solo si fallan todos se usa la API de GitHub
// para listar el directorio, y ahi se respeta un presupuesto local de
// peticiones por hora porque el limite sin token es de 60.

const REPO = process.env.DATASET_REPO || 'GetTechAPI/TechAPI';
const REF = process.env.DATASET_REF || 'develop';
const API_BASE = 'https://api.github.com/repos/' + REPO + '/contents/data';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/data';

const TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const TIMEOUT_MS = 20000;
const ANIOS_REVISAR = 13;
const PRESUPUESTO_API_POR_HORA = Number(process.env.DATASET_API_POR_HORA) || 45;

const CATEGORIAS = ['smartphone', 'tablet', 'laptop'];

// Orden importa: se evalua de arriba hacia abajo y gana la primera
// marca que coincida.
const MARCAS = [
  ['apple', ['iphone', 'ipad', 'macbook', 'mac book', 'ipod']],
  ['xiaomi', ['redmi pad', 'xiaomi pad', 'redmi', 'poco', 'xiaomi', 'mi pad']],
  ['nubia', ['black shark', 'redmagic', 'red magic', 'nubia']],
  ['tecno', ['pova', 'tecno', 'camon', 'spark']],
  ['samsung', ['samsung', 'galaxy', 'tab']],
  ['honor', ['honor']],
  ['motorola', ['motorola', 'moto', 'moto g']],
  ['realme', ['realme']],
  ['infinix', ['infinix']],
  ['cubot', ['cubot']],
  ['zte', ['zte', 'nubia z']],
  ['tcl', ['tcl']],
  ['meizu', ['meizu']],
  ['oppo', ['oppo', 'find x']],
  ['oneplus', ['oneplus', 'one plus']],
  ['vivo', ['vivo', 'iqoo']],
  ['itel', ['itel']],
  ['google', ['pixel', 'google']],
  ['nokia', ['nokia']],
  ['lg', ['lg']],
  ['sony', ['sony', 'xperia']],
  ['htc', ['htc']],
  ['alcatel', ['alcatel']],
  ['nothing', ['nothing phone', 'nothing']],
  ['blackberry', ['blackberry']],
  ['lenovo', ['lenovo', 'ideapad', 'thinkpad', 'legion']],
  ['asus', ['asus', 'zenfone', 'rog phone']],
  ['hmd', ['hmd', 'nokia g', 'nokia c']],
  ['hmd', ['nokia']],
  ['asus', ['transcend']],
  ['tough', ['tough']],
  ['xiaomi', ['pad']],
  ['infinix', ['hot', 'smart', 'zero', 'note 30', 'note 40']],
];

// Palabras que se pueden quitar del final del nombre sin romper la
// identidad del modelo. "NOTE" NO va aqui: "Redmi Note 15" es el nombre.
const MODIFICADORES = new Set([
  'pro+', 'pro', 'max', 'ultra', 'mini', 'plus', '5g', '4g', '3g',
  'wifi', 'chip', 'fusion', 'air', 'new', 'global', 'dual', 'sim',
  'refresh', 'prime', 'neo', 'gt', 'se',
]);

const cacheFicha = new Map();
const cacheDir = new Map();
let apiUsadas = 0;
let apiVentana = Date.now();

function habilitado() {
  return true;
}

function norm(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizar(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clave(modelo) {
  return normalizar(modelo);
}

function unicos(lista) {
  const vistos = new Set();
  const salida = [];
  for (const v of lista) {
    if (!v) continue;
    if (vistos.has(v)) continue;
    vistos.add(v);
    salida.push(v);
  }
  return salida;
}

/**
 * "REDMI A7 64/4" -> "redmi a7"
 * "TAB A11 8.7 WIFI 64/4" -> "tab a11"
 * "IPAD AIR 11 M4 256" -> "ipad air 11 m4"
 */
function limpiarSufijos(texto) {
  return String(texto || '')
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*(gb|tb|mb)\b/g, ' ')
    .replace(/\b\d+[.,]\d+\b/g, ' ')
    .replace(/\b\d+\s*(inch|pulg|pol)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function palabraEnTexto(texto, palabra) {
  const t = String(texto || '');
  const p = String(palabra || '');
  if (!p) return false;
  if (t === p) return true;
  const i = t.indexOf(p);
  if (i < 0) return false;
  const antes = i === 0 ? ' ' : t.charAt(i - 1);
  const despues = i + p.length >= t.length ? ' ' : t.charAt(i + p.length);
  return /[\s]/.test(antes) && /[\s]/.test(despues);
}

function detectarCategoria(texto) {
  const n = normalizar(texto);
  if (palabraEnTexto(n, 'macbook') || palabraEnTexto(n, 'notebook') ||
      palabraEnTexto(n, 'laptop') || palabraEnTexto(n, 'ideapad') ||
      palabraEnTexto(n, 'thinkpad') || palabraEnTexto(n, 'chromebook')) {
    return 'laptop';
  }
  if (palabraEnTexto(n, 'ipad') || palabraEnTexto(n, 'tab') ||
      palabraEnTexto(n, 'pad') || palabraEnTexto(n, 'matepad')) {
    return 'tablet';
  }
  return 'smartphone';
}

function detectarMarca(texto) {
  const n = normalizar(texto);
  for (const par of MARCAS) {
    for (const alias of par[1]) {
      if (palabraEnTexto(n, alias)) return par[0];
    }
  }
  return '';
}

function quitarMarca(texto, marca) {
  const n = normalizar(texto);
  if (!marca) return n;
  for (const par of MARCAS) {
    if (par[0] !== marca) continue;
    for (const alias of par[1]) {
      if (palabraEnTexto(n, alias)) {
        return n.replace(alias, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  if (n.indexOf(marca + ' ') === 0) {
    return n.slice(marca.length + 1).trim();
  }
  return n;
}

function aniosPosibles() {
  const actual = new Date().getFullYear();
  const lista = [];
  for (let i = 0; i < ANIOS_REVISAR; i++) lista.push(String(actual - i));
  return lista;
}

function anioEnElNombre(texto) {
  const m = normalizar(texto).match(/\b(20[0-2][0-9])\b/);
  return m ? m[1] : null;
}

/**
 * Escala de candidatas, de la mas especifica a la mas corta:
 *   "REDMI NOTE 15 PRO + 5G 256/8"
 *     -> redmi-note-15-pro-5g
 *     -> redmi-note-15-pro
 *     -> redmi-note-15
 */
function adivinarSlugs(modelo, marca) {
  const crudo = normalizar(modelo);
  const limpio = limpiarSufijos(crudo) || crudo;

  const raices = unicos([quitarMarca(limpio, marca), limpio, crudo].filter(Boolean));
  const salida = [];

  for (const raiz of raices) {
    salida.push(norm(raiz));

    const partes = raiz.split(' ').filter(Boolean);
    for (let i = partes.length; i >= 1; i--) {
      const ultimo = String(partes[i - 1]).replace(/\+/g, '');
      if (!MODIFICADORES.has(ultimo)) continue;
      const resto = partes.slice(0, i - 1);
      if (resto.length) salida.push(norm(resto.join(' ')));
    }
  }

  return unicos(salida);
}

async function pedirJson(url, cabeceras) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: cabeceras || {}, redirect: 'follow', signal: controlador.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

function gastarApi() {
  const ahora = Date.now();
  if (ahora - apiVentana > 3600000) {
    apiVentana = ahora;
    apiUsadas = 0;
  }
  if (apiUsadas >= PRESUPUESTO_API_POR_HORA) return false;
  apiUsadas++;
  return true;
}

function cabecerasApi() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'moon-erp' };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}

async function fetchSpec(categoria, marca, anio, slug) {
  return pedirJson(RAW_BASE + '/' + categoria + '/' + marca + '/' + anio + '/' + slug + '.json', {});
}

async function buscarEnDirectorio(categoria, marca, slugs) {
  if (!gastarApi()) return null;

  const raiz = await pedirJson(API_BASE + '/' + categoria + '/' + marca, cabecerasApi());
  if (!Array.isArray(raiz)) return null;

  const anios = raiz
    .filter((e) => e && e.type === 'dir' && /^\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(b) - Number(a));

  for (const anio of anios) {
    const k = categoria + '/' + marca + '/' + anio;
    if (cacheDir.has(k)) continue;
    if (!gastarApi()) return null;
    const archivos = await pedirJson(API_BASE + '/' + categoria + '/' + marca + '/' + anio, cabecerasApi());
    cacheDir.set(k, Array.isArray(archivos) ? archivos : []);
  }

  for (const anio of anios) {
    const archivos = cacheDir.get(categoria + '/' + marca + '/' + anio) || [];
    for (const archivo of archivos) {
      if (!archivo || archivo.type !== 'file') continue;
      const slug = String(archivo.name).replace(/\.json$/i, '');
      for (const buscado of slugs) {
        if (slug === buscado || slug.indexOf(buscado) === 0 || buscado.indexOf(slug) === 0) {
          const spec = await fetchSpec(categoria, marca, anio, slug);
          if (spec) return spec;
        }
      }
    }
  }
  return null;
}

function prettifySoc(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((p) => (/^\d+$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ETIQUETA_CAMARA = {
  main: 'Principal',
  selfie: 'Frontal',
  ultrawide: 'Ultra gran angular',
  telephoto: 'Tele',
  macro: 'Macro',
  depth: 'Profundidad',
};

function mapear(json) {
  if (!json || typeof json !== 'object' || !json.name) return null;

  const d = json.display || {};

  const pantalla = [
    d.type,
    d.size_inch ? d.size_inch + '"' : '',
    d.resolution ? d.resolution + ' px' : '',
    d.refresh_hz ? d.refresh_hz + ' Hz' : '',
    d.brightness_nits ? d.brightness_nits + ' nits' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const camaras = (json.cameras || [])
    .map((c) => {
      const partes = [];
      if (c.mp) partes.push(c.mp + ' MP');
      if (c.aperture) partes.push('f/' + c.aperture);
      if (c.ois) partes.push('OIS');
      if (c.optical_zoom) partes.push(c.optical_zoom + 'x optico');
      if (c.sensor) partes.push('sensor ' + c.sensor);
      const texto = partes.join(', ');
      const etiqueta = ETIQUETA_CAMARA[c.type] || c.type || '';
      return texto ? (etiqueta ? etiqueta + ': ' : '') + texto : '';
    })
    .filter(Boolean)
    .join(' | ');

  const carga = [
    json.charging_wired_w ? json.charging_wired_w + ' W con cable' : '',
    json.charging_wireless_w ? json.charging_wireless_w + ' W inalambrico' : '',
    json.charging_wireless ? 'carga inalambrica' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const almacen =
    Array.isArray(json.storage_options_gb) && json.storage_options_gb.length
      ? json.storage_options_gb.join(' / ') + ' GB'
      : '';

  const memoria = [
    json.ram_gb ? json.ram_gb + ' GB RAM' : '',
    almacen ? almacen + ' almacenamiento' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const c = json.connectivity || {};
  const conectividad = [
    c.network || '',
    c.wifi ? 'Wi-Fi: ' + c.wifi : '',
    c.bluetooth ? 'Bluetooth: ' + c.bluetooth : '',
    c.nfc === true ? 'NFC' : c.nfc ? 'NFC: ' + c.nfc : '',
    c.usb ? 'USB: ' + c.usb : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const sistema = [json.os, json.os_version].filter(Boolean).join(' ');
  const ip = json.ip_rating ? 'IP' + String(json.ip_rating).replace(/^IP/i, '') : '';

  const partesResumen = [];
  if (json.soc) partesResumen.push(prettifySoc(json.soc));
  if (d.size_inch) partesResumen.push('pantalla ' + d.size_inch + '"');
  if (json.battery_mah) partesResumen.push(json.battery_mah + ' mAh');
  if (json.cameras && json.cameras[0] && json.cameras[0].mp) {
    partesResumen.push('camara ' + json.cameras[0].mp + ' MP');
  }
  if (json.ram_gb) partesResumen.push(json.ram_gb + ' GB RAM');
  if (almacen) partesResumen.push(almacen);

  const marca = String(json.brand || '')
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');

  return {
    nombre: (marca ? marca + ' ' : '') + json.name,
    marca: marca,
    procesador: json.soc ? prettifySoc(json.soc) : '',
    pantalla: pantalla,
    camaras: camaras,
    bateria: json.battery_mah ? json.battery_mah + ' mAh' : '',
    carga: carga,
    ramAlmacenamiento: memoria,
    conectividad: [conectividad, ip].filter(Boolean).join(' · '),
    sistema: sistema,
    resumen: partesResumen.join(', ') + '.',
    imagenUrl: json.image_url || '',
    releaseDate: json.release_date || '',
    verificado: json.verified === true,
    fuentes: Array.isArray(json.source_urls) ? json.source_urls.slice(0, 3) : [],
    fuenteDatos: 'dataset',
  };
}

async function buscarFicha(modelo) {
  const k = clave(modelo);
  if (!k) {
    const e = new Error('Indica el modelo a consultar.');
    e.codigo = 400;
    throw e;
  }

  const guardado = cacheFicha.get(k);
  if (guardado) return { ficha: guardado.ficha, cache: true };

  const marca = detectarMarca(modelo);
  if (!marca) return null;

  const slugs = adivinarSlugs(modelo, marca);
  if (!slugs.length) return null;

  const categoriaDetectada = detectarCategoria(modelo);
  const categorias = unicos([categoriaDetectada].concat(CATEGORIAS));

  const anios = aniosPosibles();
  const anio = anioEnElNombre(modelo);
  if (anio) {
    const i = anios.indexOf(anio);
    if (i > 0) {
      anios.splice(i, 1);
      anios.unshift(anio);
    }
  }

  // 1) Intentos directos (raw, sin limite).
  for (const categoria of categorias) {
    for (const slug of slugs) {
      for (const a of anios) {
        const json = await fetchSpec(categoria, marca, a, slug);
        if (!json) continue;
        const ficha = mapear(json);
        if (ficha) {
          cacheFicha.set(k, { ficha: ficha });
          return { ficha: ficha, cache: false };
        }
      }
    }
  }

  // 2) Listar directorios (presupuesto local por hora).
  for (const categoria of categorias) {
    const json = await buscarEnDirectorio(categoria, marca, slugs);
    if (!json) continue;
    const ficha = mapear(json);
    if (!ficha) continue;
    cacheFicha.set(k, { ficha: ficha });
    return { ficha: ficha, cache: false };
  }

  return null;
}

module.exports = {
  habilitado: habilitado,
  buscarFicha: buscarFicha,
  mapear: mapear,
  detectarMarca: detectarMarca,
  detectarCategoria: detectarCategoria,
  adivinarSlugs: adivinarSlugs,
  limpiarSufijos: limpiarSufijos,
};