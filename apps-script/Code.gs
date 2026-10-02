// =================================================================
// MOON ERP - BACKEND SEGURO (GOOGLE APPS SCRIPT)
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
  "ComisionBs", "Sucursal"
];

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
        version: 2
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
  }
  return hoja;
}

function registrarVenta(ss, data, calculo) {
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  hoja.appendRow([
    new Date(),
    sanitizarTexto(data.vendedor),
    sanitizarTexto(data.modelo),
    sanitizarTexto(data.tipo),
    parseInt(data.cantidad, 10) || 0,
    parseFloat(data.tipoCambio) || 0,
    parseFloat(data.precioUnitarioBs) || 0,
    calculo.costoTotalBs,
    parseFloat(data.totalCobrado) || 0,
    calculo.gananciaBs,
    parseFloat(data.comision) || 0,
    sanitizarTexto(data.sucursal)
  ]);
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

// Devuelve solo ventas. Ignora cualquier otro tipo de fila para que el
// reporte de ventas no se contamine.
function leerVentas() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet()
               .getSheetByName(NOMBRE_HOJA_VENTAS);
  if (!hoja) return [];

  var valores = hoja.getDataRange().getValues();
  var salida = [];

  for (var i = 1; i < valores.length; i++) {
    var f = valores[i];
    if (!f[0]) continue;
    if (String(f[3] || "") !== "VENTA") continue;

    salida.push({
      fecha: new Date(f[0]).toISOString(),
      vendedor: String(f[1] || ""),
      modelo: String(f[2] || ""),
      tipo: String(f[3] || ""),
      cantidad: Number(f[4]) || 0,
      tipoCambio: Number(f[5]) || 0,
      precioUnitarioBs: Number(f[6]) || 0,
      costoTotalBs: Number(f[7]) || 0,
      totalCobradoBs: Number(f[8]) || 0,
      gananciaBs: Number(f[9]) || 0,
      comisionBs: Number(f[10]) || 0,
      sucursal: String(f[11] || "")
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