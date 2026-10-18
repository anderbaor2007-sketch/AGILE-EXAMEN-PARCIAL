// Autenticación sin librerías externas: clave con scrypt, sesión = token firmado (HMAC-SHA256) en cookie httpOnly.
const crypto = require('crypto');
const { query } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-solo-local';
const DURACION_MS = 8 * 3600 * 1000;

// --- claves ---
function hashClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  return `${sal}:${crypto.scryptSync(clave, sal, 32).toString('hex')}`;
}
// Versión asíncrona: no bloquea el servidor mientras se calcula el hash
const scrypt = require('util').promisify(crypto.scrypt);
async function claveValida(clave, guardado) {
  const [sal, hash] = guardado.split(':');
  const calc = await scrypt(clave, sal, 32);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}

// --- token: base64url(payload).firma ---
const firmar = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function crearToken(datos) {
  const p = Buffer.from(JSON.stringify({ ...datos, exp: Date.now() + DURACION_MS })).toString('base64url');
  return `${p}.${firmar(p)}`;
}
function leerToken(token) {
  const [p, f] = String(token || '').split('.');
  if (!p || !f || firmar(p).length !== f.length || !crypto.timingSafeEqual(Buffer.from(firmar(p)), Buffer.from(f))) return null;
  const datos = JSON.parse(Buffer.from(p, 'base64url').toString());
  return datos.exp > Date.now() ? datos : null;
}

function leerCookie(req, nombre) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Devuelve el usuario de la sesión o null
// Sesión única por usuario: el token lleva un id de sesión que debe coincidir con el último inicio de sesión guardado.
// Si el mismo usuario inicia sesión en otro dispositivo, la sesión anterior deja de ser válida.
async function usuarioDe(req) {
  const t = leerToken(leerCookie(req, 'token'));
  if (!t) return null;
  const [u] = await query('SELECT sesion_id FROM usuarios WHERE id = $1', [t.id]);
  if (!u || !t.sid || u.sesion_id !== t.sid) return { reemplazada: true };
  return t;
}

// El "usuario" es la parte anterior a la @ del correo (gerente, asistente); también se acepta el correo completo.
async function login(usuario, clave) {
  const x = String(usuario || '').trim()   // el usuario distingue mayúsculas y minúsculas (Gerente, Asistente);
  const [u] = await query("SELECT * FROM usuarios WHERE correo = $1 OR split_part(correo, '@', 1) = $1", [x]);
  if (!u || !(await claveValida(String(clave || ''), u.clave_hash))) return null;
  const sid = crypto.randomBytes(16).toString('hex');
  await query('UPDATE usuarios SET sesion_id = $1 WHERE id = $2', [sid, u.id]);   // cierra la sesión anterior de este usuario
  return { usuario: { id: u.id, nombre: u.nombre, rol: u.rol }, token: crearToken({ id: u.id, nombre: u.nombre, rol: u.rol, sid }) };
}

module.exports = { hashClave, usuarioDe, login };
