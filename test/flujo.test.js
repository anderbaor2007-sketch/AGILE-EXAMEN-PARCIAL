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
const mesesMas = (f, n) => { const [y, m, d] = f.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const u = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, u))).toISOString().slice(0, 10); };

async function pedir(cookie, metodo, url, body, headers = {}) {
  const esJson = body && !Buffer.isBuffer(body);
  const r = await fetch(base + url, { method: metodo, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(esJson ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: esJson ? JSON.stringify(body) : body });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j, cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers };
}
// Cuerpo base de un pago de Servicios (Luz). `concepto` es solo una etiqueta de prueba para ubicar el pago: se guarda en la BD tras crearlo.
const BASE = {
  1: { tipo_servicio: 'Luz', entidad: 'Hidrandina', numero_recibo: 'R-0001', codigo_suministro: '123456' },
  2: { ruc: '20123456789', razon_social: 'Distribuidora Norte SAC' },
  3: { entidad: 'SUNAT', concepto_impuesto: 'IGV' },
};
const nuevo = (o) => { const { concepto, ...r } = o; return { categoria_id: 1, ...BASE[r.categoria_id ?? 1], monto: '50.5', fecha_vencimiento: mas(10), ...r }; };
const crear = async (o) => {
  const r = await pedir(asistente, 'POST', '/api/pagos', nuevo(o));
  if (r.status === 201 && o.concepto) await query('UPDATE pagos SET concepto = $2 WHERE id = $1', [r.json.id, o.concepto]);
  return r;
};
const pagarCon = (id, archivo, extra = {}) => pedir(asistente, 'PUT', `/api/pagos/${id}/pagar`, archivo,
  { 'X-Fecha-Pago': hoy(), 'X-Hora-Pago': '00:00', 'X-Nombre': 'boleta.png', 'X-Metodo-Pago': 'EFECTIVO', ...extra });
const cambiarCon = (id, archivo) => pedir(asistente, 'PUT', `/api/pagos/${id}/evidencia`, archivo, { 'X-Nombre': 'nueva.png' });
const idPor = async (c) => (await query('SELECT id FROM pagos WHERE concepto = $1', [c]))[0].id;

