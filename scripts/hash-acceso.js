'use strict';

// Genera el hash de la clave compartida del candado (CLAVE_ACCESO_HASH).
// Se usa igual que hash-pin, pero acepta letras: "OpenMilo" no es un PIN.
//
// La clave en texto plano no se escribe en ningun archivo: pasa como argumento
// y lo unico que sale por pantalla es el hash.

const { hashearPassword } = require('../src/auth');

const clave = process.argv[2];

if (!clave) {
  console.error('Uso: npm run hash-acceso -- TU_CLAVE');
  process.exit(1);
}

if (clave.length < 6) {
  console.error('La clave debe tener al menos 6 caracteres.');
  process.exit(1);
}

console.log(hashearPassword(clave));
console.log('');
console.log('Copia esta linea como CLAVE_ACCESO_HASH en el servicio de Render.');
