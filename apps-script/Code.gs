// =================================================================
// JHSEL TECH MOBILES - BACKEND SEGURO (GOOGLE APPS SCRIPT)
// Sirve inventario y registra ventas / consignaciones.
// =================================================================
//
// QUE SE CORRIGIO RESPECTO A LA VERSION QUE ME PASASTE:
//
// 1. SE QUITO EL LOGIN CON TOKEN DE SESION. Ese flujo no encajaba: el
//    unico cliente es el servidor de Render, que ya tiene su propia
//    autenticacion (PIN con hash + cookie firmada). Pedir un token
//    aparte agregaba una capa sin ganho y dependia de CacheService,
//    que puede evictar la sesion y romper el inventario al azar.
//    Ahora la proteccion es una CLAVE COMPARTIDA entre Render y este
//    script.
//
// 2. BUG DE LA GANANCIA. La formula anterior era:
//
//        ganancia = totalCobrado - (costoUsd * cantidad)
//
//    Eso multiplica dolares por unidades y RESTA BOLIVIANOS de
//    DOLARES, asi que la ganancia quedaba siempre Gigante y el reporte
//    no cuadraba. Ahora:
//
//        costoTotalBs  = costoUsd * tipoCambio * cantidad
//        gananciaBs    = totalCobradoBs - costoTotalBs
//
// 3. SE AGREGO LA COMISION AL HISTORIAL. La version anterior guardaba 7
//    columnas y la comision nunca se guardaba, por eso los reportes de
//    comisiones salian en 0. Ahora la hoja "Ventas" tiene 12 columnas
//    e incluye ComisionBs.
//
// 4. SE AGREGARON LAS CONSULTAS DE REPORTE. Faltaban por completo, asi
//    que el historial era de solo escritura y no se podia leer de vuelta.
//
// 5. AHORA HAY VALIDACION DE STOCK EN EL SCRIPT. Antes solo se
//    limitaba a poner 0 si el stock daba negativo, con lo cual se
//    vendian equipos que no existian.
//
// 6. CONSIGNACIONES EN SU PROPIA HOJA Y CON ID. Antes iban mezcladas en
//    la hoja "Ventas" con ganancia 0, lo que contaminaba el reporte de
//    ventas. Ahora cada consignacion tiene id y el lector se queda con
//    el ultimo estado de cada id.
//
// 7. SE MANTUVO: validacion de filaExcel, el chequeo de que el modelo
//    de esa fila no haya cambiado, la sanitizacion anti-formulas y el
//    limite de cantidad por operacion.
//
// 8. BUG QUE HACIA INUTILIZABLE EL REPORTE DE VENTAS. leerVentas() tiene
//    que quedarse solo con las filas de venta, porque antes las
//    consignaciones se guardaban en la misma hoja. Para eso descartaba
//    toda fila cuya columna "Tipo" no fuera exactamente "VENTA". Pero la
//    columna Tipo guarda UNIDAD o MAYOR (ver normalizarTipo en money.js),
//    nunca "VENTA": el filtro descartaba el 100% de las filas. El reporte
//    devolvia una lista vacia siempre. Ahora:
//      a) las columnas se buscan POR ENCABEZADO, no por posicion, asi que
//         agregar o reordenar columnas ya no rompe la lectura, y
//      b) el filtro acepta VENTA, UNIDAD y MAYOR.
//
// 9. IDEMPOTENCIA. Se agrego la columna "ClaveIdempotencia" a la hoja
//    "Ventas". El servidor de Render manda una clave distinta por cada
//    intento de cobro y la REUTILIZA si reintenta. Antes de tocar el stock
//    el script busca esa clave: si ya esta, responde que ya se registro y
//    no duplica ni la venta ni el descuento de stock. Sin esto, un doble
//    toque o un reintento tras un timeout cobraba dos veces.
//
// 10. La hoja se completa sola. Si le falta un encabezado (por ejemplo
//    ClaveIdempotencia en una hoja que ya existia), el script lo agrega al
//    desplegar. No hay que tocar la hoja a mano.
//
// -----------------------------------------------------------------
// CONFIGURACION INICIAL (una sola vez, en este orden):
//
//   a) Genera una clave:
//        Ejecuta generarClaveCompartida() una vez y copiala del log.
//
//   b) Configuracion del proyecto -> Propiedades del script ->
//      AGREGAR PROPIEDAD:
//        Nombre:  SHEETS_API_KEY
//        Valor:   (la clave del paso a)
//
//   c) En Render, AGREGAR VARIABLE DE ENTORNO:
//        SHEETS_WEBAPP_URL = tu URL /exec
//        SHEETS_API_KEY    = la MISMA clave del paso a)
//
//   d) Desplegar: Implementar -> Nueva implementacion ->
//      Ejecutar como: Yo    |    Quien tiene acceso: Cualquier persona
//
//   e) Borrar (o comentar) la funcion generarClaveCompartida().
//
// NOTA: la clave viaja en la URL (?key=...) en las lecturas y en el
// cuerpo JSON (apiKey) en las escrituras, porque Apps Script no expone
// los encabezados HTTP de la peticion. El backend de Render ya lo hace
// asi; si alguien mas llama al script, tiene que mandar la clave igual.
// =================================================================

