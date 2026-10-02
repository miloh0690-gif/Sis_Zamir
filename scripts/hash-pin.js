'use strict';

const { hashearPin } = require('../src/auth');

const pin = process.argv[2];

if (!pin) {
  console.error('Uso: npm run hash-pin -- TU_PIN');
  console.error('Ejemplo: npm run hash-pin -- 1234');
  process.exit(1);
}

if (!/^\d{4,12}$/.test(pin)) {
  console.error('El PIN debe tener entre 4 y 12 digitos.');
  process.exit(1);
}

console.log(hashearPin(pin));
console.log('');
console.log('Copia esta linea como ADMIN_PIN_HASH en el servicio de Render.');