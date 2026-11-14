'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const acceso = require('../src/acceso');
const auth = require('../src/auth');

// El candado se configura por variables de entorno, asi que cada prueba las
// pone y las saca. Se guardan los valores originales al cargar el archivo.
const ENV = {
  SECRET: process.env.SESSION_SECRET,
  HASH: process.env.CLAVE_ACCESO_HASH,
};

function conEntorno(secret, hash, fn) {
  process.env.SESSION_SECRET = secret;
  if (hash === null) delete process.env.CLAVE_ACCESO_HASH;
  else process.env.CLAVE_ACCESO_HASH = hash;
  try {
    return fn();
  } finally {
    if (ENV.SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ENV.SECRET;
    if (ENV.HASH === undefined) delete process.env.CLAVE_ACCESO_HASH;
    else process.env.CLAVE_ACCESO_HASH = ENV.HASH;
  }
}

function pedido(cookie) {
  return { headers: cookie ? { cookie: cookie } : {} };
}

const SECRETO = 'secreto-de-prueba-largo';
const HASH = auth.hashearPin('OpenMilo');

function cookieDe(encabezado) {
  // "sz_acceso=TOKEN; Path=/; HttpOnly; ..." -> "sz_acceso=TOKEN"
  return String(encabezado).split(';')[0];
}

test('sin CLAVE_ACCESO_HASH el candado no existe', () => {
  conEntorno(SECRETO, null, () => {
    assert.equal(acceso.requerido(), false);
    assert.equal(acceso.abierto(pedido()), true);
  });
});

test('con hash, sin cookie, el sistema esta cerrado', () => {
  conEntorno(SECRETO, HASH, () => {
    assert.equal(acceso.requerido(), true);
    assert.equal(acceso.abierto(pedido()), false);
    assert.equal(acceso.abierto(pedido('otra=1')), false);
  });
});

test('la clave correcta abre y la incorrecta no', () => {
  conEntorno(SECRETO, HASH, () => {
    assert.equal(acceso.comprobar('OpenMilo'), true);
    assert.equal(acceso.comprobar('openmilo'), false);
    assert.equal(acceso.comprobar('OpenMilo '), false);
    assert.equal(acceso.comprobar(''), false);
    assert.equal(acceso.comprobar(undefined), false);
  });
});

test('la cookie del candado abre, y va firmada (no se puede inventar)', () => {
  conEntorno(SECRETO, HASH, () => {
    const cookie = cookieDe(acceso.crearCookie());
    assert.equal(acceso.abierto(pedido(cookie)), true);
    // Un token con la firma cambiada no vale.
    const roto = cookie.slice(0, -2) + 'AA';
    assert.equal(acceso.abierto(pedido(roto)), false);
    // Texto cualquiera tampoco.
    assert.equal(acceso.abierto(pedido('sz_acceso=basura')), false);
  });
});

test('la cookie del candado NO sirve como sesion del dueño', () => {
  conEntorno(SECRETO, HASH, () => {
    // La direccion peligrosa es esta: entrar con la clave compartida no puede
    // dar acceso a costos ni margenes.
    const candado = cookieDe(acceso.crearCookie());
    assert.equal(auth.estaAutenticado(pedido(candado)), false);
    assert.equal(auth.estaAutenticado(pedido('sz_sesion=trucho')), false);
  });
});

test('el dueño ya logueado no tiene que escribir la clave compartida', () => {
  conEntorno(SECRETO, HASH, () => {
    const sesion = 'sz_sesion=' + auth.firmar({ exp: Date.now() + 60000 });
    assert.equal(acceso.abierto(pedido(sesion)), true);
  });
});

test('sin SESSION_SECRET no se cierra la puerta: nadie podria firmar la cookie', () => {
  conEntorno('', HASH, () => {
    assert.equal(acceso.requerido(), true);
    assert.equal(acceso.abierto(pedido()), true);
  });
});

test('la cookie del candado dura 30 dias y es HttpOnly + SameSite=Strict', () => {
  conEntorno(SECRETO, HASH, () => {
    const cookie = acceso.crearCookie();
    assert.match(cookie, /Max-Age=2592000/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });
});

test('una cookie malformada no abre el candado (ni lo rompe)', () => {
  conEntorno(SECRETO, HASH, () => {
    // decodeURIComponent('%E0%A4%A') lanza URIError. Antes eso caia en un
    // catch que devolvia true, o sea que una cookie rota abria la puerta.
    let resultado = null;
    assert.doesNotThrow(() => {
      resultado = acceso.abierto(pedido('sz_acceso=%E0%A4%A'));
    });
    assert.equal(resultado, false);
  });
});

test('exigir responde 401 con codigo CANDADO, para que el frontend muestre la pantalla', () => {
  conEntorno(SECRETO, HASH, () => {
    let codigo = 0;
    let cuerpo = null;
    const res = {
      status(n) {
        codigo = n;
        return { json(objeto) { cuerpo = objeto; } };
      },
    };
    let paso = false;
    acceso.exigir(pedido(), res, () => { paso = true; });
    assert.equal(paso, false);
    assert.equal(codigo, 401);
    assert.equal(cuerpo.codigo, 'CANDADO');
  });
});

test('exigir deja pasar con la cookie buena', () => {
  conEntorno(SECRETO, HASH, () => {
    let paso = false;
    acceso.exigir(pedido(cookieDe(acceso.crearCookie())), { status() { throw new Error('no deberia'); } }, () => { paso = true; });
    assert.equal(paso, true);
  });
});