var NOMBRE_HOJA_INVENTARIO = "Inventario";
var NOMBRE_HOJA_VENTAS = "Ventas";
var NOMBRE_HOJA_CONSIGNACIONES = "Consignaciones";

// Tope de unidades por operacion. Ajustar segun tu operacion real.
var CANTIDAD_MAXIMA_POR_OPERACION = 500;

var ENCABEZADO_VENTAS = [
  "Fecha", "Vendedor", "Modelo", "Tipo", "Cantidad", "TC",
  "PrecioUnitarioBs", "CostoTotalBs", "TotalBs", "GananciaBs",
  "ComisionBs", "Sucursal", "ClaveIdempotencia"
];

// Valores que la columna "Tipo" puede tener en una fila de VENTA.
// "VENTA" queda por compatibilidad con las filas que escribio la version
// vieja del script; las actuales ponen UNIDAD o MAYOR (normalizarTipo en
// src/money.js del servidor).
var TIPOS_DE_VENTA = { "VENTA": true, "UNIDAD": true, "MAYOR": true };

var ENCABEZADO_CONSIGNACIONES = [
  "Fecha", "Cliente", "Modelo", "Cantidad", "Sucursal", "Estado",
  "Id", "FilaExcel"
];


// =================================================================
// AUTENTICACION: clave compartida con el servidor de Render
// =================================================================

function claveEsValida(recibida) {
  var secreto = PropertiesService.getScriptProperties().getProperty("SHEETS_API_KEY");
  if (!secreto) return false;

  var valor = String(recibida === undefined || recibida === null ? "" : recibida);
  if (valor.length !== secreto.length) return false;

  // Comparacion de tiempo casi constante para no filtrar la clave por
  // la diferencia de tiempo de respuesta.
  var diferencia = 0;
  for (var i = 0; i < secreto.length; i++) {
    diferencia |= secreto.charCodeAt(i) ^ valor.charCodeAt(i);
  }
  return diferencia === 0;
}

/**
 * Ejecutar UNA SOLA VEZ. Copia el valor al log y luego borra esta funcion.
 */
function generarClaveCompartida() {
  var clave = Utilities.getUuid().replace(/-/g, "") +
              Utilities.getUuid().replace(/-/g, "");
  Logger.log("SHEETS_API_KEY = " + clave);
}


// =================================================================
// 1. LECTURA: inventario
// =================================================================

function doGet(e) {
  try {
    var parametros = (e && e.parameter) ? e.parameter : {};
    var accion = String(parametros.action || "").toUpperCase();

    if (accion === "SALUD") {
      return responderJSON({
        ok: true,
        hora: new Date().toISOString(),
        version: 3
      });
    }

    if (!claveEsValida(parametros.key)) {
      return responderJSON({ error: "NO_AUTORIZADO" });
    }

    var hoja = SpreadsheetApp.getActiveSpreadsheet()
                 .getSheetByName(NOMBRE_HOJA_INVENTARIO);
    if (!hoja) {
      return responderJSON({
        error: "No se encontro la pestaña '" + NOMBRE_HOJA_INVENTARIO +
               "'. Revisa el nombre exacto de tu hoja."
      });
    }

    var datos = hoja.getDataRange().getValues();
    var inventario = [];

    for (var i = 1; i < datos.length; i++) {
      var fila = datos[i];
      if (!fila[0]) continue;

      inventario.push({
        filaExcel: i + 1,
        modelo: String(fila[0] || "").trim(),
        sucursal: String(fila[1] || "").trim(),
        stock: parseInt(fila[2], 10) || 0,
        costoUsd: parseFloat(fila[3]) || 0
      });
    }

    return responderJSON(inventario);

  } catch (error) {
    return responderJSON({ error: "ERROR: " + error.toString() });
  }
}


