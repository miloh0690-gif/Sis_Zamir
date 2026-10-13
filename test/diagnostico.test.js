'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// El diagnostico se arma UNA vez al cargar el modulo (URL_BASE y API_KEY se
// leen del entorno en ese momento), asi que hay que preparar el entorno y
// limpiar la cache de require antes de cada prueba.

function cargarConStub(respuestas) {
  process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/ABC/exec';
  process.env.SHEETS_API_KEY = 'k'.repeat(64);
  const ruta = require.resolve('../src/inventory');
  delete require.cache[ruta];
  const original = global.fetch;
  global.fetch = async (url) => {
    const cuerpo = respuestas(String(url));
    return {
      status: cuerpo.estado === undefined ? 200 : cuerpo.estado,
      text: async () => (typeof cuerpo.cuerpo === 'string' ? cuerpo.cuerpo : JSON.stringify(cuerpo.cuerpo)),
    };
  };
  const inventory = require(ruta);
  return {
    inventory: inventory,
    restaurar: function () {
      global.fetch = original;
      delete require.cache[ruta];
    },
  };
}

test('diagnostico: si el scope de Drive falta, la accion lo dice y NO culpa a la llave', async () => {
  // SALUD responde bien (version 4) pero DriveApp explota: es el caso que
  // reportó Milo. El paso 4 (la llave) SI coincide.
  const t = cargarConStub(function (url) {
    if (url.indexOf('action=SALUD') >= 0) {
      return {
        cuerpo: {
          ok: true,
          version: 4,
          drive: { ok: false, detalle: 'sin acceso a Drive. Lo que respondio Google: Access denied: DriveApp.getFileById(). The caller does not have permission.' },
        },
      };
    }
    return { cuerpo: [{ modelo: 'A' }, { modelo: 'B' }] };
  });
  try {
    const d = await t.inventory.diagnostico();
    assert.equal(d.ok, false, 'el diagnostico tiene que fallar');
    const paso5 = d.pasos.find(function (p) { return p.paso === 5; });
    assert.ok(paso5, 'tiene que existir el paso 5');
    assert.equal(paso5.ok, false);
    const paso4 = d.pasos.find(function (p) { return p.paso === 4; });
    assert.equal(paso4.ok, true, 'la llave si coincide');
    assert.match(d.accion, /[Dd]rive/, 'la accion tiene que mencionar Drive');
    assert.match(
      d.accion,
      /oauthScopes/,
      'la accion tiene que nombrar el campo exacto que hay que editar'
    );
    assert.doesNotMatch(
      d.accion,
      /SHEETS_API_KEY/,
      'la accion NO puede culpar a la llave: la llave si coincide'
    );
    assert.match(
      d.accion,
      /Access denied/,
      'la accion tiene que traer el error REAL de Google que ya esta en el paso 5'
    );
  } finally {
    t.restaurar();
  }
});

test('diagnostico: si la llave NO coincide, la accion si la nombra', async () => {
  const t = cargarConStub(function (url) {
    if (url.indexOf('action=SALUD') >= 0) {
      return { cuerpo: { ok: true, version: 4, drive: { ok: true, detalle: 'con acceso a Drive' } } };
    }
    return { cuerpo: { error: 'NO_AUTORIZADO' } };
  });
  try {
    const d = await t.inventory.diagnostico();
    assert.equal(d.ok, false);
    const paso4 = d.pasos.find(function (p) { return p.paso === 4; });
    assert.equal(paso4.ok, false);
    const paso5 = d.pasos.find(function (p) { return p.paso === 5; });
    assert.equal(paso5.ok, true, 'Drive si tiene acceso');
    assert.match(d.accion, /SHEETS_API_KEY/, 'la accion tiene que nombrar la llave');
  } finally {
    t.restaurar();
  }
});

