// Lógica de negocio. Cada función (async) recibe (ctx) y devuelve { status, json } o { status, buffer, tipo, nombre, descargar }.
// Trazabilidad: los comentarios HU-xx indican qué historia de usuario cumple cada bloque.
const { query } = require('../db');

// ---- Reglas de negocio (un solo lugar para ajustarlas) ----
const DIAS_POR_VENCER = Number(process.env.DIAS_POR_VENCER || 3);     // HU-08: hoy y los próximos 3 días
const MAX_BYTES = 5 * 1024 * 1024;                                    // HU-06/07: 5 MB
const MAX_CAMBIOS_EVIDENCIA = 3;                                      // HU-07: máximo 3 intentos de cambio
const DIAS_MAX_ATRAS_PAGO = 7;                                        // HU-06: el pago no puede ser anterior a 1 semana
const LIMITE_MONTO = { Servicios: 20000 };                            // HU-05: tope por categoría (S/)
const LIMITE_MONTO_OTROS = 500000;                                    // Préstamos, Proveedores, Impuestos
const FORMATOS = 'Formatos admitidos: JPG, PNG o PDF.';

// ---- Fechas (siempre hora de Lima) ----
const TZ = 'America/Lima';
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });                                   // AAAA-MM-DD
const horaAhora = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()); // HH:MM
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const esHora = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const sumaDias = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const err = (status, error, campos) => ({ status, json: campos ? { error, campos } : { error } });
const redondeo = (n) => Math.round(n * 100) / 100;

const SELECT = `
  SELECT p.id, p.concepto, p.entidad, p.categoria_id, p.monto::float8 AS monto, p.fecha_vencimiento, p.estado, p.fecha_pago, p.hora_pago, p.comentario,
         c.nombre AS categoria, e.nombre_original AS evidencia_nombre, e.tipo_mime AS evidencia_tipo, (e.id IS NOT NULL) AS tiene_evidencia,
         (SELECT count(*)::int FROM evidencias x WHERE x.pago_id = p.id AND NOT x.vigente) AS intentos_usados
  FROM pagos p JOIN categorias c ON c.id = p.categoria_id LEFT JOIN evidencias e ON e.pago_id = p.id AND e.vigente`;

// Un pago Pendiente con vencimiento anterior a hoy está ATRASADO; dentro de los próximos 3 días, POR_VENCER.
function conAlerta(p) {
  const h = hoy(); let alerta = null; let dias = null;
  if (p.estado === 'PENDIENTE') {
    dias = diasEntre(h, p.fecha_vencimiento); // >0 faltan, 0 vence hoy, <0 atraso
    if (dias < 0) alerta = 'ATRASADO';
    else if (dias <= DIAS_POR_VENCER) alerta = 'POR_VENCER';
  }
  return { ...p, tiene_evidencia: !!p.tiene_evidencia, alerta, dias, intentos_restantes: Math.max(0, MAX_CAMBIOS_EVIDENCIA - (p.intentos_usados || 0)) };
}
const suma = (l) => redondeo(l.reduce((s, p) => s + p.monto, 0));

// ---------- HU-04: pagos del mes (asistente) ----------
// Mes consultado: solo los pagos cuyo vencimiento cae en ese mes.
// Los pendientes de meses anteriores (atrasados) se muestran ÚNICAMENTE en el mes actual.
async function listar({ query: qs }) {
  const mes = qs.get('mes') || hoy().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return err(400, 'Mes inválido (AAAA-MM)');
  const esMesActual = mes === hoy().slice(0, 7);
  const filas = esMesActual
    ? await query(`${SELECT}
        WHERE left(p.fecha_vencimiento,7) = $1 OR (p.estado='PENDIENTE' AND left(p.fecha_vencimiento,7) < $1)
        ORDER BY p.fecha_vencimiento, p.id`, [mes])
    : await query(`${SELECT} WHERE left(p.fecha_vencimiento,7) = $1 ORDER BY p.fecha_vencimiento, p.id`, [mes]);
  const pagos = filas.map(conAlerta);
  const delMes = pagos.filter((p) => p.fecha_vencimiento.slice(0, 7) === mes);
  return { status: 200, json: {
    mes, hoy: hoy(), es_mes_actual: esMesActual, pagos,
    resumen: {
      total_mes: suma(delMes), pagado_mes: suma(delMes.filter((p) => p.estado === 'PAGADO')),
      pendiente_total: suma(pagos.filter((p) => p.estado === 'PENDIENTE')), n_pendientes: pagos.filter((p) => p.estado === 'PENDIENTE').length,
    },
  } };
}

