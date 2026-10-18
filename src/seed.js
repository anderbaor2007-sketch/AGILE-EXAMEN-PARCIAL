// Datos iniciales (solo si la base está vacía): 2 usuarios y 4 categorías (sin pagos: se ingresan desde la aplicación).
// Las claves se pueden definir con GERENTE_CLAVE / ASISTENTE_CLAVE (recomendado en producción).
const { query } = require('./db');
const { hashClave } = require('./auth');

async function asegurarDatosIniciales() {
  if ((await query('SELECT COUNT(*)::int AS n FROM usuarios'))[0].n > 0) return;
  const u = 'INSERT INTO usuarios (nombre, correo, clave_hash, rol) VALUES ($1,$2,$3,$4)';
  await query(u, ['Gerente Castillo', 'Gerente@castillo.pe', hashClave(process.env.GERENTE_CLAVE || 'gerente123'), 'GERENTE']);
  await query(u, ['Asistente Castillo', 'Asistente@castillo.pe', hashClave(process.env.ASISTENTE_CLAVE || 'asistente123'), 'ASISTENTE']);
  for (const c of ['Servicios', 'Proveedores', 'Impuestos', 'Préstamos']) await query('INSERT INTO categorias (nombre) VALUES ($1)', [c]);

  console.log('Datos iniciales creados.');
}

module.exports = { asegurarDatosIniciales };
