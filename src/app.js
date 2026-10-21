// Servidor HTTP mínimo (sin Express): enrutado, sesión por cookie, roles, archivos estáticos.
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const h = require('./handlers/pagos');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// [método, patrón, rol requerido (null = cualquier sesión), handler]
const RUTAS = [
  ['GET',  /^\/api\/panel$/,                          'GERENTE',   h.panel],            // HU-02
  ['GET',  /^\/api\/pagos$/,                          'ASISTENTE', h.listar],           // HU-04
  ['GET',  /^\/api\/pagos\/por-vencer$/,              'ASISTENTE', h.porVencer],        // HU-08 (y aviso HU-09)
  ['GET',  /^\/api\/pagos\/categorias$/,              'ASISTENTE', h.categorias],
  ['POST', /^\/api\/pagos\/verificar$/,               'ASISTENTE', h.verificar],        // HU-05 (aviso de repetido)
  ['POST', /^\/api\/pagos$/,                          'ASISTENTE', h.crear],            // HU-05
  ['GET',  /^\/api\/pagos\/(?<id>\d+)\/detalle$/,     null,        h.detalle],          // Ver detalles (gerente y asistente)
  ['POST', /^\/api\/pagos\/(?<id>\d+)\/congelar$/,      'GERENTE',   h.congelar],         // Congelar un pago
  ['POST', /^\/api\/pagos\/(?<id>\d+)\/descongelar$/,   'GERENTE',   h.descongelar],
  ['PUT',  /^\/api\/pagos\/(?<id>\d+)\/pagar$/,       'ASISTENTE', h.pagar],            // HU-06
  ['PUT',  /^\/api\/pagos\/(?<id>\d+)\/evidencia$/,   'ASISTENTE', h.cambiarEvidencia], // HU-07
  ['GET',  /^\/api\/pagos\/(?<id>\d+)\/evidencias$/,  'GERENTE',   h.infoEvidencias],   // HU-03
  ['GET',  /^\/api\/evidencias\/(?<id>\d+)$/,         'GERENTE',   h.verArchivo],       // HU-03 (ver/descargar)
];

function leerCuerpo(req, max) {
  return new Promise((ok, fallo) => {
    const trozos = []; let total = 0;
    req.on('data', (t) => {
      total += t.length;
      if (total <= max) trozos.push(t);
      else if (total > 40 * 1024 * 1024) { fallo(Object.assign(new Error('grande'), { status: 413 })); req.destroy(); } // corte duro
    });
    // Si se pasó del límite se sigue leyendo (descartando) para poder responder 413 con un mensaje claro
    req.on('end', () => (total > max ? fallo(Object.assign(new Error('grande'), { status: 413 })) : ok(Buffer.concat(trozos))));
    req.on('error', fallo);
  });
}

const responder = (res, status, json, cabeceras = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cabeceras });
  res.end(JSON.stringify(json));
};

async function manejar(req, res) {
  const url = new URL(req.url, 'http://x');

  // Archivos estáticos del frontend
  if (!url.pathname.startsWith('/api/')) {
    const archivo = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!archivo.startsWith(PUBLIC) || !fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(archivo)] || 'application/octet-stream' });
    return fs.createReadStream(archivo).pipe(res);
  }

  // Salud: lo usan Render y el monitor de 24/7 (hace una consulta real para mantener despierta también la base)
  if (req.method === 'GET' && url.pathname === '/api/salud') {
    await require('./db').query('SELECT 1');
    return responder(res, 200, { ok: true });
  }

  // Autenticación
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const b = JSON.parse((await leerCuerpo(req, 10_000)).toString() || '{}');
    const usuarioTxt = String(b.usuario ?? ''); const claveTxt = String(b.clave ?? '');
    const falta = {};
    if (!usuarioTxt.trim()) falta.usuario = 'Ingrese usuario'; else if (/\s/.test(usuarioTxt)) falta.usuario = 'El usuario no puede contener espacios en blanco';
    if (!claveTxt) falta.clave = 'Ingrese contraseña';
    if (Object.keys(falta).length) {
      const vacios = !usuarioTxt.trim() && !claveTxt;
      return responder(res, 400, { error: vacios ? 'Ingrese usuario y contraseña' : 'Revise los datos ingresados', campos: falta });
    }
    const r = await auth.login(b.usuario, b.clave);
    if (!r) return responder(res, 401, { error: 'Las credenciales no son válidas' });
    return responder(res, 200, r.usuario, { 'Set-Cookie': `token=${encodeURIComponent(r.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800` });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') return responder(res, 200, { ok: true }, { 'Set-Cookie': 'token=; HttpOnly; Path=/; Max-Age=0' });

  const usuario = await auth.usuarioDe(req);
  if (!usuario) return responder(res, 401, { error: 'Inicia sesión' });
  if (usuario.reemplazada) return responder(res, 401, { error: 'Tu sesión se cerró porque se inició sesión con este usuario en otro dispositivo.', reemplazada: true });
  if (req.method === 'GET' && url.pathname === '/api/yo') return responder(res, 200, usuario);

  // Enrutado
  for (const [metodo, patron, rol, fn] of RUTAS) {
    const m = req.method === metodo && patron.exec(url.pathname);
    if (!m) continue;
    if (rol && usuario.rol !== rol) return responder(res, 403, { error: `Solo el ${rol.toLowerCase()} puede hacer esto` });
    const esEvidencia = metodo === 'PUT'; // el cuerpo es el archivo crudo
    const crudo = metodo === 'GET' ? null : await leerCuerpo(req, esEvidencia ? h.MAX_BYTES : 100_000);
    let body = {};
    if (crudo && !esEvidencia && crudo.length) { try { body = JSON.parse(crudo.toString()); } catch { return responder(res, 400, { error: 'JSON inválido' }); } }
    const r = await fn({ params: m.groups || {}, query: url.searchParams, body, bodyCrudo: esEvidencia ? crudo : null, headers: req.headers, usuario });
    if (r.buffer) {
      const cab = { 'Content-Type': r.tipo, 'Content-Length': r.buffer.length, 'X-Content-Type-Options': 'nosniff' };
      cab['Content-Disposition'] = `${r.descargar ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(r.nombre)}`;
      res.writeHead(r.status, cab); return res.end(r.buffer);
    }
    return responder(res, r.status, r.json);
  }
  responder(res, 404, { error: 'Ruta no encontrada' });
}

module.exports = http.createServer((req, res) => {
  manejar(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    if (e.status === 413) return responder(res, 413, { error: 'El archivo supera 5 MB' });
    console.error(e);
    responder(res, 500, { error: req.url === '/api/login' ? 'No fue posible iniciar sesión.' : 'Error interno' });
  });
});
