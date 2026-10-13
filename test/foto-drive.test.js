'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const code = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');

function crearContexto(opciones = {}) {
  const propiedades = new Map();
  const archivos = [];
  let uuid = 0;
  const carpeta = {
    id: 'carpeta-fotos',
    getId: () => 'carpeta-fotos',
    createFile(blob) {
      if (opciones.createFile) return opciones.createFile(blob);
      const id = 'archivo-' + archivos.length;
      const archivo = {
        getId: () => id,
        setSharing(access, permission) {
          this.access = access;
          this.permission = permission;
        },
      };
      archivos.push({ blob, archivo });
      return archivo;
    },
  };
  const hoja = {
    getParentFolder: () => ({
      createFolder: () => carpeta,
    }),
  };
  const ctx = {
    Logger: { log: (...args) => (ctx.logs || (ctx.logs = [])).push(args.join(' ')) },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuid),
      base64Decode: (valor) => Buffer.from(valor, 'base64'),
      newBlob: (bytes, mimeType, nombre) => ({ bytes, mimeType, nombre }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => propiedades.get(key) || null,
        setProperty: (key, value) => propiedades.set(key, value),
      }),
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { VIEW: 'VIEW' },
      getFileById: () => hoja,
      getRootFolder: () => ({ createFolder: () => carpeta }),
      getFolderById: () => carpeta,
    },
    archivos,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getId: () => 'hoja-1',
        getSheetByName: () => ({ getLastRow: () => 2 }),
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (valor) => ({
        getContent: () => valor,
        setMimeType: () => ({ getContent: () => valor }),
      }),
    },
  };
  vm.runInNewContext(code, ctx, { filename: 'Code.gs' });
  return { ctx, propiedades, carpeta, archivos };
}

test('decodificarFoto acepta JPEG y PNG', () => {
  const { ctx } = crearContexto();
  const jpeg = ctx.decodificarFoto('data:image/jpeg;base64,aGVsbG8=');
  const png = ctx.decodificarFoto('data:image/png;base64,aGVsbG8=');

  assert.equal(jpeg.mimeType, 'image/jpeg');
  assert.match(jpeg.nombre, /^nota-venta-.*\.jpg$/);
  assert.equal(png.mimeType, 'image/png');
  assert.match(png.nombre, /^nota-venta-.*\.png$/);
});

test('decodificarFoto rechaza lo que no es imagen', () => {
  const { ctx } = crearContexto();
  for (const valor of [
    'data:text/plain;base64,aGVsbG8=',
    'data:application/pdf;base64,aGVsbG8=',
    'aGVsbG8=',
    '',
    null,
  ]) {
    assert.equal(ctx.decodificarFoto(valor), null);
  }
});

test('decodificarFoto recorta a 1.5 MB', () => {
  const { ctx } = crearContexto();
  const base64 = 'A'.repeat(3 * 1024 * 1024);
  assert.equal(ctx.decodificarFoto('data:image/jpeg;base64,' + base64), null);
});

test('carpetaFotos crea la carpeta hermana una vez y la reutiliza', () => {
  const { ctx, propiedades } = crearContexto();
  let creaciones = 0;
  const original = ctx.DriveApp.getFileById;
  ctx.DriveApp.getFileById = () => ({
    getParentFolder: () => ({
      createFolder: (nombre) => {
        creaciones++;
        assert.equal(nombre, 'Fotos de ventas');
        return { getId: () => 'id-fotos' };
      },
    }),
  });

  assert.equal(ctx.carpetaFotos({ getId: () => 'hoja-1' }), 'id-fotos');
  assert.equal(propiedades.get('ID_CARPETA_FOTOS'), 'id-fotos');
  assert.equal(ctx.carpetaFotos({ getId: () => 'hoja-1' }), 'id-fotos');
  assert.equal(creaciones, 1);
  ctx.DriveApp.getFileById = original;
});

test('guardarFotoEnDrive devuelve la URL y comparte el archivo', () => {
  const { ctx, archivos } = crearContexto();
  const url = ctx.guardarFotoEnDrive(
    { fotoBase64: 'data:image/png;base64,aGVsbG8=' },
    { getId: () => 'hoja-1' },
  );

  assert.equal(url, 'https://drive.google.com/uc?export=view&id=archivo-0');
  assert.equal(archivos[0].archivo.access, ctx.DriveApp.Access.ANYONE_WITH_LINK);
  assert.equal(archivos[0].archivo.permission, ctx.DriveApp.Permission.VIEW);
});

test('guardarFotoEnDrive devuelve vacío sin datos y no crea archivo', () => {
  const { ctx, archivos } = crearContexto();
  assert.equal(ctx.guardarFotoEnDrive({}, { getId: () => 'hoja-1' }), '');
  assert.equal(archivos.length, 0);
});