// =================================================================
// 2. ESCRITURAS: ventas, consignaciones y consultas de reporte
// =================================================================

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return responderJSON({
      status: "ERROR",
      message: "Cuerpo de la peticion invalido"
    });
  }

  if (!claveEsValida(data.apiKey)) {
    return responderJSON({ status: "ERROR", message: "NO_AUTORIZADO" });
  }
  delete data.apiKey;

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- Consultas de solo lectura (no necesitan lock) ---
  if (data.tipoOperacion === "REPORTE_VENTAS") {
    return responderJSON(leerVentas());
  }
  if (data.tipoOperacion === "REPORTE_CONSIGNACIONES") {
    return responderJSON(leerConsignaciones());
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    var hojaInventario = ss.getSheetByName(NOMBRE_HOJA_INVENTARIO);
    if (!hojaInventario) {
      return responderJSON({
        status: "ERROR",
        message: "No se encontro la pestaña '" + NOMBRE_HOJA_INVENTARIO + "'."
      });
    }

    // Solo escribe el historial de la consignacion, sin tocar stock.
    if (data.tipoOperacion === "CONSIGNACION_LOG") {
      registrarLogConsignacion(ss, data);
      return responderJSON({ status: "SUCCESS", message: "OK" });
    }

    var validacion = validarOperacion(hojaInventario, data);
    if (!validacion.ok) {
      return responderJSON({ status: "ERROR", message: validacion.mensaje });
    }

    if (data.tipoOperacion === "VENTA") {
      // La columna ClaveIdempotencia tiene que existir ANTES de buscar
      // duplicados, y no al escribir la fila: si la hoja ya existia, el
      // encabezado se agrega recien en registrarVenta, y el chequeo de
      // duplicados no serviria de nada en la primera venta.
      obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);

      // Idempotencia: si esta venta ya se escribio con la misma clave, se
      // responde que ya estaba y no se toca el stock ni se agrega otra
      // fila. Va antes que la validacion a proposito: si el reintento
      // llega cuando el stock ya bajo por esa misma venta, la validacion
      // lo rechazaria por "stock insuficiente" y el vendedor veria un
      // error donde en realidad ya cobro bien.
      var repetida = filaYaRegistrada(ss, NOMBRE_HOJA_VENTAS, "ClaveIdempotencia", data.claveIdempotencia);
      if (repetida) {
        return responderJSON({
          status: "SUCCESS",
          message: "YA_REGISTRADA",
          duplicada: true,
          filaExcelVenta: repetida.fila
        });
      }

      var tipoCambio = parseFloat(data.tipoCambio) || 0;
      var costoUsd = validacion.filaData.costoUsd;
      var cantidad = parseInt(data.cantidad, 10) || 0;
      var totalBs = parseFloat(data.totalCobrado) || 0;

      // Aca estaba el bug: falta el tipo de cambio.
      var costoTotalBs = costoUsd * tipoCambio * cantidad;
      var gananciaBs = totalBs - costoTotalBs;

      actualizarStock(hojaInventario, data.filaExcel, -cantidad);
      registrarVenta(ss, data, {
        costoTotalBs: costoTotalBs,
        gananciaBs: gananciaBs
      });
    }

    else if (data.tipoOperacion === "CONSIGNACION") {
      // El Id lo genera el servidor UNA vez por operacion. Si vuelve a
      // llegar el mismo Id, el doble toque ya desconto stock: no se
      // toca el stock otra vez.
      if (data.subTipo === "DESPACHO" || data.subTipo === "DEVOLUCION") {
        obtenerHoja(ss, NOMBRE_HOJA_CONSIGNACIONES, ENCABEZADO_CONSIGNACIONES);
        var yaConsignada = filaYaRegistrada(
          ss, NOMBRE_HOJA_CONSIGNACIONES, "Id", data.id
        );
        if (yaConsignada) {
          return responderJSON({
            status: "SUCCESS",
            message: "YA_REGISTRADA",
            duplicada: true,
            filaExcelConsignacion: yaConsignada.fila
          });
        }
      }

      if (data.subTipo === "DESPACHO") {
        actualizarStock(hojaInventario, data.filaExcel, -data.cantidad);
        registrarLogConsignacion(ss, data);
      }
      else if (data.subTipo === "DEVOLUCION") {
        actualizarStock(hojaInventario, data.filaExcel, data.cantidad);
        registrarLogConsignacion(ss, data);
      }
      else if (data.subTipo === "CAMBIO_ESTADO") {
        registrarLogConsignacion(ss, data);
      }
    }

    return responderJSON({ status: "SUCCESS", message: "Procesado correctamente" });

  } catch (error) {
    return responderJSON({ status: "ERROR", message: error.toString() });
  } finally {
    lock.releaseLock();
  }
}


