'use strict';

// Fuente PRINCIPAL de ficha tecnica: dataset abierto de especificaciones
// alojado en GitHub. Son datos ya estructurados (no hay que limpiar HTML),
// con apertura por lente, zoom optico, imagen y enlaces de origen.
//
// El problema: los productos de la tienda se llaman "IPHONE 17 PRO 256
// CHIP" y "REDMI NOTE 15 PRO 5G 512/8". Ese nombre no existe en el
// dataset, y ademas los archivos del dataset tienen nombres imposibles de
// adivinar ("xiaomi-redmi-a7-4g-3gb-64gb-4g-lte"). Adivinar el nombre
// daba 1 de 40 aciertos.
//
// La solucion es INDEXAR la marca. Con un arbol recursivo por marca hacen
// falta solo 2 llamadas (una para localizar la carpeta de la marca y otra
// para el arbol completo), no 14, y se cachean en memoria. Luego se busca
// por tokens completos, sin comparar subcadenas: comparar subcadenas hace
// que "17" case dentro de "10176" y "redmi 17" devuelva el Redmi 9.
//
// Se intenta primero el nombre directo contra raw.githubusercontent.com,
// que no tiene limite. El indice solo se construye si eso no basta.

const REPO = process.env.DATASET_REPO || 'GetTechAPI/TechAPI';
const REF = process.env.DATASET_REF || 'develop';
const API_GIT = 'https://api.github.com/repos/' + REPO + '/git/trees/';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/data';

const TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const TIMEOUT_MS = 25000;
const ANIOS_REVISAR = 13;
const PRESUPUESTO_API_POR_HORA = Number(process.env.DATASET_API_POR_HORA) || 900;

const CATEGORIAS = ['smartphone', 'tablet', 'laptop'];

// Palabras que describen la unidad concreta y no el modelo.
const RUIDO_ARCHIVO = new Set([
  'scrapegsma', 'gsma', 'global', 'dual', 'sim', 'lte', 'td', 'new',
  '3g', '4g', '5g', '3gb', '4gb', '6gb', '8gb', '12gb', '16gb', '32gb',
  '64gb', '128gb', '256gb', '512gb', '1tb', '2tb', 'ram', 'rom', 'ch',
]);

// Modificadores del final: se prueban con y sin ellos.
const MODIFICADORES = new Set([
  'pro', 'pro+', 'max', 'ultra', 'mini', 'plus', '5g', '4g', '3g', 'wifi',
  'chip', 'fusion', 'air', 'new', 'global', 'dual', 'sim', 'lite', 'fe',
]);

// Orden importa: gana la primera marca que coincida.
const MARCAS = [
  ['apple', ['iphone', 'ipad', 'macbook', 'mac book']],
  ['xiaomi', ['redmi pad', 'xiaomi pad', 'redmi', 'poco', 'xiaomi']],
  ['nubia', ['black shark', 'redmagic', 'red magic', 'nubia']],
  ['tecno', ['pova', 'tecno', 'camon', 'spark']],
  ['samsung', ['samsung', 'galaxy', 'tab']],
  ['honor', ['honor']],
  ['motorola', ['motorola', 'moto']],
  ['realme', ['realme']],
  ['infinix', ['infinix']],
  ['cubot', ['cubot']],
  ['zte', ['zte']],
  ['tcl', ['tcl']],
  ['meizu', ['meizu']],
  ['oppo', ['oppo']],
  ['oneplus', ['oneplus']],
  ['vivo', ['vivo', 'iqoo']],
  ['itel', ['itel']],
  ['google', ['pixel']],
  ['nokia', ['nokia']],
  ['lg', ['lg']],
  ['sony', ['sony', 'xperia']],
  ['htc', ['htc']],
  ['alcatel', ['alcatel']],
  ['nothing', ['nothing']],
  ['blackberry', ['blackberry']],
  ['lenovo', ['lenovo', 'ideapad', 'thinkpad']],
  ['asus', ['asus', 'zenfone']],
  ['hmd', ['hmd']],
];

// Alias que forman parte del nombre real del archivo, asi que no se quitan:
// el dataset guarda "redmi-a7", no "a7".
const ALIAS_DENTRO_DEL_SLUG = new Set([
  'redmi', 'redmi pad', 'xiaomi pad', 'poco', 'tab', 'galaxy', 'moto',
  'pova', 'spark', 'camon', 'iphone', 'ipad', 'macbook', 'pixel',
]);