test('guardarFotoEnDrive captura errores de Drive y los registra', () => {
  const { ctx, archivos } = crearContexto({
    createFile: () => { throw new Error('Drive caído'); },
  });
  assert.equal(
    ctx.guardarFotoEnDrive(
      { fotoBase64: 'data:image/jpeg;base64,aGVsbG8=' },
      { getId: () => 'hoja-1' },
    ),
    '',
  );
  assert.equal(archivos.length, 0);
  assert.equal(ctx.logs.some((log) => log.includes('Drive caído')), true);
});

test('una venta duplicada no sube una segunda foto a Drive', () => {
  const { ctx, archivos } = crearContexto();
  let crearArchivos = 0;
  ctx.DriveApp.getFileById = () => ({
    getParentFolder: () => ({
      createFolder: () => ({
        createFile: () => {
          crearArchivos++;
          throw new Error('no debe llamarse');
        },
        getId: () => 'id-fotos',
      }),
    }),
  });
  ctx.claveEsValida = () => true;
  ctx.validarOperacion = () => ({ ok: true, filaData: { costoUsd: 1 } });
  ctx.obtenerHoja = () => {};
  ctx.filaYaRegistrada = () => ({ fila: 7 });
  const respuesta = ctx.doPost({
    postData: { contents: JSON.stringify({
      apiKey: 'ok',
      tipoOperacion: 'VENTA',
      claveIdempotencia: 'venta-1',
      fotoBase64: 'data:image/jpeg;base64,aGVsbG8=',
      filaExcel: 2,
      cantidad: 1,
    }) },
  });

  assert.deepEqual(JSON.parse(respuesta.getContent()), {
    status: 'SUCCESS',
    message: 'YA_REGISTRADA',
    duplicada: true,
    filaExcelVenta: 7,
  });
  assert.equal(crearArchivos, 0);
  assert.equal(archivos.length, 0);
});

test('driveDisponible dice con que cuenta de Google corre el script', () => {
  // Esto es lo que sospechamos: el permiso se concedio con una cuenta, pero el
  // script se ejecuta con otra (el dueo del deployment). El diagnostico tiene
  // que decir CUAL, no solo que falta el permiso.
  const { ctx } = crearContexto();
  ctx.Session = {
    getEffectiveUser: () => ({ getEmail: () => 'dueno@jhsel.com' }),
    getActiveUser: () => ({ getEmail: () => '' }),
  };

  const resultado = ctx.driveDisponible();

  assert.equal(
    resultado.cuenta,
    'dueno@jhsel.com',
    'tiene que decir la cuenta que EFECTIVAMENTE ejecuta el script'
  );
});

test('driveDisponible no revienta si Session no esta disponible', () => {
  const { ctx } = crearContexto();
  ctx.Session = undefined;

  const resultado = ctx.driveDisponible();

  assert.equal(resultado.cuenta, '', 'si no se puede saber la cuenta, vacio y nada mas');
  assert.equal(resultado.ok, true, 'que no se pueda leer la cuenta no vuelve roja la foto');
});

test('driveDisponible dice que SI hay acceso a Drive cuando la carpeta de la hoja responde', () => {
  const { ctx } = crearContexto();
  // deepEqual no sirve: el objeto sale del sandbox de vm, con otro prototipo.
  const resultado = ctx.driveDisponible();
  assert.equal(resultado.ok, true);
  // El detalle dice la cuenta que corre el script: es la clave del bug de
  // permisos, asi que tiene que estar en el mensaje.
  assert.match(resultado.detalle, /^con acceso a Drive\./, 'arranca diciendo que hay acceso');
  assert.match(resultado.detalle, /Corriendo como:/, 'y dice con que cuenta corre');
});

test('driveDisponible usa la MISMA llamada que necesita la foto, no getFoldersByName', () => {
  const { ctx } = crearContexto();
  let getFoldersByName = 0;
  const getFileByIdReal = ctx.DriveApp.getFileById;
  let idPedido = null;
  ctx.DriveApp.getFoldersByName = () => {
    getFoldersByName += 1;
    throw new Error('no debe llamarse: recorre el Drive entero');
  };
  ctx.DriveApp.getFileById = (id) => {
    idPedido = id;
    return getFileByIdReal(id);
  };

  const resultado = ctx.driveDisponible();

  assert.equal(getFoldersByName, 0, 'getFoldersByName no debe usarse para diagnosticar');
  assert.equal(idPedido, 'hoja-1', 'debe pedir la carpeta de la hoja, como hace carpetaFotos');
  assert.equal(resultado.ok, true);
});

test('driveDisponible devuelve el ERROR REAL de Google, no un texto que supone la causa', () => {
  const { ctx } = crearContexto();
  ctx.DriveApp.getFileById = () => {
    throw new Error(
      'Exception: Access denied: DriveApp.getFileById(). The caller does not have permission.'
    );
  };

  const resultado = ctx.driveDisponible();

  assert.equal(resultado.ok, false);
  assert.match(
    resultado.detalle,
    /Access denied/,
    'el detalle debe traer el mensaje real de Google, no un texto que adivine la causa'
  );
  assert.doesNotMatch(
    resultado.detalle,
    /agrega el scope/,
    'no debe afirmar una causa que el script no conoce'
  );
});