test.before(async () => {
  await iniciarEsquema();
  await query('TRUNCATE evidencias, notificaciones, pagos, prestamos, categorias, usuarios RESTART IDENTITY CASCADE');
  await require('../src/seed').asegurarDatosIniciales();
  await query('TRUNCATE evidencias, pagos, prestamos RESTART IDENTITY CASCADE');             // los datos de prueba los creamos aquí
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

test('HU-05 registrar pago por realizar (formulario por categoría, validaciones, límites, repetido)', async () => {
  assert.equal((await pedir(gerente, 'POST', '/api/pagos', nuevo({}))).status, 403);                    // solo asistente
  const vacio = await pedir(asistente, 'POST', '/api/pagos', {});
  assert.equal(vacio.status, 400); assert.ok(vacio.json.campos.categoria_id);                            // la categoría va primero
  assert.ok((await pedir(asistente, 'POST', '/api/pagos', { categoria_id: 99 })).json.campos.categoria_id);
  // ---- Servicios: Luz/Agua piden código de suministro; Internet no ----
  const sv = await pedir(asistente, 'POST', '/api/pagos', { categoria_id: 1 });
  for (const k of ['tipo_servicio', 'entidad', 'numero_recibo', 'monto', 'fecha_vencimiento']) assert.ok(sv.json.campos[k], k);
  assert.ok((await crear({ codigo_suministro: '' })).json.campos.codigo_suministro);                      // Luz sin suministro
  assert.ok((await crear({ tipo_servicio: 'Agua', codigo_suministro: '' })).json.campos.codigo_suministro);
  assert.ok((await crear({ tipo_servicio: 'Gas' })).json.campos.tipo_servicio);
  assert.ok((await crear({ numero_recibo: 'R 1!' })).json.campos.numero_recibo);
  assert.ok((await crear({ codigo_suministro: 'ab cd' })).json.campos.codigo_suministro);
  const net = await crear({ concepto: 'Internet de prueba', tipo_servicio: 'Internet', entidad: 'Movistar', codigo_suministro: undefined, numero_recibo: 'F001-778' });
  assert.equal(net.status, 201);                                                                          // Internet: sin código de suministro
  const [fn] = await query('SELECT tipo_servicio, numero_recibo, codigo_suministro FROM pagos WHERE id=$1', [net.json.id]);
  assert.deepEqual({ ...fn }, { tipo_servicio: 'Internet', numero_recibo: 'F001-778', codigo_suministro: null });
  const luz = await crear({ entidad: 'Hidrandina', numero_recibo: 'L-55', fecha_vencimiento: mas(8) }); assert.equal(luz.status, 201);
  const [fl] = await query('SELECT concepto, entidad, tipo_servicio, codigo_suministro FROM pagos WHERE id=$1', [luz.json.id]);
  assert.deepEqual({ ...fl }, { concepto: 'Luz', entidad: 'Hidrandina', tipo_servicio: 'Luz', codigo_suministro: '123456' });
  // ---- Montos y límites ----
  for (const monto of ['0', '-5', '10.999', 'abc']) assert.ok((await crear({ monto })).json.campos.monto, monto);
  assert.match((await crear({ monto: '20000.01' })).json.campos.monto, /no puede exceder los 20 mil soles/);                          // Servicios máx. S/ 20 000
  assert.equal((await crear({ concepto: 'Servicio tope', monto: '20000', fecha_vencimiento: mas(11) })).status, 201);
  assert.match((await crear({ categoria_id: 2, monto: '500000.01' })).json.campos.monto, /no puede exceder los 500 mil soles/);
  assert.match((await crear({ monto: '12000000000.00' })).json.campos.monto, /no puede exceder los 20 mil soles/);   // un monto enorme también da el mensaje de «excede»                    // otras: S/ 500 000
  assert.equal((await crear({ concepto: 'Proveedor tope', categoria_id: 2, monto: '500000', fecha_vencimiento: mas(12) })).status, 201);
  // ---- Fechas ----
  assert.match((await crear({ fecha_vencimiento: mas(-1) })).json.campos.fecha_vencimiento, /anterior a hoy/);
  const venceHoy = await crear({ concepto: 'Vence hoy registrado', entidad: 'Entidad Hoy', fecha_vencimiento: hoy() });
  assert.equal(venceHoy.status, 201);                                                                    // hoy sí: vence al terminar el día
  const vh = (await pedir(asistente, 'GET', '/api/pagos')).json.pagos.find((x) => x.concepto === 'Vence hoy registrado');
  assert.equal(vh.dias, 0); assert.notEqual(vh.alerta, 'ATRASADO');
  assert.ok((await crear({ fecha_vencimiento: '2026-02-31' })).json.campos.fecha_vencimiento);
  assert.match((await crear({ fecha_vencimiento: mas(367) })).json.campos.fecha_vencimiento, /1 año/);
  const unAnio = new Date(hoy() + 'T00:00:00Z'); unAnio.setUTCFullYear(unAnio.getUTCFullYear() + 1);
  assert.equal((await crear({ concepto: 'Un año justo', entidad: 'Banco', fecha_vencimiento: unAnio.toISOString().slice(0, 10) })).status, 201);
  // ---- Entidad: solo letras ----
  for (const e of ['Banco 123', 'Movistar&Co', 'SAT-Trujillo', 'Ent.']) assert.match((await crear({ entidad: e })).json.campos.entidad, /solo puede contener letras/, e);
  assert.equal((await crear({ concepto: 'Con tildes', entidad: 'Compañía Ñandú Perú', fecha_vencimiento: mas(14) })).status, 201);
  // ---- Proveedores: RUC + razón social ----
  const pv = await pedir(asistente, 'POST', '/api/pagos', { categoria_id: 2 });
  for (const k of ['ruc', 'razon_social', 'monto', 'fecha_vencimiento']) assert.ok(pv.json.campos[k], k);
  for (const ruc of ['2012345678', '201234567890', '2012345678A', '30123456789']) assert.ok((await crear({ categoria_id: 2, ruc })).json.campos.ruc, ruc);
  assert.ok((await crear({ categoria_id: 2, razon_social: '###' })).json.campos.razon_social);
  const prov = await crear({ categoria_id: 2, razon_social: 'Ferretería López & Hnos. S.A.C.', fecha_vencimiento: mas(9) }); assert.equal(prov.status, 201);
  const [fp] = await query('SELECT concepto, entidad, ruc, razon_social FROM pagos WHERE id=$1', [prov.json.id]);
  assert.deepEqual({ ...fp }, { concepto: 'Pago a proveedor', entidad: 'Ferretería López & Hnos. S.A.C.', ruc: '20123456789', razon_social: 'Ferretería López & Hnos. S.A.C.' });
  // ---- Impuestos: SUNAT (IGV / renta) o SAT (predial / vehicular) ----
  const im = await pedir(asistente, 'POST', '/api/pagos', { categoria_id: 3 });
  for (const k of ['entidad', 'concepto_impuesto', 'monto', 'fecha_vencimiento']) assert.ok(im.json.campos[k], k);
  assert.ok((await crear({ categoria_id: 3, entidad: 'MUNICIPALIDAD' })).json.campos.entidad);
  assert.match((await crear({ categoria_id: 3, entidad: 'SUNAT', concepto_impuesto: 'Impuesto predial' })).json.campos.concepto_impuesto, /IGV o Impuesto a la renta/);
  assert.match((await crear({ categoria_id: 3, entidad: 'SAT', concepto_impuesto: 'IGV' })).json.campos.concepto_impuesto, /predial o Impuesto vehicular/);
  for (const [entidad, concepto_impuesto] of [['SUNAT', 'IGV'], ['SUNAT', 'Impuesto a la renta'], ['SAT', 'Impuesto predial'], ['SAT', 'Impuesto vehicular']]) {
    const r = await crear({ categoria_id: 3, entidad, concepto_impuesto, fecha_vencimiento: mas(16) }); assert.equal(r.status, 201, concepto_impuesto);
    const [x] = await query('SELECT concepto, entidad FROM pagos WHERE id=$1', [r.json.id]); assert.deepEqual({ ...x }, { concepto: concepto_impuesto, entidad });
  }
  // ---- Registro correcto: queda Pendiente ----
  const ok = await crear({ concepto: 'Luz', entidad: 'Electronorte', fecha_vencimiento: mas(20) }); assert.equal(ok.status, 201);
  const [fila] = await query('SELECT estado, entidad FROM pagos WHERE id = $1', [ok.json.id]);
  assert.equal(fila.estado, 'PENDIENTE'); assert.equal(fila.entidad, 'Electronorte');
  // ---- Aviso de pago repetido: misma entidad + categoría + concepto + mismo mes ----
  const v1 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ entidad: ' electronorte ', fecha_vencimiento: mas(21) }));
  if (mesDe(mas(21)) === mesDe(mas(20))) { assert.equal(v1.json.duplicado.concepto, 'Luz'); } else { assert.equal(v1.json.duplicado, null); }
  const v2 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ entidad: 'Otra entidad', fecha_vencimiento: mas(20) }));
  assert.equal(v2.status, 200); assert.equal(v2.json.duplicado, null);
  const v3 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ entidad: 'ELECTRONORTE', fecha_vencimiento: mas(20) }));
  assert.ok(v3.json.duplicado && v3.json.duplicado.entidad === 'Electronorte');
  const v4 = await pedir(asistente, 'POST', '/api/pagos/verificar', nuevo({ tipo_servicio: 'Agua', entidad: 'Electronorte', fecha_vencimiento: mas(20) }));
  assert.equal(v4.json.duplicado, null);                                                                  // otro servicio de la misma entidad no es repetido
  assert.equal((await crear({ concepto: 'Luz', entidad: 'Electronorte', fecha_vencimiento: mas(20) })).status, 201);   // el usuario puede confirmar igual
});

