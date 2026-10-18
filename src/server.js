const { iniciarEsquema } = require('./db');
const { asegurarDatosIniciales } = require('./seed');
const server = require('./app');
const PORT = process.env.PORT || 3000;

iniciarEsquema()
  .then(asegurarDatosIniciales)
  .then(() => server.listen(PORT, () => console.log(`Sistema de egresos Castillo en http://localhost:${PORT}`)))
  .catch((e) => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
