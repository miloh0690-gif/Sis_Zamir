'use strict';

// Ficha tecnica desde una base de datos REAL de telefonos, no desde un
// LLM. Un modelo de lenguaje se inventa la bateria o los GB de RAM, y
// en un sistema de ventas eso es Tellarle una mentira al cliente con tu
// marca. Aqui los datos salen de GSMArena.

const URL_BASE = String(
  process.env.SPECS_API_URL || 'https://mobile-specs-api-sandy.vercel.app'
)
  .trim()
  .replace(/\/+$/, '');

const TIMEOUT_MS = 25000;
const CACHE_MS = 12 * 60 * 60 * 1000;

const MARCAS = [
  'Apple', 'Samsung', 'Xiaomi', 'Poco', 'Red Magic', 'Motorola', 'Oppo',
  'Realme', 'OnePlus', 'Huawei', 'Honor', 'Google', 'Nokia', 'Sony', 'LG',
  'ZTE', 'Infinix', 'Tecno', 'Vivo', 'Alcatel', 'BlackBerry', 'Asus',
  'Nothing', 'HMD', 'Nubia', 'itel', 'TCL', 'Energizer', 'Htc', 'Lenovo',
  'Meizu', 'Sharp', 'Wiko', 'Crosscall', 'Tecno Mobile',
];

const cache = new Map();

// -----------------------------------------------------------------
// Utilidades de texto
// -----------------------------------------------------------------

function limpiar(valor) {
  if (valor === undefined || valor === null) return '';
  let texto = String(valor);

  texto = texto.replace(/<br\s*\/?>/gi, ' · ');
  texto = texto.replace(/<[^>]*>/g, ' ');
  texto = texto
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  texto = texto.replace(/[\r\n\t]+/g, ' · ');
  texto = texto.replace(/\s*·\s*·\s*/g, ' · ');
  texto = texto.replace(/^·\s*|\s*·$/g, '');
  texto = texto.replace(/\s{2,}/g, ' ');

  return texto.trim();
}

