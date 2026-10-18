// Pruebas de extremo a extremo, una por historia de usuario (HU-01 a HU-09). Usa una BD de PRUEBA (se vacía al iniciar).
if (!process.env.DATABASE_URL) throw new Error('Define DATABASE_URL (BD de prueba) para ejecutar las pruebas');
const test = require('node:test');
const assert = require('node:assert');
const { query, iniciarEsquema, pool } = require('../src/db');
const server = require('../src/app');

let base; let gerente; let asistente;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.4 prueba');
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const hora = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const mas = (n) => { const d = new Date(hoy() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mesDe = (f) => f.slice(0, 7);

async function pedir(cookie, metodo, url, body, headers = {}) {
  const esJson = body && !Buffer.isBuffer(body);
  const r = await fetch(base + url, { method: metodo, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(esJson ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: esJson ? JSON.stringify(body) : body });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j, cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers };
}
const nuevo = (o) => ({ concepto: 'Gas', entidad: 'Calidda', categoria_id: 1, monto: '50.5', fecha_vencimiento: mas(10), ...o });
const crear = (o) => pedir(asistente, 'POST', '/api/pagos', nuevo(o));
const pagarCon = (id, archivo, extra = {}) => pedir(asistente, 'PUT', `/api/pagos/${id}/pagar`, archivo,
  { 'X-Fecha-Pago': hoy(), 'X-Hora-Pago': '00:00', 'X-Nombre': 'boleta.png', ...extra });
const cambiarCon = (id, archivo) => pedir(asistente, 'PUT', `/api/pagos/${id}/evidencia`, archivo, { 'X-Nombre': 'nueva.png' });
const idPor = async (c) => (await query('SELECT id FROM pagos WHERE concepto = $1', [c]))[0].id;

test.before(async () => {
  await iniciarEsquema();
  await query('TRUNCATE evidencias, notificaciones, pagos, categorias, usuarios RESTART IDENTITY CASCADE');
  await require('../src/seed').asegurarDatosIniciales();
  await query('TRUNCATE evidencias, pagos RESTART IDENTITY CASCADE');             // los datos de prueba los creamos aquí
  await new Promise((ok) => server.listen(0, ok)); base = `http://127.0.0.1:${server.address().port}`;
  gerente = (await pedir(null, 'POST', '/api/login', { usuario: 'Gerente', clave: 'gerente123' })).cookie;
  asistente = (await pedir(null, 'POST', '/api/login', { usuario: 'Asistente', clave: 'asistente123' })).cookie;
});
test.after(async () => { server.close(); if (pool.end) await pool.end(); });

test('HU-01 inicio de sesión', async () => {
  const f1 = await pedir(null, 'POST', '/api/login', { usuario: '', clave: '' });
  assert.equal(f1.status, 400); assert.equal(f1.json.error, 'Ingrese usuario y contraseña');
  assert.ok(f1.json.campos.usuario && f1.json.campos.clave);
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'Gerente', clave: '' })).json.campos.clave, 'Ingrese contraseña');
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'Ger ente', clave: 'gerente123' })).status, 400);
  const mala = await pedir(null, 'POST', '/api/login', { usuario: 'Gerente', clave: 'mala' });
  assert.equal(mala.status, 401); assert.match(mala.json.error, /credenciales no son válidas/);
  // La contraseña distingue mayúsculas y minúsculas
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'Gerente', clave: 'GERENTE123' })).status, 401);
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'Gerente', clave: 'Gerente123' })).status, 401);
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'gerente', clave: 'gerente123' })).status, 401);   // el usuario distingue mayúsculas
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'ASISTENTE', clave: 'asistente123' })).status, 401);
  assert.equal((await pedir(null, 'POST', '/api/login', { usuario: 'otro', clave: 'x' })).status, 401);
  assert.equal((await pedir(null, 'POST', '/api/registro', {})).status, 401);
  for (const u of ['/api/pagos', '/api/panel']) assert.equal((await pedir(null, 'GET', u)).status, 401);
  assert.equal((await pedir(gerente, 'GET', '/api/yo')).json.rol, 'GERENTE');
  const sal = await pedir(gerente, 'POST', '/api/logout', {}); assert.match(sal.headers.get('set-cookie'), /Max-Age=0/);
});

