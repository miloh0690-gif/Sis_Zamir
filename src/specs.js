'use strict';

// Respaldo de ficha tecnica: scraper publico de GSMArena.
//
// El problema que resuelve este modulo: en la tienda los productos se
// llaman "IPHONE 17 PRO 256 CHIP" o "REDMI NOTE 15 PRO 5G 512/8". Ese
// nombre no existe en ninguna base de datos. Sin limpiarlo, el scraper
// daba 0 aciertos sobre los 226 productos reales de la tienda. Limpiarlo
// y probar una escalera de variantes lo subio a 13 de 50 en la misma
// prueba, y ademas encuentra los modelos mas recientes.
//
// Primero se prueba /phone?name= con cada variante; si ninguna acierta, se
// usa /search?query= y se toma el primer resultado.

const URL_BASE = String(
  process.env.SPECS_API_URL || 'https://mobile-specs-api-sandy.vercel.app'
)
  .trim()
  .replace(/\/+$/, '');

const TIMEOUT_MS = 25000;
const CACHE_MS = 12 * 60 * 60 * 1000;

// Palabras que describen la unidad concreta (memoria, color, region) y no
// el modelo. Se quitan para poder buscar el nombre real del aparato.
const RELLENO = [
  'chip', 'esim', 'wifi', 'wificn', 'vietnam', 'arabe', 'blanco', 'negro',
  'azul', 'nuevo', 'importado', 'sri', 'lanka', 'india', 'pak', 'dual',
  'sim', 'internacional', 'global', 'china', 'original', 'libre',
  'lamborghini', 'jade', 'plata', 'oro',
];

// Modificadores del final que a veces forman parte del nombre oficial y a
// veces no. Se prueban con y sin ellos.
const MODIFICADORES = ['pro', 'max', 'ultra', 'mini', 'plus', 'lite', 'fe'];

// Capacidades de memoria. OJO: 16 y 12 tambien son numeros de modelo
// ("Realme 16", "Infinix Hot 12"), asi que solo se quitan a partir de 32.
const CAPACIDADES = new Set([
  '32', '64', '128', '256', '512', '1024', '2048', '4000', '8000',
]);

const MARCAS = [
  'Apple', 'Samsung', 'Xiaomi', 'Redmi', 'Poco', 'Realme', 'Oppo', 'Honor',
  'Huawei', 'Motorola', 'Moto', 'Nokia', 'OnePlus', 'Vivo', 'Infinix',
  'Tecno', 'Camon', 'Pova', 'ZTE', 'Nubia', 'Itel', 'Asus', 'Google',
  'Nothing', 'Meizu', 'TCL', 'Black Shark', 'CUBOT', 'Alcatel', 'LG', 'Sony',
];

const cache = new Map();

function habilitado() {
  return Boolean(URL_BASE);
}