// =================================================================
// HISTORIAL
// =================================================================

function obtenerHoja(ss, nombre, encabezados) {
  var hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre);
    hoja.appendRow(encabezados);
    hoja.getRange(1, 1, 1, encabezados.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  } else {
    asegurarEncabezados(hoja, encabezados);
  }
  return hoja;
}

/**
 * Agrega los encabezados que falten, sin tocar los que ya estan.
 *
 * Existe porque una hoja que ya existe nunca se "actualiza": si el
 * encabezado nuevo (ClaveIdempotencia) no aparece en la fila 1, la
 * columna queda sin nombre y la lectura por nombre no la encuentra.
 * Asi el que despliega el script no tiene que agregar columnas a mano.
 */
function asegurarEncabezados(hoja, encabezados) {
  var ultima = hoja.getLastColumn();
  var cab = hoja.getRange(1, 1, 1, Math.max(ultima, 1)).getValues()[0];

  for (var i = 0; i < encabezados.length; i++) {
    var nombre = String(encabezados[i]);
    var yaEsta = false;

    for (var j = 0; j < ultima; j++) {
      if (String(cab[j] || "").trim().toLowerCase() === nombre.toLowerCase()) {
        yaEsta = true;
        break;
      }
    }
    if (yaEsta) continue;

    ultima = ultima + 1;
    hoja.getRange(1, ultima).setValue(nombre);
    Logger.log("Columna agregada a '" + hoja.getName() + "': " + nombre);
  }
}

/**
 * Posicion de una columna POR SU NOMBRE.
 *
 * Leer por indice fijo se rompio en cuanto se agrego una columna. Con el
 * nombre, reordenar o agregar columnas no afecta la lectura.
 */
function columna(cab, nombre, porDefecto) {
  for (var i = 0; i < cab.length; i++) {
    if (String(cab[i] || "").trim().toLowerCase() === String(nombre).toLowerCase()) {
      return i;
    }
  }
  // La hoja es vieja y no tiene el encabezado: se usa la posicion de
  // siempre, que es la que tenia cuando se escribieron esas filas.
  return porDefecto;
}

function celda(fila, indice) {
  return indice >= 0 && indice < fila.length ? fila[indice] : "";
}

/**
 * Una fila esta CORRIDA si la escribio la version vieja de registrarVenta,
 * que usaba appendRow con una lista fija de 13 valores.
 *
 * Esa version escribia posicional contra el layout real de la hoja (que tiene
 * 15 columnas y Fecha no es la primera), asi que todo quedo corrido: la Fecha
 * quedo bajo "Vendedor", el costo bajo "Fecha", y TotalBs/GananciaBs/
 * ComisionBs quedaron vacios porque las columnas que el script creia_fill no
 * son las de la hoja. El reporte salia con todo en 0.
 *
 * La senal es una sola y es fiable: la version vieja escribia la fecha en la
 * posicion 0, y en la hoja real la posicion 0 es la columna "Vendedor". O
 * sea, una fila corrida SIEMPRE tiene una fecha donde deberia ir el nombre.
 * Una fila escrita bien trae una Date en su columna Fecha y un nombre de
 * persona en la de Vendedor, y se descarta.
 */
function filaCorrida(fila, cFecha, cVendedor) {
  if (celda(fila, cFecha) instanceof Date) return false;

  var enVendedor = celda(fila, cVendedor);
  if (enVendedor instanceof Date) return true;
  return typeof enVendedor === "string" &&
    /GMT|UTC|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(enVendedor);
}

