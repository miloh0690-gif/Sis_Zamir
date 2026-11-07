'use strict';

// Candado de entrada del sistema: una sola clave compartida para los
// vendedores, separada del PIN del dueño.
//
// Por que dos credenciales y no una:
//
//   - La clave de acceso la sabe todo el que atiende el mostrador. Sirve para
//     abrir la app y vender, nada mas.
//   - El PIN del dueño (ADMIN_PIN_HASH) sigue siendo el unico que abre Dueño y
//     Reportes, o sea costos y margenes. Un vendedor no tiene por que ver
//     cuanto gana la tienda.
//
// Por eso la cookie es distinta de sz_sesion: si fueran la misma, entrar con
// la clave compartida daria privilegios de dueño. sz_acceso NO autentica; solo
// destraba la puerta.
//
// La clave NO se guarda en el repo (que es publico): va hasheada con scrypt en
// la variable CLAVE_ACCESO_HASH de Render. Se genera con `npm run hash-pin`.
//
// Si CLAVE_ACCESO_HASH no esta configurada, el candado no existe y el sistema
// se comporta como antes. Es a proposito: un deploy sin la variable no puede
// dejar la tienda sin poder vender, y ademas permite apagarlo sin tocar codigo.

const auth = require('./auth');

const NOMBRE_COOKIE = 'sz_acceso';
// 30 dias: la tablet del mostrador se despierta todos los dias y pedir la
// clave cada manana es la clase de friccion que termina en la clave pegada en
// un papel al lado de la caja.
const DURACION_MS = 30 * 24 * 60 * 60 * 1000;

function hashGuardado() {
  return String(process.env.CLAVE_ACCESO_HASH || '');
}

function requerido() {
  return hashGuardado().length > 0;
}

function haySecreto() {
  return String(process.env.SESSION_SECRET || '').length >= 16;
}

/** true si la clave escrita es la buena. */
function comprobar(clave) {
  if (!requerido()) return true;
  if (!clave) return false;
  return auth.verificarPin(clave, hashGuardado());
}

/**
 * true si se puede usar el sistema. Sin hash configurado, o sin
 * SESSION_SECRET (no habria forma de firmar la cookie), no se cierra la
 * puerta: es preferible que la tienda venda a que nadie pueda entrar.
 */
function abierto(req) {
  if (!requerido()) return true;
  if (!haySecreto()) return true;
  // El dueño con su PIN ya entro: no se le pide la clave compartida encima.
  if (auth.estaAutenticado(req)) return true;
  let carga = null;
  try {
    carga = auth.verificar(auth.leerCookies(req.headers.cookie)[NOMBRE_COOKIE]);
  } catch (e) {
    return true;
  }
  return Boolean(carga && carga.tipo === 'acceso');
}

function crearCookie() {
  const token = auth.firmar({ tipo: 'acceso', exp: Date.now() + DURACION_MS });
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

function exigir(req, res, siguiente) {
  if (abierto(req)) return siguiente();
  return res.status(401).json({
    error: 'Escribí la clave de acceso para usar el sistema.',
    codigo: 'CANDADO',
  });
}

module.exports = {
  NOMBRE_COOKIE,
  DURACION_MS,
  requerido: requerido,
  comprobar: comprobar,
  abierto: abierto,
  crearCookie: crearCookie,
  borrarCookie: borrarCookie,
  exigir: exigir,
};