test('HU-05 registrar pago por realizar (validaciones, límites, repetido)', async () => {
  assert.equal((await pedir(gerente, 'POST', '/api/pagos', nuevo({}))).status, 403);                    // solo asistente
  const vacio = await pedir(asistente, 'POST', '/api/pagos', {});
  assert.equal(vacio.status, 400);
  for (const k of ['concepto', 'entidad', 'categoria_id', 'monto', 'fecha_vencimiento']) assert.ok(vacio.json.campos[k], k);
  for (const monto of ['0', '-5', '10.999', 'abc']) assert.ok((await crear({ monto })).json.campos.monto, monto);
  assert.match((await crear({ categoria_id: 1, monto: '20000.01' })).json.campos.monto, /20,000/);       // Servicios máx. S/ 20 000
  assert.equal((await crear({ concepto: 'Servicio tope', categoria_id: 1, monto: '20000', fecha_vencimiento: mas(11) })).status, 201);
  assert.ok((await crear({ categoria_id: 2, monto: '500000.01' })).json.campos.monto);                  // otras: S/ 500 000
  assert.equal((await crear({ concepto: 'Proveedor tope', categoria_id: 2, monto: '500000', fecha_vencimiento: mas(12) })).status, 201);
  assert.ok((await crear({ fecha_vencimiento: hoy() })).json.campos.fecha_vencimiento);                  // debe ser futura
  assert.ok((await crear({ fecha_vencimiento: mas(-3) })).json.campos.fecha_vencimiento);
  assert.ok((await crear({ fecha_vencimiento: '2026-02-31' })).json.campos.fecha_vencimiento);
  // Entidad: solo letras
  for (const e of ['Banco 123', 'Movistar&Co', 'SAT-Trujillo', 'Ent.']) assert.match((await crear({ entidad: e })).json.campos.entidad, /solo puede contener letras/, e);
  assert.equal((await crear({ concepto: 'Con tildes', entidad: 'Compañía Ñandú Perú', fecha_vencimiento: mas(14) })).status, 201);
  // Vencimiento: máximo 1 año desde el registro
  const unAnio = new Date(hoy() + 'T00:00:00Z'); unAnio.setUTCFullYear(unAnio.getUTCFullYear() + 1);
  assert.match((await crear({ fecha_vencimiento: mas(367) })).json.campos.fecha_vencimiento, /1 año/);
  assert.equal((await crear({ concepto: 'Un año justo', entidad: 'Banco', fecha_vencimiento: unAnio.toISOString().slice(0, 10) })).status, 201);
  // Registro correcto: queda Pendiente
  const ok = await crear({ concepto: 'Luz', entidad: 'Hidrandina', fecha_vencimiento: mas(20) }); assert.equal(ok.status, 201);
  const [fila] = await query('SELECT estado, entidad FROM pagos WHERE id = $1', [ok.json.id]);
  assert.equal(fila.estado, 'PENDIENTE'); assert.equal(fila.entidad, 'Hidrandina');
  // Aviso de pago repetido: misma entidad + categoría + mismo mes
  const v1 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ concepto: 'Luz otra vez', entidad: ' hidrandina ', fecha_vencimiento: mas(21) }));
  if (mesDe(mas(21)) === mesDe(mas(20))) { assert.equal(v1.json.duplicado.concepto, 'Luz'); } else { assert.equal(v1.json.duplicado, null); }
  const v2 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ entidad: 'Otra entidad', fecha_vencimiento: mas(20) }));
  assert.equal(v2.status, 200); assert.equal(v2.json.duplicado, null);
  const v3 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ concepto: 'Luz', entidad: 'HIDRANDINA', fecha_vencimiento: mas(20) }));
  assert.ok(v3.json.duplicado && v3.json.duplicado.entidad === 'Hidrandina');
  assert.equal((await crear({ concepto: 'Luz', entidad: 'Hidrandina', fecha_vencimiento: mas(20) })).status, 201);   // el usuario puede confirmar igual
});

