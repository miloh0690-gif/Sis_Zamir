'use strict';

const crypto = require('node:crypto');

const NOMBRE_COOKIE = 'sz_sesion';
const DURACION_MS = 8 * 60 * 60 * 1000;

function secreto() {
  const s = process.env.SESSION_SECRET || '';
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET no configurado o demasiado corto (minimo 16 caracteres).');
  }
  return s;
}

function hashearPin(pin) {
  const sal = crypto.randomBytes(16).toString('hex');
  const derivado = crypto.scryptSync(String(pin), sal, 64).toString('hex');
  return 'scrypt$' + sal + '$' + derivado;
}

function verificarPin(pin, guardado) {
  if (!guardado) return false;
  const partes = String(guardado).split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
  const sal = partes[1];
  const esperado = partes[2];
  const calculado = crypto.scryptSync(String(pin), sal, 64).toString('hex');
  const a = Buffer.from(esperado, 'hex');
  const b = Buffer.from(calculado, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function firmar(carga) {
  const cuerpo = Buffer.from(JSON.stringify(carga), 'utf8').toString('base64url');
  const firma = crypto.createHmac('sha256', secreto()).update(cuerpo).digest('base64url');
  return cuerpo + '.' + firma;
}

function verificar(token) {
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const cuerpo = partes[0];
  const firma = partes[1];
  const esperada = crypto.createHmac('sha256', secreto()).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false && null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const carga = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (!carga.exp || Date.now() > carga.exp) return null;
    return carga;
  } catch (e) {
    return null;
  }
}

function leerCookies(cabecera) {
  const salida = {};
  if (!cabecera) return salida;
  for (const trozo of String(cabecera).split(';')) {
    const indice = trozo.indexOf('=');
    if (indice < 0) continue;
    const clave = trozo.slice(0, indice).trim();
    const valor = trozo.slice(indice + 1).trim();
    if (clave) salida[clave] = decodeURIComponent(valor);
  }
  return salida;
}

function crearCookie(token) {
  const partes = [
    NOMBRE_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(DURACION_MS / 1000),
  ];
  if (process.env.NODE_ENV === 'production') partes.push('Secure');
  return partes.join('; ');
}

function borrarCookie() {
  return NOMBRE_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

function estaAutenticado(req) {
  const cookies = leerCookies(req.headers.cookie);
  return verificar(cookies[NOMBRE_COOKIE]) !== null;
}

function exigirAuth(req, res, siguiente) {
  if (!estaAutenticado(req)) {
    return res.status(401).json({ error: 'Necesitas iniciar sesion para ver esta seccion.' });
  }
  siguiente();
}

module.exports = {
  NOMBRE_COOKIE,
  hashearPin,
  verificarPin,
  firmar,
  verificar,
  leerCookies,
  crearCookie,
  borrarCookie,
  estaAutenticado,
  exigirAuth,
  DURACION_MS,
};