function normalizar(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+.\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escalera de consultas: de la mas fiel al nombre original hasta la mas
 * simple. Se prueban en orden y gana la primera que acierte.
 */
function consultasPara(modelo) {
  const bruto = normalizar(modelo);
  const variantes = [];
  const anadir = (t) => {
    const v = String(t || '').replace(/\s+/g, ' ').trim();
    if (!v) return;
    if (variantes.indexOf(v) === -1) variantes.push(v);
  };

  anadir(bruto);

  // 1) fuera sufijos de memoria: "512/8", "256gb", "8.7"
  const sinMemoria = bruto
    .replace(/(\d+)\s*\/\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*(gb|tb)\b/g, ' ')
    .replace(/\b\d+[.,]\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  anadir(sinMemoria);

  // 2) fuera relleno: "chip", "esim", "blanco"...
  let limpio = sinMemoria;
  for (const palabra of RELLENO) {
    limpio = limpio
      .split(' ')
      .filter((p) => p !== palabra)
      .join(' ');
  }
  anadir(limpio);

  // 3) fuera un numero suelto al final (tamano de pantalla: "11")
  anadir(limpio.replace(/\s+\d+$/, ''));

  // 4) fuera capacidades sueltas del final (>=32): "256", "512"
  const palabras = limpio.split(' ').filter(Boolean);
  while (palabras.length > 1 && CAPACIDADES.has(palabras[palabras.length - 1])) {
    palabras.pop();
  }
  const sinCapacidad = palabras.join(' ');
  anadir(sinCapacidad);

  // 5) fuera uno o dos modificadores del final
  let pila = palabras.slice();
  for (let i = 0; i < 2; i++) {
    if (!pila.length) break;
    const ultimo = pila[pila.length - 1];
    if (MODIFICADORES.indexOf(ultimo) === -1) break;
    pila = pila.slice(0, -1);
    anadir(pila.join(' '));
  }

  // 6) Tab y Moto con su denominacion oficial
  const conGalaxy = sinCapacidad.replace(/^tab\s+/, 'galaxy tab ');
  if (conGalaxy !== sinCapacidad) anadir(conGalaxy);
  const conMotorola = sinCapacidad.replace(/^moto\s+/, 'motorola ');
  if (conMotorola !== sinCapacidad) anadir(conMotorola);

  return variantes;
}

async function pedirJson(url) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
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
  return texto.replace(/\s{2,}/g, ' ').trim();
}

function recortar(texto, max) {
  const t = limpiar(texto);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

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

function marcaDe(modelo) {
  const texto = String(modelo || '');
  const n = texto.toLowerCase();
  for (const marca of MARCAS) {
    if (n.indexOf(marca.toLowerCase()) >= 0) return marca;
  }
  const primera = texto.trim().split(/\s+/)[0] || '';
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase();
}

function mapear(bruto, consultaUsada) {
  if (!bruto || bruto.status !== true || !bruto.data) return null;
  const data = bruto.data;
  const specs = data.specifications || {};
  const modeloCompleto = limpiar(data.model) || limpiar(bruto.matched);

  const chipset = valorDe(specs, 'Platform', ['Chipset']);
  const cpu = valorDe(specs, 'Platform', 'CPU');
  const gpu = valorDe(specs, 'Platform', 'GPU');
  const sistema = valorDe(specs, 'Platform', 'OS') || limpiar(data.os);

  const tipoPantalla = valorDe(specs, 'Display', ['Type']);
  const tamanoPantalla = valorDe(specs, 'Display', ['Size']);
  const resolucion = valorDe(specs, 'Display', ['Resolution']);
  const proteccion = valorDe(specs, 'Display', 'Protection');

  const camaraPrincipal = Object.keys(specs['Main Camera'] || {})
    .map((k) => (k.trim() ? limpiar(specs['Main Camera'][k]) : ''))
    .filter(Boolean)
    .join(' · ');
  const camaraFrontal = Object.keys(specs['Selfie camera'] || {})
    .map((k) => (k.trim() ? limpiar(specs['Selfie camera'][k]) : ''))
    .filter(Boolean)
    .join(' · ');

  const bateria = valorDe(specs, 'Battery', ['Type']);
  const carga = valorDe(specs, 'Battery', 'Charging');
  const interna = valorDe(specs, 'Memory', ['Internal']);
  const ranura = valorDe(specs, 'Memory', ['Card slot', 'Card slot microSD']);
  const almacenamiento = limpiar(data.storage);

  const wifi = valorDe(specs, 'Comms', 'WLAN');
  const bluetooth = valorDe(specs, 'Comms', 'Bluetooth');
  const nfc = valorDe(specs, 'Comms', 'NFC');
  const usb = valorDe(specs, 'Comms', 'USB');
  const tearred = valorDe(specs, 'Network', 'Technology');
  const release = limpiar(data.release_date);

  const pantalla = [tipoPantalla, tamanoPantalla, resolucion, proteccion]
    .filter(Boolean)
    .join(' · ');

  const camaras = camaraPrincipal || camaraFrontal
    ? [
        camaraPrincipal ? 'Principal: ' + camaraPrincipal : '',
        camaraFrontal ? 'Frontal: ' + camaraFrontal : '',
      ]
        .filter(Boolean)
        .join(' | ')
    : '';

  const ramAlmacenamiento = [
    interna,
    almacenamiento ? 'Almacenamiento: ' + almacenamiento : '',
    ranura,
  ]
    .filter(Boolean)
    .join(' · ');

  const conectividad = [tearred, wifi, bluetooth, nfc && 'NFC: ' + nfc, usb]
    .filter(Boolean)
    .join(' · ');

  const partesResumen = [];
  if (chipset) partesResumen.push(chipset);
  if (tamanoPantalla || tipoPantalla) partesResumen.push('pantalla ' + (tamanoPantalla || tipoPantalla));
  if (bateria) partesResumen.push('bateria ' + bateria);
  if (camaraPrincipal) partesResumen.push('camara ' + recortar(camaraPrincipal, 70));
  if (interna) partesResumen.push(interna);
  if (almacenamiento) partesResumen.push(almacenamiento);
  if (release) partesResumen.push(release);

  if (!chipset && !pantalla && !bateria && !camaraPrincipal) return null;

  return {
    nombre: modeloCompleto,
    marca: marcaDe(modeloCompleto),
    procesador: recortar([chipset, cpu, gpu].filter(Boolean).join(' · '), 220),
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
    verificado: true,
    fuentes: [],
    fuenteDatos: 'scraper',
    consultaUsada: consultaUsada || '',
  };
}

async function porNombre(nombre, consultaUsada) {
  const url = URL_BASE + '/phone?name=' + encodeURIComponent(nombre);
  return mapear(await pedirJson(url), consultaUsada);
}

async function porBusqueda(nombre, consultaUsada) {
  const url = URL_BASE + '/search?query=' + encodeURIComponent(nombre);
  const bruto = await pedirJson(url);
  if (!bruto || bruto.status !== true || !Array.isArray(bruto.data) || !bruto.data.length) {
    return null;
  }
  const slug = bruto.data[0].slug;
  if (!slug) return null;
  return porNombre(slug, consultaUsada);
}

async function buscarFicha(modelo) {
  const k = normalizar(modelo);
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

  const variantes = consultasPara(modelo);

  for (const consulta of variantes) {
    const ficha = await porNombre(consulta, consulta);
    if (ficha) {
      cache.set(k, { ficha: ficha, fecha: Date.now() });
      return { ficha: ficha, cache: false };
    }
  }

  const ultimo = Math.max(1, variantes.length - 3);
  for (let i = variantes.length - 1; i >= ultimo; i--) {
    const consulta = variantes[i];
    if (!consulta) continue;
    const ficha = await porBusqueda(consulta, consulta);
    if (ficha) {
      cache.set(k, { ficha: ficha, fecha: Date.now() });
      return { ficha: ficha, cache: false };
    }
  }

  const e = new Error(
    'No hay ficha tecnica de "' + String(modelo).trim() + '" en las bases de datos. ' +
      'Prueba con el nombre del fabricante y el modelo exactos (ej: "Honor X7c", "Moto G06").'
  );
  e.codigo = 404;
  throw e;
}

module.exports = {
  habilitado: habilitado,
  buscarFicha: buscarFicha,
  mapear: mapear,
  consultasPara: consultasPara,
  normalizar: normalizar,
  limpiar: limpiar,
  urlBase: URL_BASE,
};