test('HU-06 registrar pago como realizado con evidencia', async () => {
  const id = (await crear({ concepto: 'Agua', entidad: 'SEDALIB', fecha_vencimiento: mas(5) })).json.id;
  assert.equal((await pagarCon(id, PNG)).status, 200);                                                  // pago correcto; luego se reinicia para probar las validaciones
  await query("UPDATE pagos SET estado='PENDIENTE', fecha_pago=NULL, hora_pago=NULL, comentario=NULL WHERE id=$1", [id]);
  await query('DELETE FROM evidencias WHERE pago_id = $1', [id]);
  assert.equal((await pedir(gerente, 'PUT', `/api/pagos/${id}/pagar`, PNG, { 'X-Fecha-Pago': hoy(), 'X-Hora-Pago': '00:00' })).status, 403);
  const sin = await pagarCon(id, Buffer.alloc(0)); assert.equal(sin.status, 400); assert.ok(sin.json.campos.archivo);          // sin evidencia: rechazado
  assert.equal((await pagarCon(id, Buffer.from('MZ ejecutable'))).status, 400);                         // formato
  assert.equal((await pagarCon(id, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).status, 413);  // > 5 MB
  assert.equal((await pagarCon(id, PNG, { 'X-Fecha-Pago': mas(1) })).status, 400);                      // futura
  assert.equal((await pagarCon(id, PNG, { 'X-Fecha-Pago': hoy(), 'X-Hora-Pago': '23:59' })).status, hora() >= '23:59' ? 200 : 400);
  await query("UPDATE pagos SET estado='PENDIENTE', fecha_pago=NULL, hora_pago=NULL WHERE id=$1", [id]); await query('DELETE FROM evidencias WHERE pago_id=$1', [id]);
  assert.equal((await pagarCon(id, PNG, { 'X-Fecha-Pago': mas(-8) })).status, 400);                     // más de una semana atrás
  assert.equal((await pagarCon(id, PNG, { 'X-Hora-Pago': '' })).status, 400);                           // sin hora
  assert.equal((await query('SELECT estado FROM pagos WHERE id=$1', [id]))[0].estado, 'PENDIENTE');    // los rechazos no cambian nada
  assert.equal((await query('SELECT count(*)::int n FROM evidencias WHERE pago_id=$1', [id]))[0].n, 0);
  const ok = await pagarCon(id, PNG, { 'X-Fecha-Pago': mas(-7), 'X-Hora-Pago': '09:30', 'X-Comentario': encodeURIComponent('Pagado en agente BCP') });
  assert.equal(ok.status, 200); assert.equal(ok.json.hora_pago, '09:30');
  const [p] = await query('SELECT estado, fecha_pago, hora_pago, comentario FROM pagos WHERE id=$1', [id]);
  assert.deepEqual({ ...p }, { estado: 'PAGADO', fecha_pago: mas(-7), hora_pago: '09:30', comentario: 'Pagado en agente BCP' });
  const [ev] = await query('SELECT vigente, numero_intento FROM evidencias WHERE pago_id=$1', [id]); assert.equal(ev.vigente, true); assert.equal(ev.numero_intento, null); // el inicial no es un «intento de cambio»
  assert.equal((await pagarCon(id, PNG)).status, 409);                                                  // solo Pendiente
  const jpg = await crear({ concepto: 'Con JPG', fecha_vencimiento: mas(6) }); assert.equal((await pagarCon(jpg.json.id, JPG)).status, 200);
  const pdf = await crear({ concepto: 'Con PDF', fecha_vencimiento: mas(7) }); assert.equal((await pagarCon(pdf.json.id, PDF)).status, 200);
});

test('HU-04 pagos del mes (asistente): orden, hora de pago, atrasados solo en el mes actual', async () => {
  assert.equal((await pedir(gerente, 'GET', '/api/pagos')).status, 403);                                // solo asistente
  await query("INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento) VALUES ('Atrasado de prueba','Entidad X',1,10,$1)", [mas(-45)]);
  const r = await pedir(asistente, 'GET', '/api/pagos'); assert.equal(r.status, 200);
  const p = r.json.pagos;
  assert.ok(p.every((x) => x.concepto && x.entidad && x.categoria && x.monto > 0 && x.fecha_vencimiento));
  assert.deepEqual(p.map((x) => x.fecha_vencimiento), p.map((x) => x.fecha_vencimiento).sort());       // por vencimiento ascendente
  const at = p.find((x) => x.concepto === 'Atrasado de prueba'); assert.equal(at.alerta, 'ATRASADO');
  assert.ok(p.find((x) => x.concepto === 'Agua').hora_pago);                                            // pagado muestra hora
  const mesSig = mesDe(mas(40));
  const sig = await pedir(asistente, 'GET', `/api/pagos?mes=${mesSig}`);
  assert.ok(!sig.json.pagos.some((x) => x.concepto === 'Atrasado de prueba'));                          // atrasados NO salen en otros meses
  assert.equal((await pedir(asistente, 'GET', '/api/pagos?mes=2020-13')).status, 400);
  const vacio = await pedir(asistente, 'GET', '/api/pagos?mes=2031-01'); assert.deepEqual(vacio.json.pagos, []);
});

test('HU-08 por vencer + HU-09 aviso (solo asistente)', async () => {
  assert.equal((await pedir(gerente, 'GET', '/api/pagos/por-vencer')).status, 403);
  await query('DELETE FROM pagos WHERE concepto LIKE $1', ['VEN-%']);
  for (const [c, d] of [['VEN-hoy', 0], ['VEN-3', 3], ['VEN-4', 4], ['VEN-ayer', -1]]) await query("INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento) VALUES ($1,'E',1,10,$2)", [c, mas(d)]);
  const r = await pedir(asistente, 'GET', '/api/pagos/por-vencer');
  const nombres = r.json.pagos.map((x) => x.concepto);
  assert.ok(nombres.includes('VEN-hoy') && nombres.includes('VEN-3') && nombres.includes('VEN-ayer'));
  assert.ok(!nombres.includes('VEN-4'));                                                                // 4 días: todavía no
  assert.ok(r.json.pagos.every((x) => x.estado === 'PENDIENTE'));
  const venc = r.json.pagos.map((x) => x.fecha_vencimiento); assert.deepEqual(venc, [...venc].sort());  // más antiguo primero
  assert.equal(r.json.pagos.find((x) => x.concepto === 'VEN-ayer').dias, -1);
  // al pagarse desaparece
  await pagarCon(await idPor('VEN-hoy'), PNG);
  assert.ok(!(await pedir(asistente, 'GET', '/api/pagos/por-vencer')).json.pagos.some((x) => x.concepto === 'VEN-hoy'));
  // sin pagos por vencer → lista vacía
  await query("UPDATE pagos SET estado='PAGADO', fecha_pago=$1, hora_pago='08:00' WHERE estado='PENDIENTE' AND fecha_vencimiento <= $2", [hoy(), mas(3)]);
  assert.deepEqual((await pedir(asistente, 'GET', '/api/pagos/por-vencer')).json.pagos, []);
});

test('HU-07 cambiar evidencia (máx. 3, intento previo) y HU-03 evidencias solo gerente', async () => {
  const id = (await crear({ concepto: 'Cambios', fecha_vencimiento: mas(9) })).json.id;
  assert.equal((await cambiarCon(id, JPG)).status, 409);                                                // Pendiente: no se puede
  await pagarCon(id, PNG);
  assert.equal((await pedir(gerente, 'PUT', `/api/pagos/${id}/evidencia`, JPG)).status, 403);
  assert.equal((await cambiarCon(id, Buffer.from('xx'))).status, 400);                                  // formato inválido: no cuenta
  assert.equal((await cambiarCon(id, Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)]))).status, 413);
  assert.equal((await query('SELECT count(*)::int n FROM evidencias WHERE pago_id=$1 AND NOT vigente', [id]))[0].n, 0);
  for (let i = 1; i <= 3; i++) { const r = await cambiarCon(id, i % 2 ? JPG : PDF); assert.equal(r.status, 200); assert.equal(r.json.intentos_restantes, 3 - i); }
  const cuarto = await cambiarCon(id, PNG); assert.equal(cuarto.status, 409); assert.match(cuarto.json.error, /máximo/);
  const filas = await query('SELECT vigente, numero_intento, reemplazada_en FROM evidencias WHERE pago_id=$1 ORDER BY id', [id]);
  assert.equal(filas.length, 4); assert.equal(filas.filter((f) => f.vigente).length, 1);                  // una sola vigente
  assert.deepEqual(filas.filter((f) => !f.vigente).map((f) => Number(f.numero_intento)), [1, 2, 3]);
  // Comentario en el cambio de evidencia (por archivo) e identificador autogenerado
  const idc = (await crear({ concepto: 'Con comentario', fecha_vencimiento: mas(9) })).json.id; await pagarCon(idc, PNG, { 'X-Comentario': encodeURIComponent('primero') });
  assert.equal((await pedir(asistente, 'PUT', `/api/pagos/${idc}/evidencia`, JPG, { 'X-Comentario': encodeURIComponent('corregido por error de foto') })).status, 200);
  const ic = (await pedir(gerente, 'GET', `/api/pagos/${idc}/evidencias`)).json;
  assert.equal(ic.vigente.comentario, 'corregido por error de foto'); assert.equal(ic.previos[0].comentario, 'primero');
  assert.match(ic.pago.codigo, /^PAG-\d{4}$/);
  assert.match((await pedir(asistente, 'GET', '/api/pagos')).json.pagos[0].codigo, /^PAG-\d{4}$/);
  // Asistente: no ve evidencias
  assert.equal((await pedir(asistente, 'GET', `/api/pagos/${id}/evidencias`)).status, 403);
  const [{ id: evId }] = await query('SELECT id FROM evidencias WHERE pago_id=$1 LIMIT 1', [id]);
  assert.equal((await pedir(asistente, 'GET', `/api/evidencias/${evId}`)).status, 403);
  // Gerente: vigente + previos, ver y descargar
  const g = await pedir(gerente, 'GET', `/api/pagos/${id}/evidencias`); assert.equal(g.status, 200);
  assert.equal(g.json.previos.length, 3); assert.ok(g.json.vigente.id); assert.equal(g.json.pago.concepto, 'Cambios');
  const ver = await fetch(base + `/api/evidencias/${g.json.vigente.id}`, { headers: { Cookie: gerente } });
  assert.equal(ver.status, 200); assert.match(ver.headers.get('content-disposition'), /^inline/);
  const desc = await fetch(base + `/api/evidencias/${g.json.previos[0].id}?descargar=1`, { headers: { Cookie: gerente } });
  assert.match(desc.headers.get('content-disposition'), /^attachment/);
  // sin ruta para editar/borrar intentos previos
  assert.equal((await pedir(gerente, 'DELETE', `/api/evidencias/${evId}`)).status, 404);
  // Pendiente → mensaje
  const pen = (await crear({ concepto: 'Sin pagar', fecha_vencimiento: mas(30) })).json.id;
  const m = await pedir(gerente, 'GET', `/api/pagos/${pen}/evidencias`); assert.equal(m.status, 409); assert.match(m.json.error, /aún no tiene evidencia/);
});