/**
 * Escribe la venta POR NOMBRE DE COLUMBA, no por posicion.
 *
 * Importa porque la hoja de Ventas del cliente tiene su propio orden: trae
 * dos columnas que el script no conoce (TotalCobrado y GananciaEquipo) y la
 * Fecha no es la primera. Antes se escribia con appendRow y una lista fija
 * de 13 valores, asi que cada venta caia corrida: la Fecha se guardaba bajo
 * "Vendedor", el costo bajo "Fecha", la ganancia bajo "PrecioUnitarioBs" y
 * los importes que faltaban quedaban vacios. De ahi que el reporte del
 * Dueño saliera con todo en 0 y los nombres mezclados.
 */
function registrarVenta(ss, data, calculo) {
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  var cab = hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), 1)).getValues()[0];

  var porNombre = {};
  porNombre.Fecha = new Date();
  porNombre.Vendedor = sanitizarTexto(data.vendedor);
  porNombre.Modelo = sanitizarTexto(data.modelo);
  porNombre.Tipo = sanitizarTexto(data.tipo);
  porNombre.Cantidad = parseInt(data.cantidad, 10) || 0;
  porNombre.TC = parseFloat(data.tipoCambio) || 0;
  porNombre.PrecioUnitarioBs = parseFloat(data.precioUnitarioBs) || 0;
  porNombre.CostoTotalBs = calculo.costoTotalBs;
  porNombre.TotalBs = parseFloat(data.totalCobrado) || 0;
  porNombre.GananciaBs = calculo.gananciaBs;
  porNombre.ComisionBs = parseFloat(data.comision) || 0;
  porNombre.Sucursal = sanitizarTexto(data.sucursal);
  porNombre.ClaveIdempotencia = sanitizarTexto(data.claveIdempotencia);

  var ancho = Math.max(hoja.getLastColumn(), ENCABEZADO_VENTAS.length);
  var fila = [];
  for (var i = 0; i < ancho; i++) {
    var clave = String(cab[i] || "").trim();
    fila.push(clave && porNombre.hasOwnProperty(clave) ? porNombre[clave] : "");
  }

  hoja.appendRow(fila);
}

/**
 * Busca si ya hay una fila con esta clave de idempotencia.
 *
 * Se llama con el lock tomado, adentro del mismo doPost, antes de tocar
 * el stock. Es la segunda capa: la primera es la cache en memoria del
 * servidor de Render, que se pierde si el servidor reinicia. Esta cubre
 * ese caso, porque la clave quedo escrita en la hoja.
 *
 * Sirve para las dos hojas: "Ventas" por ClaveIdempotencia y
 * "Consignaciones" por Id. Un doble toque en consignar tambien
 * descuenta stock dos veces.
 */
function filaYaRegistrada(ss, nombreHoja, nombreColumna, clave) {
  var limpio = String(clave === undefined || clave === null ? "" : clave).trim();
  if (!limpio) return null;

  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja || hoja.getLastRow() < 2) return null;

  var cab = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  // -1 y no una posicion por defecto: si la columna no existe, NO se lee
  // una columna cualquiera. Es preferible no deduplicar (y avisar) que
  // deduplicar comparando contra la columna equivocada.
  var indice = columna(cab, nombreColumna, -1);
  if (indice < 0) {
    Logger.log("AVISO: la hoja '" + nombreHoja + "' no tiene la columna " +
               nombreColumna + ". Re-despliega el script para que se agregue sola.");
    return null;
  }

  var valores = hoja
    .getRange(2, indice + 1, hoja.getLastRow() - 1, 1)
    .getValues();

  for (var i = 0; i < valores.length; i++) {
    if (String(valores[i][0] || "").trim() === limpio) {
      return { fila: i + 2 };
    }
  }
  return null;
}

// El historial de consignaciones es un registro de cambios: se escribe
// una fila por evento y el lector se queda con el ultimo estado de cada id.
function registrarLogConsignacion(ss, data) {
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_CONSIGNACIONES, ENCABEZADO_CONSIGNACIONES);
  hoja.appendRow([
    new Date(),
    sanitizarTexto(data.cliente),
    sanitizarTexto(data.modelo),
    parseInt(data.cantidad, 10) || 0,
    sanitizarTexto(data.sucursal),
    sanitizarTexto(data.estado),
    sanitizarTexto(data.id),
    data.filaExcel === undefined ? "" : data.filaExcel
  ]);
}