function recortar(texto, max) {
  const t = limpiar(texto);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * GSMArena usa claves variables ("Type", "Size", "Chipset"...). Se
 * buscan sin distinguir mayusculas y con alias.
 */
function valorDe(specs, seccion, alias) {
  const claves = Array.isArray(alias) ? alias : [alias];
  const bloque = specs[seccion];
  if (!bloque || typeof bloque !== 'object') return '';

  for (const aliasBuscado of claves) {
    for (const clave of Object.keys(bloque)) {
      if (clave.trim().toLowerCase() === String(aliasBuscado).toLowerCase()) {
        const v = limpiar(bloque[clave]);
        if (v) return v;
      }
    }
  }
  return '';
}

function unir(parte, valor) {
  if (!valor) return '';
  return parte ? parte + ' · ' + valor : valor;
}

function marcaDe(modelo) {
  const texto = String(modelo || '');
  const normal = texto.toLowerCase();

  for (const marca of MARCAS) {
    const m = marca.toLowerCase();
    if (normal === m) return marca;
    if (normal.indexOf(m + ' ') === 0) return marca;
  }

  const primera = texto.trim().split(/\s+/)[0] || '';
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase();
}

// -----------------------------------------------------------------
// Consulta a la base de datos
// -----------------------------------------------------------------

function clave(modelo) {
  return String(modelo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function habilitado() {
  return Boolean(URL_BASE);
}

async function pedirRuta(ruta) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(URL_BASE + ruta, {
      headers: { Accept: 'application/json' },
      signal: controlador.signal,
    });
    if (!respuesta.ok) {
      const e = new Error('La base de datos de telefonos respondio HTTP ' + respuesta.status + '.');
      e.codigo = 502;
      throw e;
    }
    return await respuesta.json();
  } catch (e) {
    if (e.codigo) throw e;
    const fallo = new Error(
      e.name === 'AbortError'
        ? 'La base de datos de telefonos tardo demasiado. Intenta de nuevo.'
        : 'No se pudo consultar la base de datos de telefonos.'
    );
    fallo.codigo = e.name === 'AbortError' ? 504 : 502;
    throw fallo;
  } finally {
    clearTimeout(temporizador);
  }
}

// -----------------------------------------------------------------
// Mapeo: GSMArena -> los 9 campos que ya consume la interfaz
// -----------------------------------------------------------------

function mapear(bruto) {
  if (!bruto || bruto.status !== true || !bruto.data) {
    const e = new Error('Ese modelo no aparece en la base de datos. Prueba con marca y modelo exactos (ej: "iPhone 13", no "iphone thirteen").');
    e.codigo = 404;
    throw e;
  }

  const data = bruto.data;
  const specs = data.specifications || {};

  const modeloCompleto = limpiar(data.model) || limpiar(bruto.matched);

  const chipset = valorDe(specs, 'Platform', ['Chipset', ' chipset']);
  const cpu = valorDe(specs, 'Platform', 'CPU');
  const gpu = valorDe(specs, 'Platform', 'GPU');
  const sistema = valorDe(specs, 'Platform', 'OS') || limpiar(data.os);

  const tipoPantalla = valorDe(specs, 'Display', ['Type', ' type']);
  const tamanoPantalla = valorDe(specs, 'Display', ['Size', ' size']);
  const resolucion = valorDe(specs, 'Display', ['Resolution', ' resolution']);
  const proteccion = valorDe(specs, 'Display', 'Protection');

  const camaraPrincipal = Object.keys(specs['Main Camera'] || {})
    .map((k) => (k.trim() ? limpiar(specs['Main Camera'][k]) : ''))
    .filter(Boolean)
    .join(' · ');
  const camaraFrontal = Object.keys(specs['Selfie camera'] || {})
    .map((k) => (k.trim() ? limpiar(specs['Selfie camera'][k]) : ''))
    .filter(Boolean)
    .join(' · ');

  const bateria = valorDe(specs, 'Battery', ['Type', ' type']);
  const carga = valorDe(specs, 'Battery', 'Charging');

  const interna = valorDe(specs, 'Memory', ['Internal', ' Internal']);
  const ranura = valorDe(specs, 'Memory', ['Card slot', 'Card slot microSD']);
  const almacenamiento = limpiar(data.storage);
  const ram = interna;
  const capacidad = almacenamiento;

  const wifi = valorDe(specs, 'Comms', 'WLAN');
  const bluetooth = valorDe(specs, 'Comms', 'Bluetooth');
  const nfc = valorDe(specs, 'Comms', 'NFC');
  const usb = valorDe(specs, 'Comms', 'USB');
  const tearred = valorDe(specs, 'Network', 'Technology');

  const pantalla = [tipoPantalla, tamanoPantalla, resolucion, proteccion]
    .filter(Boolean)
    .join(' · ');

  const camaras = camaraPrincipal || camaraFrontal
    ? [camaraPrincipal && 'Principal: ' + camaraPrincipal, camaraFrontal && 'Frontal: ' + camaraFrontal]
        .filter(Boolean)
        .join(' | ')
    : '';

  const ramAlmacenamiento = [interna, almacenamiento && 'Almacenamiento: ' + almacenamiento, ranura && ranura]
    .filter(Boolean)
    .join(' · ');

  const conectividad = [tearred, wifi, bluetooth, nfc && 'NFC: ' + nfc, usb]
    .filter(Boolean)
    .join(' · ');

  const procesador = [chipset, cpu, gpu].filter(Boolean).join(' · ');

  const release = limpiar(data.release_date);

  // El resumen solo junta datos que YA tenemos. No agrega nada.
  const partesResumen = [];
  if (chipset) partesResumen.push(chipset);
  if (tamanoPantalla || tipoPantalla) partesResumen.push('pantalla ' + (tamanoPantalla || tipoPantalla));
  if (bateria) partesResumen.push('bateria ' + bateria);
  if (camaraPrincipal) partesResumen.push('camara ' + recortar(camaraPrincipal, 70));
  if (interna) partesResumen.push(interna);
  if (almacenamiento) partesResumen.push(almacenamiento);
  if (release) partesResumen.push(release);

  return {
    nombre: modeloCompleto,
    marca: marcaDe(modeloCompleto),
    procesador: recortar(procesador, 220),
    pantalla: recortar(pantalla, 240),
    camaras: recortar(camaras, 320),
    bateria: recortar(bateria, 140),
    carga: recortar(carga, 160),
    ramAlmacenamiento: recortar(ramAlmacenamiento, 220),
    conectividad: recortar(conectividad, 240),
    sistema: recortar(sistema, 120),
    resumen: partesResumen.join(', ') + '.',
    imagenUrl: limpiar(data.imageUrl),
    releaseDate: release,
    haySpecs: Boolean(chipset || pantalla || bateria || camaraPrincipal),
  };
}

/**
 * Busca la ficha de un modelo. Cachea 12 horas por nombre normalizado,
 * asi que el mismo modelo no se vuelve a pedir nunca en la jornada.
 */
async function buscarFicha(modelo) {
  const k = clave(modelo);
  if (!k) {
    const e = new Error('Indica el modelo a consultar.');
    e.codigo = 400;
    throw e;
  }

  const guardado = cache.get(k);
  if (guardado && Date.now() - guardado.fecha < CACHE_MS) {
    return { ficha: guardado.ficha, cache: true };
  }

  if (!habilitado()) {
    const e = new Error('La base de datos de telefonos no esta configurada.');
    e.codigo = 503;
    throw e;
  }

  const ruta = '/phone?name=' + encodeURIComponent(String(modelo).trim());
  const bruto = await pedirRuta(ruta);
  const ficha = mapear(bruto);

  if (!ficha.haySpecs) {
    const e = new Error(
      'Ese modelo no tiene ficha tecnica en la base de datos. Prueba con la marca completa (ej: "Xiaomi Redmi Note 13").'
    );
    e.codigo = 404;
    throw e;
  }

  delete ficha.haySpecs;
  cache.set(k, { ficha: ficha, fecha: Date.now() });

  return { ficha: ficha, cache: false };
}

module.exports = {
  buscarFicha: buscarFicha,
  habilitado: habilitado,
  mapear: mapear,
  limpiar: limpiar,
  urlBase: URL_BASE,
};