const cacheFicha = new Map();
const cacheMarca = new Map();
const shasCategoria = {};
let shasMarca = {};
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
  const vistos = {};
  const salida = [];
  for (const v of lista) {
    if (!v || vistos[v]) continue;
    vistos[v] = true;
    salida.push(v);
  }
  return salida;
}

function limpiarSufijos(texto) {
  return String(texto === '')
    .replace(/(\d+)\s*\/\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*(gb|tb)\b/g, ' ')
    .replace(/\b\d+[.,]\d+\b/g, ' ')
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

function detectarMarca(texto) {
  const n = normalizar(texto);
  for (const par of MARCAS) {
    for (const alias of par[1]) {
      if (palabraEnTexto(n, alias)) return par[0];
    }
  }
  return '';
}

function detectarCategoria(texto) {
  const n = normalizar(texto);
  if (
    palabraEnTexto(n, 'macbook') || palabraEnTexto(n, 'notebook') ||
    palabraEnTexto(n, 'laptop') || palabraEnTexto(n, 'ideapad') ||
    palabraEnTexto(n, 'thinkpad')
  ) {
    return 'laptop';
  }
  if (
    palabraEnTexto(n, 'ipad') || palabraEnTexto(n, 'tab') ||
    palabraEnTexto(n, 'pad')
  ) {
    return 'tablet';
  }
  return 'smartphone';
}

function quitarMarca(texto, marca) {
  const n = normalizar(texto);
  if (!marca) return n;
  for (const par of MARCAS) {
    if (par[0] !== marca) continue;
    for (const alias of par[1]) {
      if (palabraEnTexto(n, alias)) {
        if (ALIAS_DENTRO_DEL_SLUG.has(alias)) return n;
        return n.replace(alias, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  if (n.indexOf(marca + ' ') === 0) return n.slice(marca.length + 1).trim();
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

function adivinarSlugs(modelo, marca) {
  const crudo = normalizar(modelo);
  const limpio = limpiarSufijos(crudo) || crudo;
  const raiz = quitarMarca(limpio, marca);
  const salida = [];
  for (const base of unicos([raiz, limpio, crudo])) {
    salida.push(norm(base));
    const partes = base.split(' ').filter(Boolean);
    for (let i = partes.length; i >= 1; i--) {
      const ultimo = String(partes[i - 1]).replace(/\+/g, '');
      if (!MODIFICADORES.has(ultimo)) continue;
      const resto = partes.slice(0, i - 1);
      if (resto.length) salida.push(norm(resto.join(' ')));
    }
  }
  return unicos(salida);
}

/**
 * Juegos de tokens a buscar en el indice, del mas estricto al mas laxo.
 * "redmi note 15 pro 5g" -> [redmi,note,15,pro,5g], [redmi,note,15,pro],
 * [redmi,note,15]
 */
function juegosDeTokens(modelo, marca) {
  const base = quitarMarca(limpiarSufijos(normalizar(modelo)), marca);
  const palabras = base.split(' ').filter(Boolean);
  const juegos = [];
  const anadir = (arr) => {
    if (!arr.length) return;
    const k = arr.join('|');
    for (const j of juegos) if (j.join('|') === k) return;
    juegos.push(arr);
  };

  anadir(palabras);

  const pila = palabras.slice();
  for (let i = 0; i < 3; i++) {
    if (pila.length <= 1) break;
    const ultimo = pila[pila.length - 1];
    if (!MODIFICADORES.has(ultimo) && !/^\d+$/.test(ultimo)) break;
    pila.pop();
    anadir(pila);
  }

  // Un numero suelto al final suele ser el tamano de pantalla.
  if (pila.length > 1 && /^\d+$/.test(pila[pila.length - 1])) {
    anadir(pila.slice(0, -1));
  }

  return juegos;
}

async function pedirJson(url) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: cabecerasApi(),
      redirect: 'follow',
      signal: controlador.signal,
    });
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

async function fetchSpec(categoria, marca, anio, archivo) {
  const url = RAW_BASE + '/' + categoria + '/' + marca + '/' + anio + '/' + archivo;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) return null;
  return await r.json();
}

async function shaCategoria(categoria) {
  if (Object.prototype.hasOwnProperty.call(shasCategoria, categoria)) {
    return shasCategoria[categoria];
  }
  if (!gastarApi()) return null;
  const raiz = await pedirJson(API_GIT + REF);
  if (!raiz) return null;
  const data = (raiz.tree || []).find((e) => e.path === 'data');
  if (!data) return null;
  if (!gastarApi()) return null;
  const sub = await pedirJson(API_GIT + data.sha);
  if (!sub) return null;
  const cat = (sub.tree || []).find((e) => e.path === categoria);
  shasCategoria[categoria] = cat ? cat.sha : null;
  return shasCategoria[categoria];
}

async function shaMarca(categoria, marca) {
  const k = categoria + '/' + marca;
  if (Object.prototype.hasOwnProperty.call(shasMarca, k)) return shasMarca[k];
  const catSha = await shaCategoria(categoria);
  if (!catSha) {
    shasMarca[k] = null;
    return null;
  }
  if (!gastarApi()) return null;
  const r = await pedirJson(API_GIT + catSha);
  if (!r) return null;
  const m = (r.tree || []).find((e) => e.path === marca);
  shasMarca[k] = m ? m.sha : null;
  return shasMarca[k];
}

/**
 * Indice completo de una marca: una sola llamada. Queda cacheado en
 * memoria mientras la instancia de Render siga viva.
 */
async function indexarMarca(categoria, marca) {
  const k = categoria + '/' + marca;
  if (cacheMarca.has(k)) return cacheMarca.get(k);

  const sha = await shaMarca(categoria, marca);
  if (!sha) {
    cacheMarca.set(k, []);
    return [];
  }
  if (!gastarApi()) return cacheMarca.get(k) || [];

  const r = await pedirJson(API_GIT + sha + '?recursive=1');
  const lista = [];
  if (r && Array.isArray(r.tree)) {
    for (const e of r.tree) {
      if (!e.path || e.path.slice(-5) !== '.json') continue;
      const partes = e.path.split('/');
      if (partes.length < 2) continue;
      lista.push({ anio: partes[partes.length - 2], archivo: partes[partes.length - 1] });
    }
  }
  cacheMarca.set(k, lista);
  return lista;
}

function tokensDe(archivo) {
  return String(archivo || '')
    .replace(/\.json$/i, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function mejorArchivo(indice, buscados) {
  let mejor = null;
  let mejorPunt = null;

  for (const item of indice) {
    const crudos = tokensDe(item.archivo);
    if (crudos.length === 0) continue;

    const set = {};
    let extras = 0;
    for (const t of crudos) {
      if (RUIDO_ARCHIVO.has(t)) continue;
      set[t] = true;
      extras++;
    }

    let cumple = true;
    for (const b of buscados) {
      if (!set[b]) {
        cumple = false;
        break;
      }
    }
    if (!cumple) continue;

    const sobrantes = extras - buscados.length;
    let punt = -sobrantes * 2 - crudos.length * 0.15;

    // el anio mas reciente gana los empates
    const anio = Number(item.anio);
    if (anio >= 2000) punt += Math.min(anio - 2000, 26) * 0.35;

    if (mejorPunt === null || punt > mejorPunt) {
      mejorPunt = punt;
      mejor = item;
    }
  }

  return mejor;
}

async function buscarConIndice(categoria, marca, juegos) {
  const indice = await indexarMarca(categoria, marca);
  if (!indice || !indice.length) return null;

  for (const buscados of juegos) {
    const hit = mejorArchivo(indice, buscados);
    if (!hit) continue;
    const json = await fetchSpec(categoria, marca, hit.anio, hit.archivo);
    const ficha = json ? mapear(json) : null;
    if (ficha) return ficha;
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

  const detectada = detectarCategoria(modelo);
  const categorias = unicos([detectada].concat(CATEGORIAS));

  const anios = aniosPosibles();
  const anio = anioEnElNombre(modelo);
  if (anio) {
    const i = anios.indexOf(anio);
    if (i > 0) {
      anios.splice(i, 1);
      anios.unshift(anio);
    }
  }

  // 1) Nombre directo (raw, sin limite de API).
  for (const categoria of categorias) {
    for (const slug of slugs) {
      for (const a of anios) {
        const json = await fetchSpec(categoria, marca, a, slug + '.json');
        if (!json) continue;
        const ficha = mapear(json);
        if (ficha) {
          cacheFicha.set(k, { ficha: ficha });
          return { ficha: ficha, cache: false };
        }
      }
    }
  }

  // 2) Indice de la marca (2 llamadas, cacheado). Necesita GITHUB_TOKEN.
  const juegos = juegosDeTokens(modelo, marca);
  for (const categoria of categorias) {
    const ficha = await buscarConIndice(categoria, marca, juegos);
    if (ficha) {
      cacheFicha.set(k, { ficha: ficha });
      return { ficha: ficha, cache: false };
    }
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
  juegosDeTokens: juegosDeTokens,
};