// Devuelve solo ventas, para que el reporte de ventas no se contamine.
//
// OJO, esta funcion estuvo rota y por eso el reporte salia VACIO: pedia
// que la columna Tipo fuera exactamente "VENTA", pero ahi va UNIDAD o
// MAYOR (normalizarTipo en src/money.js del servidor de Render). Como no
// hubo ninguna fila que cumpliera eso, descartaba todas. Ahora:
//   - las columnas se ubican por encabezado, no por posicion, y
//   - se aceptan VENTA (filas viejas), UNIDAD y MAYOR (filas nuevas).
function leerVentas() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet()
               .getSheetByName(NOMBRE_HOJA_VENTAS);
  if (!hoja) return [];

  var valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return [];

  var cab = valores[0];
  var cFecha    = columna(cab, "Fecha", 0);
  var cVendedor = columna(cab, "Vendedor", 1);
  var cModelo   = columna(cab, "Modelo", 2);
  var cTipo     = columna(cab, "Tipo", 3);
  var cCantidad = columna(cab, "Cantidad", 4);
  var cTC       = columna(cab, "TC", 5);
  var cPrecio   = columna(cab, "PrecioUnitarioBs", 6);
  var cCosto    = columna(cab, "CostoTotalBs", 7);
  var cTotal    = columna(cab, "TotalBs", 8);
  var cGanancia = columna(cab, "GananciaBs", 9);
  var cComision = columna(cab, "ComisionBs", 10);
  var cSucursal = columna(cab, "Sucursal", 11);

  var salida = [];

  // Posiciones con las que escribia la version VIEJA de registrarVenta.
  // Se usan solo para las filas que quedaron corridas, para poder leerlas
  // bien sin tocar la hoja a mano.
  var VIEJO = {
    fecha: 0, vendedor: 1, modelo: 2, tipo: 3, cantidad: 4, tc: 5,
    precio: 6, costo: 7, total: 8, ganancia: 9, comision: 10, sucursal: 11
  };

  for (var i = 1; i < valores.length; i++) {
    var f = valores[i];

    var corrida = filaCorrida(f, cFecha, cVendedor);
    var col = corrida
      ? {
          fecha: VIEJO.fecha, vendedor: VIEJO.vendedor, modelo: VIEJO.modelo,
          tipo: VIEJO.tipo, cantidad: VIEJO.cantidad, tc: VIEJO.tc,
          precio: VIEJO.precio, costo: VIEJO.costo, total: VIEJO.total,
          ganancia: VIEJO.ganancia, comision: VIEJO.comision, sucursal: VIEJO.sucursal
        }
      : {
          fecha: cFecha, vendedor: cVendedor, modelo: cModelo, tipo: cTipo,
          cantidad: cCantidad, tc: cTC, precio: cPrecio, costo: cCosto,
          total: cTotal, ganancia: cGanancia, comision: cComision, sucursal: cSucursal
        };

    var fechaCruda = celda(f, col.fecha);
    if (!fechaCruda) continue;

    // Si la hoja tiene columna Tipo, se usa para separar. Si no la tiene,
    // no se filtra nada: la hoja "Ventas" es solo de ventas.
    var tipo = String(celda(f, col.tipo) || "").trim().toUpperCase();
    if (tipo && !TIPOS_DE_VENTA[tipo]) continue;

    var fecha = fechaCruda;
    try {
      fecha = new Date(fechaCruda).toISOString();
    } catch (e) {
      continue;
    }
    if (isNaN(new Date(fechaCruda).getTime())) continue;

    salida.push({
      fecha: fecha,
      vendedor: String(celda(f, col.vendedor) || ""),
      modelo: String(celda(f, col.modelo) || ""),
      tipo: tipo || "UNIDAD",
      cantidad: Number(celda(f, col.cantidad)) || 0,
      tipoCambio: Number(celda(f, col.tc)) || 0,
      precioUnitarioBs: Number(celda(f, col.precio)) || 0,
      costoTotalBs: Number(celda(f, col.costo)) || 0,
      totalCobradoBs: Number(celda(f, col.total)) || 0,
      gananciaBs: Number(celda(f, col.ganancia)) || 0,
      comisionBs: Number(celda(f, col.comision)) || 0,
      sucursal: String(celda(f, col.sucursal) || "")
    });
  }

  return salida;
}