// ---------- HU-02: panel de monitoreo (gerente) ----------
async function panel() {
  const h = hoy(); const mes = h.slice(0, 7);
  const filas = (await query(`${SELECT}
    WHERE left(p.fecha_vencimiento,7) = $1 OR left(p.fecha_pago,7) = $1 OR (p.estado='PENDIENTE' AND left(p.fecha_vencimiento,7) < $1)
    ORDER BY p.fecha_vencimiento, p.id`, [mes])).map(conAlerta);

  const clave = (p) => `${p.fecha_pago} ${p.hora_pago || '00:00'}`;
  const pagados = filas.filter((p) => p.estado === 'PAGADO').sort((a, b) => clave(b).localeCompare(clave(a)));   // más reciente primero
  const pendientes = filas.filter((p) => p.estado === 'PENDIENTE');                                             // ya vienen por vencimiento
  const atrasados = pendientes.filter((p) => p.alerta === 'ATRASADO');
  const enPlazo = pendientes.filter((p) => p.alerta !== 'ATRASADO');
  const hoyLista = filas.filter((p) => p.fecha_vencimiento === h);
  const resumen = {
    pagados: { n: pagados.length, monto: suma(pagados) },
    pendientes: { n: enPlazo.length, monto: suma(enPlazo) },
    atrasados: { n: atrasados.length, monto: suma(atrasados) },
  };
  // «Cambios de evidencia»: archivos reemplazados (intentos previos), el más reciente primero
  const cambios = await query(`
    SELECT e.id AS evidencia_id, e.numero_intento, p.id AS pago_id, p.concepto, p.entidad,
           to_char(e.reemplazada_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS fecha_hora
    FROM evidencias e JOIN pagos p ON p.id = e.pago_id WHERE NOT e.vigente ORDER BY e.reemplazada_en DESC LIMIT 30`);
  return { status: 200, json: { hoy: h, mes, hay_pagos: filas.length > 0, resumen, hoy_lista: hoyLista, pagados, pendientes, cambios } };
}

// ---------- HU-08: pagos por vencer (asistente) ----------
async function porVencer() {
  const limite = sumaDias(hoy(), DIAS_POR_VENCER);
  const pagos = (await query(`${SELECT} WHERE p.estado = 'PENDIENTE' AND p.fecha_vencimiento <= $1
    ORDER BY p.fecha_vencimiento, p.id`, [limite])).map(conAlerta);
  return { status: 200, json: { hoy: hoy(), dias_por_vencer: DIAS_POR_VENCER, pagos } };
}

const categorias = async () => ({ status: 200, json: await query('SELECT * FROM categorias ORDER BY id') });

// ---------- HU-05: registrar un pago por realizar ----------
async function validarNuevo(body) {
  const campos = {};
  const concepto = String(body.concepto ?? '').trim();
  if (!concepto) campos.concepto = 'Ingresa el concepto del pago';
  else if (concepto.length > 100) campos.concepto = 'El concepto no puede superar 100 caracteres';

  const entidad = String(body.entidad ?? '').trim();
  if (!entidad) campos.entidad = 'Ingresa la entidad (empresa o persona a la que se paga)';
  else if (entidad.length > 100) campos.entidad = 'La entidad no puede superar 100 caracteres';

  const catId = Number(body.categoria_id);
  const [cat] = Number.isInteger(catId) && catId > 0 ? await query('SELECT id, nombre FROM categorias WHERE id = $1', [catId]) : [];
  if (!body.categoria_id) campos.categoria_id = 'Selecciona una categoría';
  else if (!cat) campos.categoria_id = 'Categoría inválida';

  const montoTxt = String(body.monto ?? '').trim();
  if (!montoTxt) campos.monto = 'Ingresa el monto en soles (S/)';
  else if (!/^\d{1,7}(\.\d{1,2})?$/.test(montoTxt) || !(Number(montoTxt) > 0)) campos.monto = 'El monto debe ser mayor que cero, con hasta dos decimales';
  else if (cat) {
    const limite = LIMITE_MONTO[cat.nombre] ?? LIMITE_MONTO_OTROS;
    if (Number(montoTxt) > limite) campos.monto = `El monto máximo para ${cat.nombre} es S/ ${limite.toLocaleString('en-US')}.00`;
  }

  const f = body.fecha_vencimiento;
  if (!f) campos.fecha_vencimiento = 'Ingresa la fecha de vencimiento';
  else if (!esFecha(f)) campos.fecha_vencimiento = 'La fecha de vencimiento no es válida';
  else if (f <= hoy()) campos.fecha_vencimiento = 'La fecha de vencimiento debe ser una fecha futura';

  if (Object.keys(campos).length) return { e: err(400, 'Corrige los campos indicados', campos) };
  return { datos: { concepto, entidad, cat, monto: Number(montoTxt), fecha_vencimiento: f } };
}