test('Préstamos: cuotas mensuales, mora (TNA base 360 días) y método de pago permitido', async () => {
  const pr = (o) => ({ categoria_id: 4, entidad: 'Banco de Crédito', monto_total: '1200', num_cuotas: '4', mora_tna: '36', fecha_vencimiento_total: mesesMas(mas(5), 3), fecha_primera_cuota: mas(5), ...o });
  const vacio = await pedir(asistente, 'POST', '/api/pagos', { categoria_id: 4 });
  for (const k of ['entidad', 'monto_total', 'num_cuotas', 'mora_tna', 'fecha_vencimiento_total', 'fecha_primera_cuota']) assert.ok(vacio.json.campos[k], k);
  assert.ok((await pedir(asistente, 'POST', '/api/pagos', pr({ entidad: 'Banco 2' }))).json.campos.entidad);
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ monto_total: '2000000.01' }))).json.campos.monto_total, /no puede exceder los 2 millones de soles/);
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ monto_total: '12000000000.00' }))).json.campos.monto_total, /no puede exceder los 2 millones de soles/);
  assert.equal((await pedir(asistente, 'POST', '/api/pagos/verificar', pr({ monto_total: '2000000', num_cuotas: '4' }))).status, 200);          // justo el tope
  for (const n of ['0', '121', '1.5', 'x']) assert.ok((await pedir(asistente, 'POST', '/api/pagos', pr({ num_cuotas: n }))).json.campos.num_cuotas, n);
  for (const m of ['-1', '101', 'abc', '10.123']) assert.ok((await pedir(asistente, 'POST', '/api/pagos', pr({ mora_tna: m }))).json.campos.mora_tna, m);
  assert.ok((await pedir(asistente, 'POST', '/api/pagos', pr({ fecha_primera_cuota: mas(-1) }))).json.campos.fecha_primera_cuota);
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ fecha_vencimiento_total: mas(1) }))).json.campos.fecha_vencimiento_total, /anterior a la fecha de la primera cuota/);
  // Coherencia: 1 cuota = 1 mes
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ fecha_vencimiento_total: mesesMas(mas(5), 2) }))).json.campos.num_cuotas, /corresponden 3 cuotas, no 4/);   // 4 cuotas no caben en 3 meses
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ num_cuotas: '20' }))).json.campos.num_cuotas, /corresponden 4 cuotas, no 20/);                       // 20 cuotas para 4 meses
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ num_cuotas: '3' }))).json.campos.num_cuotas, /corresponden 4 cuotas, no 3/);                         // y tampoco menos
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ monto_total: '100' }))).json.campos.num_cuotas, /cuota mínima es S\/ 50\.00/);                      // 4 cuotas de S/ 25: no coherente con el monto
  const diezAnios = pr({ monto_total: '120000', num_cuotas: '120', fecha_primera_cuota: mas(5), fecha_vencimiento_total: mesesMas(mas(5), 119) });
  const v120 = await pedir(asistente, 'POST', '/api/pagos/verificar', diezAnios); assert.equal(v120.status, 200); assert.equal(v120.json.cuotas.length, 120);   // 10 años = 120 cuotas
  assert.match((await pedir(asistente, 'POST', '/api/pagos', pr({ fecha_vencimiento_total: mesesMas(hoy(), 121) }))).json.campos.fecha_vencimiento_total, /10 años/);
  // Previsualización: 4 cuotas mensuales el mismo día
  const vista = await pedir(asistente, 'POST', '/api/pagos/verificar', pr({}));
  assert.equal(vista.status, 200); assert.equal(vista.json.cuotas.length, 4);
  assert.deepEqual(vista.json.cuotas.map((c) => c.fecha), [0, 1, 2, 3].map((i) => mesesMas(mas(5), i)));
  assert.deepEqual(vista.json.cuotas.map((c) => c.monto), [300, 300, 300, 300]);
  // Reparto con centavos: la última cuota absorbe la diferencia
  const v3 = await pedir(asistente, 'POST', '/api/pagos/verificar', pr({ monto_total: '200.02', num_cuotas: '3', fecha_vencimiento_total: mesesMas(mas(5), 2) }));
  assert.deepEqual(v3.json.cuotas.map((c) => c.monto), [66.67, 66.67, 66.68]);
  // Crear: se generan los pagos (cada uno con su ID) y todos quedan Pendientes
  const r = await pedir(asistente, 'POST', '/api/pagos', pr({})); assert.equal(r.status, 201); assert.equal(r.json.cuotas, 4);
  const filas = await query("SELECT id, concepto, entidad, monto::float8 AS monto, fecha_vencimiento, estado, numero_cuota, total_cuotas, prestamo_id FROM pagos WHERE prestamo_id IS NOT NULL ORDER BY numero_cuota");
  assert.equal(filas.length, 4); assert.ok(filas.every((f) => f.estado === 'PENDIENTE' && f.entidad === 'Banco de Crédito' && f.prestamo_id === filas[0].prestamo_id && f.total_cuotas === 4));
  assert.deepEqual(filas.map((f) => f.concepto), ['Cuota 1 de 4', 'Cuota 2 de 4', 'Cuota 3 de 4', 'Cuota 4 de 4']);
  assert.equal(new Set(filas.map((f) => f.id)).size, 4);
  const [pre] = await query('SELECT monto_total::float8 AS t, num_cuotas, mora_tna::float8 AS m FROM prestamos'); assert.deepEqual({ ...pre }, { t: 1200, num_cuotas: 4, m: 36 });
  // Repetido: mismo préstamo
  assert.ok((await pedir(asistente, 'POST', '/api/pagos/verificar', pr({}))).json.duplicado);
  // Mora: cuota 300 con TNA 36 % = 300 × 0,36 ÷ 360 = S/ 0,30 por día de atraso
  await query("UPDATE pagos SET fecha_vencimiento = $2 WHERE id = $1", [filas[0].id, mas(-10)]);
  const lista = (await pedir(asistente, 'GET', '/api/pagos')).json.pagos;
  const atr = lista.find((x) => x.id === filas[0].id);
  assert.equal(atr.alerta, 'ATRASADO'); assert.equal(atr.mora, 3); assert.equal(atr.total, 303); assert.equal(atr.monto, 300);
  assert.deepEqual(atr.detalle, [['Cuota', '1 de 4']]);
  const panel = (await pedir(gerente, 'GET', '/api/panel')).json;
  assert.ok(panel.pendientes.some((x) => x.id === filas[0].id && x.mora === 3));
  // Método de pago en préstamos: solo transferencia o tarjeta de crédito
  for (const h of [{ 'X-Metodo-Pago': 'EFECTIVO' }, { 'X-Metodo-Pago': 'BILLETERA', 'X-Metodo-Detalle': 'YAPE' }, { 'X-Metodo-Pago': 'TARJETA', 'X-Metodo-Detalle': 'DEBITO' }]) {
    const x = await pagarCon(filas[0].id, PNG, h); assert.equal(x.status, 400, JSON.stringify(h)); assert.match(x.json.error, /préstamos solo|Completa/);
  }
  const pagado = await pagarCon(filas[0].id, PNG, { 'X-Metodo-Pago': 'TARJETA', 'X-Metodo-Detalle': 'CREDITO' });
  assert.equal(pagado.status, 200); assert.equal(pagado.json.mora, 3); assert.equal(pagado.json.total, 303); assert.equal(pagado.json.metodo_texto, 'Tarjeta de crédito');
  const [pg] = await query('SELECT metodo_pago, metodo_detalle, mora_pagada::float8 AS mora FROM pagos WHERE id=$1', [filas[0].id]);
  assert.deepEqual({ ...pg }, { metodo_pago: 'TARJETA', metodo_detalle: 'CREDITO', mora: 3 });
  const despues = (await pedir(asistente, 'GET', '/api/pagos')).json.pagos.find((x) => x.id === filas[0].id);
  assert.equal(despues.mora, 3); assert.equal(despues.total, 303);                                       // la mora queda fija al pagar
  const t2 = await pagarCon(filas[1].id, PNG, { 'X-Metodo-Pago': 'TRANSFERENCIA' }); assert.equal(t2.status, 200);
  // Sin mora (0 %) o sin atraso no se cobra mora
  const sinMora = await pedir(asistente, 'POST', '/api/pagos', pr({ entidad: 'Banco Pichincha', mora_tna: '0', num_cuotas: '1', fecha_vencimiento_total: mas(5) })); assert.equal(sinMora.status, 201);
  await query("UPDATE pagos SET fecha_vencimiento=$1 WHERE id=$2", [mas(-5), sinMora.json.id]);
  assert.equal((await pedir(asistente, 'GET', '/api/pagos')).json.pagos.find((x) => x.id === sinMora.json.id).mora, 0);
});