// Colapsa el registro de cambios: una fila por consignacion, con el
// ultimo estado conocido.
function leerConsignaciones() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet()
               .getSheetByName(NOMBRE_HOJA_CONSIGNACIONES);
  if (!hoja) return [];

  var valores = hoja.getDataRange().getValues();
  var porId = {};
  var orden = [];

  for (var i = 1; i < valores.length; i++) {
    var f = valores[i];
    if (!f[0]) continue;
    var id = String(f[6] || "");
    if (!id) continue;

    if (!porId[id]) orden.push(id);
    porId[id] = {
      id: id,
      fecha: new Date(f[0]).toISOString(),
      cliente: String(f[1] || ""),
      modelo: String(f[2] || ""),
      cantidad: Number(f[3]) || 0,
      sucursal: String(f[4] || ""),
      estado: String(f[5] || "Pendiente"),
      filaExcel: f[7]
    };
  }

  var salida = [];
  for (var j = 0; j < orden.length; j++) {
    salida.push(porId[orden[j]]);
  }
  return salida;
}


// =================================================================
// VALIDACION ANTES DE TOCAR LA HOJA
// =================================================================

function validarOperacion(hojaInventario, data) {
  var cantidad = parseInt(data.cantidad, 10);
  if (!cantidad || cantidad <= 0 || cantidad > CANTIDAD_MAXIMA_POR_OPERACION) {
    return {
      ok: false,
      mensaje: "Cantidad invalida (debe ser un numero positivo, maximo " +
               CANTIDAD_MAXIMA_POR_OPERACION + ")"
    };
  }

  // CAMBIO_ESTADO no mueve stock, asi que no necesita fila valida.
  if (data.subTipo === "CAMBIO_ESTADO") {
    return { ok: true, filaData: null };
  }

  var filaExcel = parseInt(data.filaExcel, 10);
  var totalFilas = hojaInventario.getLastRow();

  if (!filaExcel || filaExcel < 2 || filaExcel > totalFilas) {
    return { ok: false, mensaje: "Referencia de fila invalida" };
  }

  var filaReal = hojaInventario.getRange(filaExcel, 1, 1, 4).getValues()[0];
  var modeloEnHoja = String(filaReal[0] || "").trim();
  var modeloRecibido = String(data.modelo || "").trim();

  // Si alguien borro o movio filas en la hoja, el numero ya no apunta al
  // producto que el cliente cree. Se rechaza en vez de tocar otro.
  if (!modeloEnHoja || modeloEnHoja !== modeloRecibido) {
    return {
      ok: false,
      mensaje: "El producto de esa fila cambio (posible fila movida o eliminada). " +
               "Actualiza el inventario e intenta de nuevo."
    };
  }

  var stock = parseInt(filaReal[2], 10) || 0;
  var esDevolucion = data.subTipo === "DEVOLUCION";
  var saldo = esDevolucion ? stock + Math.abs(cantidad) : stock - Math.abs(cantidad);

  // Antes el script solo truncaba en 0 y dejaba vender inexistentes.
  if (saldo < 0) {
    return {
      ok: false,
      mensaje: "Stock insuficiente en la hoja: quedan " + stock + " unidades."
    };
  }

  return {
    ok: true,
    filaData: {
      modelo: modeloEnHoja,
      stock: stock,
      costoUsd: parseFloat(filaReal[3]) || 0
    }
  };
}

// Suma o resta unidades al stock de una fila puntual, sin bajar de 0.
function actualizarStock(hojaInventario, filaExcel, cantidad) {
  if (!filaExcel) return;
  var celda = hojaInventario.getRange(filaExcel, 3); // Columna C = Stock
  var stockActual = parseInt(celda.getValue(), 10) || 0;
  var nuevoStock = stockActual + cantidad;
  celda.setValue(nuevoStock >= 0 ? nuevoStock : 0);
}


// =================================================================
// UTILIDADES
// =================================================================

function responderJSON(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

// Evita que un texto que empieza con =, +, - o @ sea interpretado como
// formula por Google Sheets (inyeccion de formulas / CSV injection).
function sanitizarTexto(valor) {
  var texto = String(
    valor === undefined || valor === null ? "" : valor
  ).slice(0, 200);

  if (/^[=+\-@]/.test(texto)) {
    return "'" + texto;
  }
  return texto;
}