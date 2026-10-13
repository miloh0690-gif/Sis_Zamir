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