test('Ver detalles: todos los datos del pago y, en préstamos, todas sus cuotas (gerente y asistente)', async () => {
  assert.equal((await pedir(null, 'GET', '/api/pagos/1/detalle')).status, 401);
  assert.equal((await pedir(asistente, 'GET', '/api/pagos/999999/detalle')).status, 404);
  // Servicio pendiente
  const sv = await crear({ tipo_servicio: 'Agua', entidad: 'Sedalib', numero_recibo: 'A-77', codigo_suministro: '556677', monto: '88.8', fecha_vencimiento: mas(6) });
  for (const rol of [asistente, gerente]) {
    const r = await pedir(rol, 'GET', `/api/pagos/${sv.json.id}/detalle`); assert.equal(r.status, 200);
    assert.equal(r.json.pago.concepto, 'Agua'); assert.equal(r.json.pago.categoria, 'Servicios'); assert.equal(r.json.pago.estado, 'PENDIENTE');
    assert.deepEqual(r.json.pago.detalle, [['Servicio', 'Agua'], ['N.º de recibo', 'A-77'], ['Código de suministro', '556677']]);
    assert.ok(r.json.pago.registrado_en); assert.equal(r.json.prestamo, null); assert.equal(r.json.cuotas, null);
  }
  // Pagado: método, quién pagó, comentario, evidencia
  assert.equal((await pagarCon(sv.json.id, PNG, { 'X-Metodo-Pago': 'BILLETERA', 'X-Metodo-Detalle': 'PLIN', 'X-Comentario': encodeURIComponent('ok') })).status, 200);
  const pg = (await pedir(gerente, 'GET', `/api/pagos/${sv.json.id}/detalle`)).json.pago;
  assert.equal(pg.estado, 'PAGADO'); assert.equal(pg.metodo_texto, 'Billetera digital (Plin)'); assert.equal(pg.comentario, 'ok'); assert.equal(pg.evidencia_nombre, 'boleta.png'); assert.ok(pg.pagado_por_nombre);
  // Préstamo: todas las cuotas
  const rp = await pedir(asistente, 'POST', '/api/pagos', { categoria_id: 4, entidad: 'Scotiabank', monto_total: '900', num_cuotas: '3', mora_tna: '12', fecha_primera_cuota: mas(3), fecha_vencimiento_total: mesesMas(mas(3), 2) });
  assert.equal(rp.status, 201);
  const [c2] = await query("SELECT id FROM pagos WHERE entidad='Scotiabank' AND numero_cuota = 2");
  const dp = (await pedir(asistente, 'GET', `/api/pagos/${c2.id}/detalle`)).json;
  assert.equal(dp.cuotas.length, 3); assert.deepEqual(dp.cuotas.map((c) => c.numero_cuota), [1, 2, 3]); assert.deepEqual(dp.cuotas.map((c) => c.actual), [false, true, false]);
  assert.equal(dp.prestamo.monto_total, 900); assert.equal(dp.prestamo.num_cuotas, 3); assert.equal(dp.prestamo.mora_tna, 12);
  assert.deepEqual({ ...dp.prestamo.resumen }, { pagadas: 0, pendientes: 3, atrasadas: 0, total_pagado: 0, saldo: 900 });
  const [c1] = await query("SELECT id FROM pagos WHERE entidad='Scotiabank' AND numero_cuota = 1");
  assert.equal((await pagarCon(c1.id, PNG, { 'X-Metodo-Pago': 'TRANSFERENCIA' })).status, 200);
  const dp2 = (await pedir(gerente, 'GET', `/api/pagos/${c2.id}/detalle`)).json;
  assert.equal(dp2.cuotas[0].estado, 'PAGADO'); assert.equal(dp2.prestamo.resumen.pagadas, 1); assert.equal(dp2.prestamo.resumen.saldo, 600); assert.equal(dp2.prestamo.resumen.total_pagado, 300);
});