test('Datos antiguos: pago Pagado sin archivo vigente permite adjuntar evidencia', async () => {
  const id = (await crear({ concepto: 'Antiguo', fecha_vencimiento: mas(8) })).json.id;
  await query("UPDATE pagos SET estado='PAGADO', fecha_pago=$2, hora_pago='08:00' WHERE id=$1", [id, hoy()]);
  const r = await cambiarCon(id, PNG); assert.equal(r.status, 200);
  assert.equal((await query('SELECT count(*)::int n FROM evidencias WHERE pago_id=$1 AND vigente', [id]))[0].n, 1);
  assert.equal((await cambiarCon(id, JPG)).status, 200);
});

test('HU-02 panel de monitoreo (solo gerente)', async () => {
  assert.equal((await pedir(asistente, 'GET', '/api/panel')).status, 403);
  const hoyPend = await query("INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento) VALUES ('Vence hoy','Ent hoy',3,100,$1) RETURNING id", [hoy()]);
  await query("INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento) VALUES ('Atrasado panel','E',1,10,$1)", [mas(-45)]);
  const r = await pedir(gerente, 'GET', '/api/panel'); assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.hay_pagos, true);
  assert.ok(d.resumen.pagados.n >= 1 && d.resumen.pagados.monto > 0);
  assert.ok(d.resumen.pendientes && d.resumen.atrasados.n >= 1);                                          // el atrasado de prueba (mes anterior)
  assert.ok(d.hoy_lista.some((p) => p.concepto === 'Vence hoy' && p.entidad === 'Ent hoy'));            // «Pagos de hoy»
  const clave = (p) => `${p.fecha_pago} ${p.hora_pago}`; assert.deepEqual(d.pagados.map(clave), d.pagados.map(clave).sort().reverse());   // lo pagado: reciente → antiguo
  assert.ok(d.pagados.every((p) => p.categoria && p.entidad && p.hora_pago));
  assert.ok(d.pendientes.some((p) => p.alerta === 'ATRASADO'));
  assert.equal(d.cambios.length, 5); assert.ok(d.cambios.every((c) => c.numero_intento && c.fecha_hora && c.concepto));   // «Cambios de evidencia»
  // sin cambios si no hay pagos
  await query('TRUNCATE evidencias, pagos RESTART IDENTITY CASCADE');
  const v = await pedir(gerente, 'GET', '/api/panel'); assert.equal(v.json.hay_pagos, false);
});