test('diagnostico: si todo esta bien no hay accion que dar', async () => {
  const t = cargarConStub(function (url) {
    if (url.indexOf('action=SALUD') >= 0) {
      return { cuerpo: { ok: true, version: 4, drive: { ok: true, detalle: 'con acceso a Drive' } } };
    }
    return { cuerpo: [{ modelo: 'A' }] };
  });
  try {
    const d = await t.inventory.diagnostico();
    assert.equal(d.ok, true);
    assert.equal(d.accion, null);
  } finally {
    t.restaurar();
  }
});

test('diagnostico: el paso de Drive aparece antes que el de la llave y aun asi se distinguen', async () => {
  // El orden del array es 1, 2, 3, 5, 6, 4. Los indices posicionales no
  // sirven: hay que buscar por numero de paso. El 5 y el 6 salen del mismo
  // SALUD, por eso van pegados; el 4 necesita la llave y se resuelve aparte.
  const t = cargarConStub(function (url) {
    if (url.indexOf('action=SALUD') >= 0) {
      return {
        cuerpo: {
          ok: true,
          version: 4,
          drive: { ok: false, detalle: 'sin acceso a Drive' },
          driveAuth: { ok: false, url: 'https://accounts.google.com/o/oauth2/auth?x=1', detalle: 'abre esta URL' },
        },
      };
    }
    return { cuerpo: [{ modelo: 'A' }] };
  });
  try {
    const d = await t.inventory.diagnostico();
    assert.deepEqual(
      d.pasos.map(function (p) { return p.paso; }),
      [1, 2, 3, 5, 6, 4],
      'el orden real del arreglo es 1, 2, 3, 5, 6, 4'
    );
  } finally {
    t.restaurar();
  }
});

test('diagnostico: cuando falta el permiso de Drive da la URL para autorizarlo a mano', async () => {
  // Esto es lo que pidio Milo literal: "vaya a un lugar y de permiso de
  // drive". El paso 6 tiene que traer la URL de consentimiento que arma
  // ScriptApp.getAuthorizationInfo().getAuthorizationUrl().
  const URL = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&scope=drive';
  const t = cargarConStub(function (url) {
    if (url.indexOf('action=SALUD') >= 0) {
      return {
        cuerpo: {
          ok: true,
          version: 6,
          drive: { ok: false, detalle: 'sin acceso a Drive. Lo que respondio Google: You do not have permission to call DriveApp.getFileById.' },
          driveAuth: { ok: false, url: URL, detalle: 'abre esta URL en el navegador y acepta el permiso de Drive.' },
        },
      };
    }
    return { cuerpo: [{ modelo: 'A' }, { modelo: 'B' }] };
  });
  try {
    const d = await t.inventory.diagnostico();
    const paso6 = d.pasos.filter(function (p) { return p.paso === 6; })[0];
    assert.ok(paso6, 'tiene que existir el paso 6 con la URL de autorizacion');
    assert.equal(paso6.ok, false, 'sin autorizacion el paso 6 esta en rojo');
    assert.ok(
      paso6.detalle.indexOf(URL) >= 0,
      'el paso 6 tiene que traer la URL literal, no solo decir que hay una: ' + paso6.detalle
    );
    assert.ok(
      d.accion.indexOf(URL) >= 0,
      'la accion tiene que repetir la URL para que Milo no la busque: ' + d.accion
    );
  } finally {
    t.restaurar();
  }
});

test('diagnostico: si el permiso ya esta concedido no inventa un paso 6 en rojo', async () => {
  const t = cargarConStub(function (url) {
    if (url.indexOf('action=SALUD') >= 0) {
      return {
        cuerpo: {
          ok: true,
          version: 6,
          drive: { ok: true, detalle: 'con acceso a Drive' },
          driveAuth: { ok: true, url: '', detalle: 'el permiso de Drive ya esta concedido' },
        },
      };
    }
    return { cuerpo: [{ modelo: 'A' }] };
  });
  try {
    const d = await t.inventory.diagnostico();
    assert.equal(d.ok, true, 'con todo bien el diagnostico tiene que dar ok');
    assert.equal(d.accion, null, 'no hay nada que arreglar');
  } finally {
    t.restaurar();
  }
});