test('driveDisponible no revienta aunque el error venga vacío', () => {
  const { ctx } = crearContexto();
  ctx.DriveApp.getFileById = () => {
    throw {};
  };

  const resultado = ctx.driveDisponible();

  assert.equal(resultado.ok, false);
  assert.ok(resultado.detalle.length > 0, 'siempre tiene que devolver algo legible');
});

test('el SALUD declara la version, para saber si este codigo ya esta desplegado', () => {
  const { ctx } = crearContexto();
  const respuesta = ctx.doGet({ parameter: { action: 'SALUD' } });
  const cuerpo = JSON.parse(respuesta.getContent());

  assert.equal(cuerpo.version, 7);
  assert.equal(cuerpo.drive.ok, true);
  assert.match(cuerpo.drive.detalle, /^con acceso a Drive\./);
});

// --- Autorizacion manual de Drive ---------------------------------------
// El scope de Drive nunca se concedio y el dialogo de Google no aparece
// nunca. getAuthorizationInfo() es la unica via de la propia plataforma
// para sacar una URL de consentimiento y que el humano la abra a mano.

function crearContextoConScriptApp(estado, llamadas) {
  const base = crearContexto();
  base.ctx.ScriptApp = {
    AuthMode: { FULL: 'FULL' },
    AuthorizationStatus: { AUTHORIZED: 'AUTHORIZED', NOT_AUTHORIZED: 'NOT_AUTHORIZED' },
    getAuthorizationInfo(authMode, scopes) {
      llamadas.push({ authMode, scopes });
      return {
        getAuthorizationStatus: () => estado,
        getAuthorizationUrl: () => 'https://accounts.google.com/o/oauth2/auth?scope=drive&project=abc',
      };
    },
  };
  return base;
}

test('urlDeAutorizacionDrive devuelve la URL para dar permiso de Drive a mano', () => {
  const llamadas = [];
  const { ctx } = crearContextoConScriptApp('NOT_AUTHORIZED', llamadas);

  const resultado = ctx.urlDeAutorizacionDrive();

  assert.equal(resultado.ok, false, 'todavia NO hay permiso, eso es lo que informamos');
  assert.match(resultado.url, /accounts\.google\.com/, 'tiene que ser la URL de consentimiento de Google');
  assert.match(resultado.detalle, /permiso/i);
});

test('urlDeAutorizacionDrive pide el scope de Drive completo con AuthMode FULL', () => {
  const llamadas = [];
  const { ctx } = crearContextoConScriptApp('NOT_AUTHORIZED', llamadas);

  ctx.urlDeAutorizacionDrive();

  assert.equal(llamadas.length, 1, 'tiene que preguntar una sola vez');
  assert.equal(llamadas[0].authMode, 'FULL');
  // El array de scopes nace dentro del sandbox vm, asi que tiene otro prototipo
  // y deepStrictEqual lo marca como distinto aunque los valores sean iguales.
  assert.equal(llamadas[0].scopes.length, 1, 'un solo scope, el de Drive completo');
  assert.equal(
    llamadas[0].scopes[0],
    'https://www.googleapis.com/auth/drive',
    'el scope exacto que exige DriveApp.getFileById'
  );
});

test('urlDeAutorizacionDrive avisa que ya hay permiso y no manda a autorizar de nuevo', () => {
  const llamadas = [];
  const { ctx } = crearContextoConScriptApp('AUTHORIZED', llamadas);

  const resultado = ctx.urlDeAutorizacionDrive();

  assert.equal(resultado.ok, true);
  assert.equal(resultado.url, '', 'ya autorizado: no hay que mandar a ningun lado');
});

test('urlDeAutorizacionDrive no revienta si la plataforma no responde', () => {
  const { ctx } = crearContexto();
  // AuthMode y AuthorizationStatus van en el stub porque el codigo los lee
  // ANTES de llamar a getAuthorizationInfo. Sin ellos el test reventaria por
  // AuthMode undefined y probaria otra cosa: no que el catch no revienta.
  ctx.ScriptApp = {
    AuthMode: { FULL: 'FULL' },
    AuthorizationStatus: { AUTHORIZED: 'AUTHORIZED' },
    getAuthorizationInfo() {
      throw new Error('no puedo preguntar los permisos');
    },
  };

  const resultado = ctx.urlDeAutorizacionDrive();

  assert.equal(resultado.ok, false);
  assert.match(resultado.detalle, /no puedo preguntar los permisos/, 'el error real, no una suposicion');
  assert.equal(resultado.url, '');
});

test('el SALUD declara la version 7 y trae la URL de autorizacion de Drive', () => {
  const llamadas = [];
  const { ctx } = crearContextoConScriptApp('NOT_AUTHORIZED', llamadas);

  const respuesta = ctx.doGet({ parameter: { action: 'SALUD' } });
  const cuerpo = JSON.parse(respuesta.getContent());

  assert.equal(cuerpo.version, 7);
  assert.equal(cuerpo.drive.ok, true);
  assert.equal(cuerpo.driveAuth.ok, false);
  assert.match(cuerpo.driveAuth.url, /accounts\.google\.com/);
});