test('Cambios: no existe la modificación de vencimiento ni las notificaciones', async () => {
  const id = (await crear({ concepto: 'Sin prórroga', fecha_vencimiento: mas(15) })).json.id;
  assert.equal((await pedir(asistente, 'POST', `/api/pagos/${id}/vencimiento`, { fecha_vencimiento: mas(30) })).status, 404);
  assert.equal((await pedir(gerente, 'GET', '/api/notificaciones')).status, 404);
  assert.equal((await query('SELECT fecha_vencimiento FROM pagos WHERE id=$1', [id]))[0].fecha_vencimiento, mas(15));
});

test('Sesión única por usuario (gerente y asistente pueden estar a la vez)', async () => {
  const a1 = (await pedir(null, 'POST', '/api/login', { usuario: 'Asistente', clave: 'asistente123' })).cookie;
  assert.equal((await pedir(a1, 'GET', '/api/yo')).status, 200);
  const g1 = (await pedir(null, 'POST', '/api/login', { usuario: 'Gerente', clave: 'gerente123' })).cookie;
  assert.equal((await pedir(a1, 'GET', '/api/yo')).status, 200);                          // gerente y asistente a la vez: se permite
  const a2 = (await pedir(null, 'POST', '/api/login', { usuario: 'Asistente', clave: 'asistente123' })).cookie;   // otro dispositivo
  const vieja = await pedir(a1, 'GET', '/api/pagos'); assert.equal(vieja.status, 401); assert.equal(vieja.json.reemplazada, true);
  assert.equal((await pedir(a2, 'GET', '/api/pagos')).status, 200);
  assert.equal((await pedir(g1, 'GET', '/api/panel')).status, 200);                         // la sesión del gerente no se toca
});