// POST /api/pagos/verificar — valida y avisa si podría ser un pago repetido (misma entidad y categoría, mismo mes de vencimiento)
async function verificar({ body }) {
  const v = await validarNuevo(body); if (v.e) return v.e;
  const d = v.datos;
  const [dup] = await query(`${SELECT} WHERE lower(trim(p.entidad)) = lower($1) AND p.categoria_id = $2 AND left(p.fecha_vencimiento,7) = left($3,7)
                            ORDER BY p.fecha_vencimiento LIMIT 1`, [d.entidad, d.cat.id, d.fecha_vencimiento]);
  return { status: 200, json: { ok: true, duplicado: dup ? conAlerta(dup) : null } };
}

async function crear({ body }) {
  const v = await validarNuevo(body); if (v.e) return v.e;
  const d = v.datos;
  const [r] = await query('INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [d.concepto, d.entidad, d.cat.id, d.monto, d.fecha_vencimiento]);
  return { status: 201, json: { id: r.id, concepto: d.concepto } };
}

// ---------- Archivos de evidencia: se valida el tipo REAL por los primeros bytes ----------
function tipoReal(b) {
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', '.jpg'];
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', '.png'];
  if (b.length > 5 && b.subarray(0, 5).toString() === '%PDF-') return ['application/pdf', '.pdf'];
  return null;
}
function validarArchivo(buf, headers) {
  if (!buf || !buf.length) return { e: err(400, 'Debes adjuntar la evidencia del pago.', { archivo: 'Adjunta la evidencia' }) };
  if (buf.length > MAX_BYTES) return { e: err(413, 'El archivo no puede superar 5 MB.', { archivo: 'Máximo 5 MB' }) };
  const tipo = tipoReal(buf);
  if (!tipo) return { e: err(400, `El archivo tiene un formato no admitido. ${FORMATOS}`, { archivo: FORMATOS }) };
  let nombre = 'evidencia' + tipo[1];
  try { nombre = decodeURIComponent(headers['x-nombre'] || '').slice(0, 120) || nombre; } catch { /* nombre por defecto */ }
  return { tipo, nombre };
}

// ---------- HU-06: registrar pago como realizado (fecha + hora + comentario + evidencia en UNA operación) ----------
// PUT /api/pagos/:id/pagar — cuerpo: el archivo; cabeceras: X-Fecha-Pago, X-Hora-Pago, X-Comentario, X-Nombre
async function pagar({ params, bodyCrudo, headers, usuario }) {
  const [p] = await query('SELECT id, estado, concepto FROM pagos WHERE id = $1', [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado !== 'PENDIENTE') return err(409, 'Solo se puede registrar como realizado un pago Pendiente.');

  const fecha = headers['x-fecha-pago']; const hora = headers['x-hora-pago'];
  let comentario = null;
  try { comentario = decodeURIComponent(headers['x-comentario'] || '').trim() || null; } catch { comentario = null; }

  if (!esFecha(fecha)) return err(400, 'La fecha de pago es obligatoria.', { fecha_pago: 'Indica la fecha de pago' });
  if (!esHora(hora)) return err(400, 'La hora de pago es obligatoria.', { hora_pago: 'Indica la hora de pago (HH:MM)' });
  if (`${fecha} ${hora}` > `${hoy()} ${horaAhora()}`) return err(400, 'La fecha y la hora de pago no pueden ser posteriores al momento actual.', { fecha_pago: 'No puede ser posterior al momento actual' });
  if (fecha < sumaDias(hoy(), -DIAS_MAX_ATRAS_PAGO)) return err(400, 'La fecha de pago no puede ser anterior en más de una semana al día de hoy.', { fecha_pago: 'Máximo una semana atrás' });
  if (comentario && comentario.length > 300) return err(400, 'El comentario no puede superar 300 caracteres.', { comentario: 'Máximo 300 caracteres' });
  const v = validarArchivo(bodyCrudo, headers); if (v.e) return v.e;

  // Un solo comando SQL = operación atómica: o pasa a PAGADO con su evidencia, o no pasa nada.
  const r = await query(`
    WITH u AS (
      UPDATE pagos SET estado='PAGADO', fecha_pago=$2, hora_pago=$3, comentario=$4, pagado_por=$5
      WHERE id=$1 AND estado='PENDIENTE' RETURNING id
    )
    INSERT INTO evidencias (pago_id, datos, nombre_original, tipo_mime, subido_por)
    SELECT id, $6, $7, $8, $5 FROM u RETURNING pago_id`,
    [p.id, fecha, hora, comentario, usuario.id, bodyCrudo, v.nombre, v.tipo[0]]);
  if (!r.length) return err(409, 'Solo se puede registrar como realizado un pago Pendiente.');
  return { status: 200, json: { ok: true, concepto: p.concepto, fecha_pago: fecha, hora_pago: hora, archivo: v.nombre } };
}

// ---------- HU-07: cambiar la evidencia (máx. 3 intentos; el archivo reemplazado queda como intento previo) ----------
async function cambiarEvidencia({ params, bodyCrudo, headers, usuario }) {
  const [p] = await query('SELECT id, estado FROM pagos WHERE id = $1', [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado !== 'PAGADO') return err(409, 'Solo se puede cambiar la evidencia de un pago Pagado.');
  const [{ usados }] = await query('SELECT count(*)::int AS usados FROM evidencias WHERE pago_id = $1 AND NOT vigente', [p.id]);
  if (usados >= MAX_CAMBIOS_EVIDENCIA) return err(409, `Se alcanzó el máximo de ${MAX_CAMBIOS_EVIDENCIA} intentos de cambio de evidencia.`);
  const v = validarArchivo(bodyCrudo, headers); if (v.e) return v.e;

  const [{ vig }] = await query('SELECT count(*)::int AS vig FROM evidencias WHERE pago_id = $1 AND vigente', [p.id]);
  let r;
  if (!vig) {
    // Pago Pagado que (por datos antiguos) no tiene archivo vigente: el nuevo pasa a ser la evidencia vigente, sin gastar un intento.
    r = await query('INSERT INTO evidencias (pago_id, datos, nombre_original, tipo_mime, subido_por, vigente) VALUES ($1,$2,$3,$4,$5,true) RETURNING pago_id',
      [p.id, bodyCrudo, v.nombre, v.tipo[0], usuario.id]);
    if (r.length) return { status: 200, json: { ok: true, intentos_restantes: MAX_CAMBIOS_EVIDENCIA - usados, sin_vigente: true } };
  }
  // Un solo comando: archiva la vigente (con su número de intento y hora) y deja la nueva como vigente.
  r = await query(`
    WITH u AS (
      UPDATE evidencias SET vigente = false, numero_intento = (SELECT count(*) FROM evidencias WHERE pago_id = $1 AND NOT vigente) + 1, reemplazada_en = now()
      WHERE pago_id = $1 AND vigente AND (SELECT count(*) FROM evidencias WHERE pago_id = $1 AND NOT vigente) < ${MAX_CAMBIOS_EVIDENCIA}
      RETURNING pago_id
    )
    INSERT INTO evidencias (pago_id, datos, nombre_original, tipo_mime, subido_por, vigente)
    SELECT pago_id, $2, $3, $4, $5, true FROM u RETURNING pago_id`,
    [p.id, bodyCrudo, v.nombre, v.tipo[0], usuario.id]);
  if (!r.length) return err(409, 'No fue posible cambiar la evidencia de este pago.');
  return { status: 200, json: { ok: true, intentos_restantes: MAX_CAMBIOS_EVIDENCIA - (usados + 1) } };
}

// ---------- HU-03: evidencia vigente + intentos previos (solo gerente) ----------
// GET /api/pagos/:id/evidencias
async function infoEvidencias({ params }) {
  const [p] = await query(`${SELECT} WHERE p.id = $1`, [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado === 'PENDIENTE') return err(409, 'Este pago aún no tiene evidencia porque no se ha registrado como realizado.');
  const archivos = await query(`
    SELECT id, vigente, numero_intento, nombre_original AS nombre, tipo_mime AS tipo,
           to_char(reemplazada_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS reemplazada_en
    FROM evidencias WHERE pago_id = $1 ORDER BY vigente DESC, numero_intento DESC`, [p.id]);
  if (!archivos.length) return err(404, 'Este pago no tiene evidencia.');
  const { id, concepto, entidad, monto, fecha_pago, hora_pago, comentario } = p;
  return { status: 200, json: { pago: { id, concepto, entidad, monto, fecha_pago, hora_pago, comentario }, vigente: archivos.find((a) => a.vigente), previos: archivos.filter((a) => !a.vigente) } };
}
// GET /api/evidencias/:id[?descargar=1] — ver o descargar un archivo (vigente o intento previo)
async function verArchivo({ params, query: qs }) {
  const [e] = await query('SELECT datos, tipo_mime, nombre_original FROM evidencias WHERE id = $1', [params.id]);
  if (!e) return err(404, 'Archivo no encontrado');
  return { status: 200, buffer: e.datos, tipo: e.tipo_mime, nombre: e.nombre_original, descargar: qs.get('descargar') === '1' };
}

module.exports = { listar, panel, porVencer, categorias, verificar, crear, pagar, cambiarEvidencia, infoEvidencias, verArchivo, MAX_BYTES };