test('Método de pago: se elige al registrar el pago y no hay descuentos', async () => {
  const id = (await crear({ concepto: 'Método', fecha_vencimiento: mas(4) })).json.id;
  const m = (h) => pagarCon(id, PNG, h);
  assert.equal((await pagarCon(id, PNG, { 'X-Metodo-Pago': '' })).status, 400);                           // obligatorio
  assert.ok((await pagarCon(id, PNG, { 'X-Metodo-Pago': '' })).json.campos.metodo_pago);
  assert.equal((await m({ 'X-Metodo-Pago': 'CHEQUE' })).status, 400);
  assert.ok((await m({ 'X-Metodo-Pago': 'BILLETERA' })).json.campos.metodo_detalle);                       // falta Plin/Yape/Agora
  assert.ok((await m({ 'X-Metodo-Pago': 'BILLETERA', 'X-Metodo-Detalle': 'PAYPAL' })).json.campos.metodo_detalle);
  assert.ok((await m({ 'X-Metodo-Pago': 'TARJETA' })).json.campos.metodo_detalle);                         // falta crédito/débito
  assert.equal((await m({ 'X-Metodo-Pago': 'EFECTIVO', 'X-Metodo-Detalle': 'YAPE' })).status, 400);
  assert.equal((await query('SELECT estado FROM pagos WHERE id=$1', [id]))[0].estado, 'PENDIENTE');        // los rechazos no cambian nada
  const casos = [['TRANSFERENCIA', undefined, 'Transferencia'], ['EFECTIVO', undefined, 'Efectivo'], ['BILLETERA', 'PLIN', 'Billetera digital (Plin)'], ['BILLETERA', 'YAPE', 'Billetera digital (Yape)'],
    ['BILLETERA', 'AGORA', 'Billetera digital (Agora)'], ['TARJETA', 'CREDITO', 'Tarjeta de crédito'], ['TARJETA', 'DEBITO', 'Tarjeta de débito']];
  for (const [metodo, det, texto] of casos) {
    const nid = (await crear({ concepto: 'M-' + texto, fecha_vencimiento: mas(4) })).json.id;
    const r = await pagarCon(nid, PNG, { 'X-Metodo-Pago': metodo, ...(det ? { 'X-Metodo-Detalle': det } : {}) });
    assert.equal(r.status, 200, texto); assert.equal(r.json.metodo_texto, texto); assert.equal(r.json.total, 50.5);   // sin descuento: mismo monto
    const p = (await pedir(asistente, 'GET', '/api/pagos')).json.pagos.find((x) => x.id === nid); assert.equal(p.metodo_texto, texto); assert.equal(p.total, 50.5);
  }
  const pan = (await pedir(gerente, 'GET', '/api/panel')).json; assert.ok(pan.pagados.some((x) => x.metodo_texto === 'Billetera digital (Yape)'));
  const ev = (await pedir(gerente, 'GET', `/api/pagos/${(await idPor('M-Efectivo'))}/evidencias`)).json; assert.equal(ev.pago.metodo_texto, 'Efectivo');
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
  assert.equal((await pedir(asistente, 'PUT', `/api/pagos/${idc}/evidencia`, JPG, { 'X-Comentario': encodeURIComponent('corregido por error de foto')})).status, 200);
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

