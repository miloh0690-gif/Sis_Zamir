'use strict';

// Fuente PRINCIPAL de ficha tecnica: dataset abierto de especificaciones
// alojado en GitHub. Datos ya estructurados (no hay que limpiar HTML),
// con apertura por lente, zoom optico, imagen y enlaces de origen.
//
// Se intenta primero esta, y si el modelo no aparece se cae al scraper
// de src/specs.js. Entre las dos cubren practicamente todo.
//
// Resolucion del archivo: marca + anio + slug. Se adivina el slug a
// partir del nombre que escribe el vendedor y se prueban los anos
// recientes. raw.githubusercontent.com no tiene rate limit de API, asi
// que los intentos fallidos son baratos. Solo si eso no basta se usa la
// API de GitHub (que si tiene limite) para listar el directorio, y ahi
// hace falta GITHUB_TOKEN para no agotar las 60 peticiones/hora.

const REPO = 'GetTechAPI/TechAPI';
const REF = process.env.DATASET_REF || 'develop';
const API_BASE = 'https://api.github.com/repos/' + REPO + '/contents/data/smartphone';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/data/smartphone';

const TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const TIMEOUT_MS = 20000;
const ANIOS_REVISAR = 12;

const MARCAS = {
  apple: ['apple', 'iphone', 'ipad'],
  samsung: ['samsung', 'galaxy'],
  xiaomi: ['xiaomi', 'redmi', 'poco'],
  huawei: ['huawei', 'nova ', 'p smart', 'mate '],
  honor: ['honor'],
  motorola: ['motorola', 'moto'],
  oppo: ['oppo'],
  realme: ['realme'],
  oneplus: ['oneplus', 'one plus'],
  nokia: ['nokia'],
  vivo: ['vivo'],
  infinix: ['infinix'],
  tecno: ['tecno', 'camon'],
  itel: ['itel'],
  asus: ['asus', 'zenfone', 'rog'],
  google: ['google', 'pixel'],
  zte: ['zte', 'nubia'],
  lg: ['lg'],
  sony: ['sony', 'xperia'],
  htc: ['htc'],
  alcatel: ['alcatel'],
  nothing: ['nothing'],
  blackberry: ['blackberry'],
  meizu: ['meizu'],
  lenovo: ['lenovo'],
  tcl: ['tcl'],
  hmd: ['hmd'],
};

const cacheFicha = new Map();
const cacheDir = new Map();

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
    .replace(/\s+/g, ' ')
    .trim();
}

function clave(modelo) {
  return normalizar(modelo);
}

function aniosPosibles() {
  const actual = new Date().getFullYear();
  const lista = [];
  for (let i = 0; i < ANIOS_REVISAR; i++) lista.push(String(actual - i));
  return lista;
}

function detectarMarca(texto) {
  const n = normalizar(texto);
  for (const marca of Object.keys(MARCAS)) {
    for (const alias of MARCAS[marca]) {
      const a = alias.trim();
      if (n === a || n.indexOf(a + ' ') === 0) return marca;
    }
  }
  return '';
}

function anioEnElNombre(texto) {
  const m = normalizar(texto).match(/\b(20[0-2][0-9])\b/);
  return m ? m[1] : null;
}

function adivinarSlugs(modelo, marca) {
  const n = normalizar(modelo);
  const completo = norm(n);

  let sinMarca = completo;
  if (marca && n.indexOf(marca + ' ') === 0) {
    sinMarca = norm(n.slice(marca.length + 1));
  }

  const candidatos = [sinMarca, completo];

  const anio = anioEnElNombre(n);
  if (anio) {
    candidatos.push(norm(n.replace(anio, ' ')));
  }

  return candidatos
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

async function pedir(url, cabeceras) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: cabeceras, signal: controlador.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

function cabecerasApi() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'moon-erp' };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}

async function fetchSpec(marca, anio, slug) {
  return pedir(RAW_BASE + '/' + marca + '/' + anio + '/' + slug + '.json', {});
}

/**
 * Ultimo recurso: listar el directorio del ano con la API de GitHub y
 * buscar el slug por similitud. Necesita GITHUB_TOKEN para no gastar el
 * limite de 60 peticiones/hora sin token.
 */
async function buscarEnDirectorio(marca, slugs) {
  const anios = await pedir(API_BASE + '/' + marca, cabecerasApi());
  if (!Array.isArray(anios)) return null;

  const dirs = anios
    .filter((e) => e && e.type === 'dir' && /^\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(b) - Number(a));

  for (const anio of dirs) {
    const k = marca + '/' + anio;
    if (cacheDir.has(k)) continue;
    const archivos = await pedir(API_BASE + '/' + anio, cabecerasApi());
    cacheDir.set(k, Array.isArray(archivos) ? archivos : []);
  }

  for (const anio of dirs) {
    const archivos = cacheDir.get(marca + '/' + anio) || [];
    for (const archivo of archivos) {
      if (!archivo || archivo.type !== 'file') continue;
      const slug = String(archivo.name).replace(/\.json$/i, '');
      for (const buscado of slugs) {
        if (slug === buscado || slug.indexOf(buscado) === 0 || buscado.indexOf(slug) === 0) {
          const spec = await fetchSpec(marca, anio, slug);
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

  const anios = aniosPosibles();
  const anio = anioEnElNombre(modelo);
  if (anio) {
    const i = anios.indexOf(anio);
    if (i > 0) {
      anios.splice(i, 1);
      anios.unshift(anio);
    }
  }

  // 1) Adivinar slug y barrer anios (raw, sin limite de API).
  for (const slug of slugs) {
    for (const a of anios) {
      const json = await fetchSpec(marca, a, slug);
      if (!json) continue;
      const ficha = mapear(json);
      if (ficha) {
        cacheFicha.set(k, { ficha: ficha });
        return { ficha: ficha, cache: false };
      }
    }
  }

  // 2) Listar el directorio y buscar por similitud (necesita token).
  if (!TOKEN) return null;

  const json = await buscarEnDirectorio(marca, slugs);
  if (!json) return null;
  const ficha = mapear(json);
  if (!ficha) return null;

  cacheFicha.set(k, { ficha: ficha });
  return { ficha: ficha, cache: false };
}

module.exports = {
  habilitado: habilitado,
  buscarFicha: buscarFicha,
  mapear: mapear,
  detectarMarca: detectarMarca,
  adivinarSlugs: adivinarSlugs,
};