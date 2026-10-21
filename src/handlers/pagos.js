// Lógica de negocio. Cada función (async) recibe (ctx) y devuelve { status, json } o { status, buffer, tipo, nombre, descargar }.
// Trazabilidad: los comentarios HU-xx indican qué historia de usuario cumple cada bloque.
const crypto = require('crypto');
const { query } = require('../db');

// ---- Reglas de negocio (un solo lugar para ajustarlas) ----
const DIAS_POR_VENCER = Number(process.env.DIAS_POR_VENCER || 3);     // HU-08: hoy y los próximos 3 días
const MAX_BYTES = 5 * 1024 * 1024;                                    // HU-06/07: 5 MB
const MAX_CAMBIOS_EVIDENCIA = 3;                                      // HU-07: máximo 3 intentos de cambio
const DIAS_MAX_ATRAS_PAGO = 7;                                        // HU-06: el pago no puede ser anterior a 1 semana
const LIMITE_MONTO = { Servicios: 20000, 'Préstamos': 2000000 };                            // HU-05: tope por categoría (S/)
const LIMITE_MONTO_OTROS = 500000;                                    // Proveedores e Impuestos
const CUOTA_MINIMA = 50;                                              // Préstamos: monto mínimo de cada cuota (S/)
const MESES_MAX_VENCIMIENTO = 12;                                     // el vencimiento no puede pasar de 1 año desde el registro
const SOLO_LETRAS = /^[\p{L}]+(?: [\p{L}]+)*$/u;                     // entidad: solo letras (con tildes/ñ) y espacios
const FORMATOS = 'Formatos admitidos: JPG, PNG o PDF.';
const SERVICIOS = ['Agua', 'Luz', 'Internet'];                        // Servicios: Luz y Agua piden además código de suministro
const IMPUESTOS = { SUNAT: ['IGV', 'Impuesto a la renta'], SAT: ['Impuesto predial', 'Impuesto vehicular'] };
const MAX_CUOTAS = 120;                                               // Préstamos: máximo de cuotas mensuales (10 años)
const ANIOS_MAX_PRESTAMO = 10;                                        // Préstamos: el vencimiento total no pasa de 10 años
const DIAS_BASE_MORA = 360;                                           // Mora: tasa nominal anual sobre 360 días
const SOLO_ALFANUM = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;              // Nº de recibo / código de suministro
const RAZON_SOCIAL = /^[\p{L}\p{N}][\p{L}\p{N} .,&'\-]*$/u;
// Método de pago (con qué se pagó). Préstamos: solo cuenta bancaria (transferencia) o tarjeta de crédito.
const METODOS = { TRANSFERENCIA: [], EFECTIVO: [], BILLETERA: ['PLIN', 'YAPE', 'AGORA'], TARJETA: ['CREDITO', 'DEBITO'] };
const METODOS_PRESTAMO = { TRANSFERENCIA: [], TARJETA: ['CREDITO'] };
const NOMBRE_DET = { PLIN: 'Plin', YAPE: 'Yape', AGORA: 'Agora', CREDITO: 'crédito', DEBITO: 'débito' };
const metodoTexto = (m, d) => (!m ? null : m === 'TRANSFERENCIA' ? 'Transferencia' : m === 'EFECTIVO' ? 'Efectivo'
  : m === 'BILLETERA' ? `Billetera digital (${NOMBRE_DET[d] || '—'})` : `Tarjeta de ${NOMBRE_DET[d] || '—'}`);

// ---- Fechas (siempre hora de Lima) ----
const TZ = 'America/Lima';
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });                                   // AAAA-MM-DD
const horaAhora = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()); // HH:MM
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const esHora = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const sumaDias = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sumaAnio = (f) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
const sumaMeses = (f, n) => {       // mismo día cada mes (si el mes es más corto, el último día del mes)
  const [y, m, d] = f.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const ult = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, ult))).toISOString().slice(0, 10);
};
const diasEntre = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const err = (status, error, campos) => ({ status, json: campos ? { error, campos } : { error } });
const redondeo = (n) => Math.round(n * 100) / 100;

const SELECT = `
  SELECT p.id, 'PAG-' || lpad(p.id::text, 4, '0') AS codigo, p.concepto, p.entidad, p.categoria_id, p.monto::float8 AS monto, p.fecha_vencimiento, p.estado, p.fecha_pago, p.hora_pago, p.comentario,
         p.tipo_servicio, p.numero_recibo, p.codigo_suministro, p.ruc, p.razon_social, p.prestamo_id, p.numero_cuota, p.total_cuotas,
         p.metodo_pago, p.metodo_detalle, p.mora_pagada::float8 AS mora_pagada, pr.mora_tna::float8 AS mora_tna,
         p.congelado, p.motivo_congelado, to_char(p.congelado_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS congelado_en,
         c.nombre AS categoria, e.nombre_original AS evidencia_nombre, e.tipo_mime AS evidencia_tipo, (e.id IS NOT NULL) AS tiene_evidencia,
         (SELECT count(*)::int FROM evidencias x WHERE x.pago_id = p.id AND NOT x.vigente) AS intentos_usados
  FROM pagos p JOIN categorias c ON c.id = p.categoria_id LEFT JOIN prestamos pr ON pr.id = p.prestamo_id LEFT JOIN evidencias e ON e.pago_id = p.id AND e.vigente`;

// Mora = cuota × tasa nominal anual ÷ 360 × días de atraso (solo préstamos con mora)
const calcMora = (monto, tna, diasAtraso) => (tna > 0 && diasAtraso > 0 ? redondeo(monto * (tna / 100) / DIAS_BASE_MORA * diasAtraso) : 0);

// Datos propios de la categoría, listos para mostrar: [[etiqueta, valor], ...]
function detalleDe(p) {
  const d = [];
  if (p.tipo_servicio) d.push(['Servicio', p.tipo_servicio]);
  if (p.numero_recibo) d.push(['N.º de recibo', p.numero_recibo]);
  if (p.codigo_suministro) d.push(['Código de suministro', p.codigo_suministro]);
  if (p.ruc) d.push(['RUC', p.ruc]);
  if (p.razon_social) d.push(['Razón social', p.razon_social]);
  if (p.numero_cuota) d.push(['Cuota', `${p.numero_cuota} de ${p.total_cuotas}`]);
  return d;
}

// Un pago Pendiente con vencimiento anterior a hoy está ATRASADO; dentro de los próximos 3 días, POR_VENCER.
// Un pago CONGELADO por el gerente no se marca como atrasado ni por vencer y no genera mora mientras siga congelado.
// estado_visible (lo que ve el usuario): PENDIENTE, PAGADO, ATRASADO o CONGELADO.
function conAlerta(p) {
  const h = hoy(); let alerta = null; let dias = null; let mora = p.estado === 'PAGADO' ? (p.mora_pagada || 0) : 0;
  const congelado = p.estado === 'PENDIENTE' && !!p.congelado;
  if (p.estado === 'PENDIENTE') {
    dias = diasEntre(h, p.fecha_vencimiento); // >0 faltan, 0 vence hoy, <0 atraso
    if (!congelado) {
      if (dias < 0) { alerta = 'ATRASADO'; mora = calcMora(p.monto, p.mora_tna || 0, -dias); }
      else if (dias <= DIAS_POR_VENCER) alerta = 'POR_VENCER';
    }
  }
  const estado_visible = p.estado === 'PAGADO' ? 'PAGADO' : congelado ? 'CONGELADO' : alerta === 'ATRASADO' ? 'ATRASADO' : 'PENDIENTE';
  return { ...p, congelado, estado_visible, tiene_evidencia: !!p.tiene_evidencia, alerta, dias, intentos_restantes: Math.max(0, MAX_CAMBIOS_EVIDENCIA - (p.intentos_usados || 0)),
    mora, total: redondeo(p.monto + mora), metodo_texto: metodoTexto(p.metodo_pago, p.metodo_detalle), detalle: detalleDe(p) };
}
const suma = (l) => redondeo(l.reduce((s, p) => s + p.total, 0));      // incluye la mora

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
  const pendientes = filas.filter((p) => p.estado === 'PENDIENTE');                                             // ya vienen por vencimiento (incluye congelados)
  const congelados = pendientes.filter((p) => p.congelado);
  const atrasados = pendientes.filter((p) => p.alerta === 'ATRASADO');
  const enPlazo = pendientes.filter((p) => !p.congelado && p.alerta !== 'ATRASADO');
  const hoyLista = filas.filter((p) => p.fecha_vencimiento === h);
  const resumen = {
    pagados: { n: pagados.length, monto: suma(pagados) },
    pendientes: { n: enPlazo.length, monto: suma(enPlazo) },
    atrasados: { n: atrasados.length, monto: suma(atrasados) },
    congelados: { n: congelados.length, monto: suma(congelados) },
  };
  // «Cambios de evidencia»: archivos reemplazados (intentos previos), el más reciente primero
  const cambios = await query(`
    SELECT e.id AS evidencia_id, e.numero_intento, p.id AS pago_id, 'PAG-' || lpad(p.id::text, 4, '0') AS codigo, p.concepto, p.entidad,
           to_char(e.reemplazada_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS fecha_hora
    FROM evidencias e JOIN pagos p ON p.id = e.pago_id WHERE NOT e.vigente ORDER BY e.reemplazada_en DESC LIMIT 30`);
  return { status: 200, json: { hoy: h, mes, hay_pagos: filas.length > 0, resumen, hoy_lista: hoyLista, pagados, pendientes, cambios } };
}

// ---------- HU-08: pagos por vencer (asistente) ----------
async function porVencer() {
  const limite = sumaDias(hoy(), DIAS_POR_VENCER);
  const pagos = (await query(`${SELECT} WHERE p.estado = 'PENDIENTE' AND NOT p.congelado AND p.fecha_vencimiento <= $1
    ORDER BY p.fecha_vencimiento, p.id`, [limite])).map(conAlerta);
  return { status: 200, json: { hoy: hoy(), dias_por_vencer: DIAS_POR_VENCER, pagos } };
}

const categorias = async () => ({ status: 200, json: await query('SELECT * FROM categorias ORDER BY id') });

// ---------- HU-05: registrar un pago por realizar ----------
// El formulario cambia según la categoría (Servicios, Proveedores, Impuestos, Préstamos).
const validarEntidad = (body, campos, max = 100) => {
  const entidad = String(body.entidad ?? '').trim();
  if (!entidad) campos.entidad = 'Ingresa la entidad (empresa o persona a la que se paga)';
  else if (entidad.length > max) campos.entidad = `La entidad no puede superar ${max} caracteres`;
  else if (!SOLO_LETRAS.test(entidad)) campos.entidad = 'La entidad solo puede contener letras (sin números ni caracteres especiales)';
  return entidad;
};
const palabrasMonto = (l) => (l >= 1e6 && l % 1e6 === 0 ? `${l / 1e6} ${l === 1e6 ? 'millón' : 'millones'} de soles` : l % 1000 === 0 ? `${l / 1000} mil soles` : `${l.toLocaleString('en-US')} soles`);
function validarMonto(txt, cat, campo, campos) {
  txt = String(txt ?? '').trim();
  if (!txt) campos[campo] = 'Ingresa el monto en soles (S/)';
  else if (!/^\d+(\.\d{1,2})?$/.test(txt) || !(Number(txt) > 0)) campos[campo] = 'El monto debe ser mayor que cero, con hasta dos decimales';
  else {
    const limite = LIMITE_MONTO[cat.nombre] ?? LIMITE_MONTO_OTROS;
    if (Number(txt) > limite) campos[campo] = `El monto no puede exceder los ${palabrasMonto(limite)} (S/ ${limite.toLocaleString('en-US')}.00)`;
  }
  return Number(txt);
}
// Cuántas cuotas mensuales caben entre la primera cuota y el vencimiento del préstamo (1 cuota = 1 mes)
const cuotasQueCaben = (primera, total) => { let n = 1; while (sumaMeses(primera, n) <= total) n++; return n; };
function validarVencimiento(f, campo, campos, atrasado = false) {
  if (!f) campos[campo] = 'Ingresa la fecha de vencimiento';
  else if (!esFecha(f)) campos[campo] = 'La fecha de vencimiento no es válida';
  else if (atrasado) {   // pago atrasado: ya venció, así que la fecha debe ser anterior a hoy (y no más de 1 año atrás)
    if (f >= hoy()) campos[campo] = 'Un pago atrasado debe tener una fecha de vencimiento anterior a hoy';
    else if (f < sumaMeses(hoy(), -12)) campos[campo] = 'El vencimiento no puede ser anterior a 1 año desde hoy';
  }
  else if (f < hoy()) campos[campo] = 'La fecha de vencimiento no puede ser anterior a hoy. Si el pago ya venció, márcalo como «Pago atrasado»';   // hoy sí: vence al terminar el día (00:00 del día siguiente)
  else if (f > sumaAnio(hoy())) campos[campo] = 'El vencimiento no puede ser mayor a 1 año desde hoy';
}
// Reparte el total en cuotas iguales (en céntimos); la última absorbe la diferencia
function repartirCuotas(total, n, primera) {
  const cent = Math.round(total * 100); const base = Math.floor(cent / n); const resto = cent - base * n;
  return Array.from({ length: n }, (_, i) => ({ numero: i + 1, fecha: sumaMeses(primera, i), monto: (base + (i === n - 1 ? resto : 0)) / 100 }));
}

async function validarNuevo(body) {
  const campos = {};
  const catId = Number(body.categoria_id);
  const [cat] = Number.isInteger(catId) && catId > 0 ? await query('SELECT id, nombre FROM categorias WHERE id = $1', [catId]) : [];
  if (!body.categoria_id) campos.categoria_id = 'Selecciona una categoría';
  else if (!cat) campos.categoria_id = 'Categoría inválida';
  if (!cat) return { e: err(400, 'Corrige los campos indicados', campos) };

  const t = (k) => String(body[k] ?? '').trim();
  const atrasado = body.atrasado === true || body.atrasado === 'true';   // solo para pagos que no son préstamos
  const fila = { concepto: '', entidad: '', tipo_servicio: null, numero_recibo: null, codigo_suministro: null, ruc: null, razon_social: null };
  let monto = 0; let vencimiento = null; let prestamo = null; let cuotas = null;

  if (cat.nombre === 'Servicios') {
    const tipo = t('tipo_servicio');
    if (!tipo) campos.tipo_servicio = 'Selecciona el servicio (Agua, Luz o Internet)';
    else if (!SERVICIOS.includes(tipo)) campos.tipo_servicio = 'Servicio inválido';
    fila.entidad = validarEntidad(body, campos);
    const rec = t('numero_recibo');
    if (!rec) campos.numero_recibo = 'Ingresa el número de recibo';
    else if (rec.length > 30 || !SOLO_ALFANUM.test(rec)) campos.numero_recibo = 'El número de recibo solo puede tener letras, números y guiones (máx. 30)';
    if (tipo === 'Luz' || tipo === 'Agua') {
      const cod = t('codigo_suministro');
      if (!cod) campos.codigo_suministro = 'Ingresa el código de suministro';
      else if (cod.length > 20 || !SOLO_ALFANUM.test(cod)) campos.codigo_suministro = 'El código de suministro solo puede tener letras, números y guiones (máx. 20)';
      else fila.codigo_suministro = cod;
    }
    Object.assign(fila, { concepto: tipo, tipo_servicio: tipo, numero_recibo: rec });
    monto = validarMonto(body.monto, cat, 'monto', campos); vencimiento = t('fecha_vencimiento'); validarVencimiento(vencimiento, 'fecha_vencimiento', campos, atrasado);

  } else if (cat.nombre === 'Proveedores') {
    const ruc = t('ruc');
    if (!ruc) campos.ruc = 'Ingresa el RUC del proveedor';
    else if (!/^\d{11}$/.test(ruc)) campos.ruc = 'El RUC debe tener 11 dígitos numéricos';
    else if (!['10', '15', '16', '17', '20'].includes(ruc.slice(0, 2))) campos.ruc = 'El RUC debe empezar con 10, 15, 16, 17 o 20';
    const rs = t('razon_social');
    if (!rs) campos.razon_social = 'Ingresa la razón social';
    else if (rs.length < 2 || rs.length > 100 || !RAZON_SOCIAL.test(rs)) campos.razon_social = 'La razón social no es válida (letras, números, espacios y . , & - \')';
    Object.assign(fila, { concepto: 'Pago a proveedor', entidad: rs, ruc, razon_social: rs });
    monto = validarMonto(body.monto, cat, 'monto', campos); vencimiento = t('fecha_vencimiento'); validarVencimiento(vencimiento, 'fecha_vencimiento', campos, atrasado);

  } else if (cat.nombre === 'Impuestos') {
    const ent = t('entidad');
    if (!ent) campos.entidad = 'Selecciona la entidad (SUNAT o SAT)';
    else if (!IMPUESTOS[ent]) campos.entidad = 'La entidad debe ser SUNAT o SAT';
    const imp = t('concepto_impuesto');
    if (!imp) campos.concepto_impuesto = 'Selecciona el impuesto';
    else if (IMPUESTOS[ent] && !IMPUESTOS[ent].includes(imp)) campos.concepto_impuesto = `Con ${ent} solo se puede pagar: ${IMPUESTOS[ent].join(' o ')}`;
    Object.assign(fila, { concepto: imp, entidad: ent });
    monto = validarMonto(body.monto, cat, 'monto', campos); vencimiento = t('fecha_vencimiento'); validarVencimiento(vencimiento, 'fecha_vencimiento', campos, atrasado);

  } else {   // Préstamos
    fila.entidad = validarEntidad(body, campos);
    monto = validarMonto(body.monto_total, cat, 'monto_total', campos);
    const nTxt = t('num_cuotas'); const n = Number(nTxt);
    if (!nTxt) campos.num_cuotas = 'Ingresa el número de cuotas';
    else if (!/^\d{1,3}$/.test(nTxt) || n < 1 || n > MAX_CUOTAS) campos.num_cuotas = `El número de cuotas debe ser un entero entre 1 y ${MAX_CUOTAS}`;
    const moraTxt = t('mora_tna'); const mora = Number(moraTxt);
    if (!moraTxt) campos.mora_tna = 'Ingresa la mora (puede ser 0)';
    else if (!/^\d{1,3}(\.\d{1,2})?$/.test(moraTxt) || mora > 100) campos.mora_tna = 'La mora debe estar entre 0 y 100 %, con hasta dos decimales';
    const primera = t('fecha_primera_cuota'); const total = t('fecha_vencimiento_total');
    validarVencimiento(primera, 'fecha_primera_cuota', campos);
    if (!total) campos.fecha_vencimiento_total = 'Ingresa la fecha en que vence el préstamo';
    else if (!esFecha(total)) campos.fecha_vencimiento_total = 'La fecha de vencimiento del préstamo no es válida';
    else if (primera && esFecha(primera) && total < primera) campos.fecha_vencimiento_total = 'No puede ser anterior a la fecha de la primera cuota';
    else if (total > sumaMeses(hoy(), 12 * ANIOS_MAX_PRESTAMO)) campos.fecha_vencimiento_total = `El préstamo no puede vencer en más de ${ANIOS_MAX_PRESTAMO} años`;
    // Coherencia: 1 cuota = 1 mes, así que el número de cuotas debe coincidir con los meses del préstamo y cada cuota debe ser razonable
    if (!campos.num_cuotas && !campos.fecha_primera_cuota && !campos.fecha_vencimiento_total) {
      const fmt = (f) => f.split('-').reverse().join('/'); const k = cuotasQueCaben(primera, total);
      if (n !== k) campos.num_cuotas = `No es coherente: con 1 cuota por mes, entre ${fmt(primera)} y ${fmt(total)} corresponden ${k} ${k === 1 ? 'cuota' : 'cuotas'}, no ${n}. Ajusta las cuotas o la fecha de vencimiento`;
      else if (!campos.monto_total && monto / n < CUOTA_MINIMA) campos.num_cuotas = `Con ${n} ${n === 1 ? 'cuota' : 'cuotas'} cada una sería de S/ ${(monto / n).toFixed(2)}; la cuota mínima es S/ ${CUOTA_MINIMA.toFixed(2)}. Reduce el plazo o aumenta el monto`;
    }
    if (!Object.keys(campos).length) cuotas = repartirCuotas(monto, n, primera);
    prestamo = { monto_total: monto, num_cuotas: n, mora_tna: mora, fecha_vencimiento_total: total, fecha_primera_cuota: primera };
    Object.assign(fila, { concepto: 'Préstamo' });
  }

  if (Object.keys(campos).length) return { e: err(400, 'Corrige los campos indicados', campos) };
  return { datos: { cat, fila, monto, fecha_vencimiento: vencimiento, prestamo, cuotas } };
}

// POST /api/pagos/verificar — valida y avisa si podría ser un pago repetido; en préstamos devuelve la previsualización de cuotas
async function verificar({ body }) {
  const v = await validarNuevo(body); if (v.e) return v.e;
  const d = v.datos;
  if (d.prestamo) {
    const [dup] = await query(`SELECT p.entidad, p.monto_total::float8 AS monto, p.fecha_primera_cuota, p.num_cuotas FROM prestamos p
      WHERE lower(trim(p.entidad)) = lower($1) AND p.monto_total = $2 AND p.num_cuotas = $3 AND p.fecha_primera_cuota = $4 LIMIT 1`,
      [d.fila.entidad, d.prestamo.monto_total, d.prestamo.num_cuotas, d.prestamo.fecha_primera_cuota]);
    return { status: 200, json: { ok: true, cuotas: d.cuotas, duplicado: dup ? { concepto: `Préstamo de ${dup.num_cuotas} cuotas`, entidad: dup.entidad, categoria: 'Préstamos', monto: dup.monto, fecha_vencimiento: dup.fecha_primera_cuota, estado: 'PENDIENTE' } : null } };
  }
  const [dup] = await query(`${SELECT} WHERE lower(trim(p.entidad)) = lower($1) AND lower(p.concepto) = lower($4) AND p.categoria_id = $2 AND left(p.fecha_vencimiento,7) = left($3,7)
                            ORDER BY p.fecha_vencimiento LIMIT 1`, [d.fila.entidad, d.cat.id, d.fecha_vencimiento, d.fila.concepto]);
  return { status: 200, json: { ok: true, duplicado: dup ? conAlerta(dup) : null } };
}

async function crear({ body }) {
  const v = await validarNuevo(body); if (v.e) return v.e;
  const d = v.datos; const f = d.fila;
  if (d.prestamo) {
    // Un solo comando = atómico: se crea el préstamo y TODAS sus cuotas, o nada.
    const pr = d.prestamo; const n = d.cuotas.length;
    const r = await query(`
      WITH pr AS (
        INSERT INTO prestamos (entidad, monto_total, num_cuotas, mora_tna, fecha_vencimiento_total, fecha_primera_cuota)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      )
      INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento, prestamo_id, numero_cuota, total_cuotas)
      SELECT 'Cuota ' || t.numero || ' de ' || $3::int, $1, $7, t.monto, t.fecha, (SELECT id FROM pr), t.numero, $3::int
      FROM jsonb_to_recordset($8::jsonb) AS t(numero int, fecha text, monto numeric) RETURNING id`,
      [f.entidad, pr.monto_total, n, pr.mora_tna, pr.fecha_vencimiento_total, pr.fecha_primera_cuota, d.cat.id,
        JSON.stringify(d.cuotas)]);
    return { status: 201, json: { id: r[0].id, concepto: `Préstamo de ${f.entidad} (${n} ${n === 1 ? 'cuota' : 'cuotas'})`, cuotas: r.length } };
  }
  const [r] = await query(`INSERT INTO pagos (concepto, entidad, categoria_id, monto, fecha_vencimiento, tipo_servicio, numero_recibo, codigo_suministro, ruc, razon_social)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [f.concepto, f.entidad, d.cat.id, d.monto, d.fecha_vencimiento, f.tipo_servicio, f.numero_recibo, f.codigo_suministro, f.ruc, f.razon_social]);
  return { status: 201, json: { id: r.id, concepto: f.concepto } };
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
  return { tipo, nombre, hash: crypto.createHash('sha256').update(buf).digest('hex') };
}
// Un mismo archivo (mismos bytes) no puede usarse como evidencia dos veces: ni en otro pago ni en otro intento del mismo pago.
async function archivoRepetido(hash, pagoId) {
  const [d] = await query(`SELECT pago_id, vigente, 'PAG-' || lpad(pago_id::text, 4, '0') AS codigo FROM evidencias WHERE hash = $1 ORDER BY (pago_id = $2) DESC LIMIT 1`, [hash, pagoId]);
  if (!d) return null;
  const msg = d.pago_id === pagoId
    ? (d.vigente ? 'Este archivo es igual a la evidencia vigente de este pago. Sube un archivo distinto.' : 'Este archivo es igual a un intento anterior de este pago. Sube un archivo distinto.')
    : `Este archivo ya fue usado como evidencia del pago ${d.codigo}. Cada pago debe tener su propia evidencia.`;
  return err(409, msg, { archivo: msg });
}

// ---------- HU-06: registrar pago como realizado (fecha + hora + comentario + evidencia en UNA operación) ----------
// PUT /api/pagos/:id/pagar — cuerpo: el archivo; cabeceras: X-Fecha-Pago, X-Hora-Pago, X-Comentario, X-Nombre
async function pagar({ params, bodyCrudo, headers, usuario }) {
  const [p] = await query(`SELECT p.id, p.estado, p.congelado, p.concepto, p.monto::float8 AS monto, p.fecha_vencimiento, c.nombre AS categoria, pr.mora_tna::float8 AS mora_tna
    FROM pagos p JOIN categorias c ON c.id = p.categoria_id LEFT JOIN prestamos pr ON pr.id = p.prestamo_id WHERE p.id = $1`, [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado !== 'PENDIENTE') return err(409, 'Solo se puede registrar como realizado un pago Pendiente.');
  if (p.congelado) return err(409, 'Este pago está congelado por el gerente. No se puede registrar como realizado hasta que lo descongele.');

  const fecha = headers['x-fecha-pago']; const hora = headers['x-hora-pago'];
  let comentario = null;
  try { comentario = decodeURIComponent(headers['x-comentario'] || '').trim() || null; } catch { comentario = null; }

  if (!esFecha(fecha)) return err(400, 'La fecha de pago es obligatoria.', { fecha_pago: 'Indica la fecha de pago' });
  if (!esHora(hora)) return err(400, 'La hora de pago es obligatoria.', { hora_pago: 'Indica la hora de pago (HH:MM)' });
  if (`${fecha} ${hora}` > `${hoy()} ${horaAhora()}`) return err(400, 'La fecha y la hora de pago no pueden ser posteriores al momento actual.', { fecha_pago: 'No puede ser posterior al momento actual' });
  if (fecha < sumaDias(hoy(), -DIAS_MAX_ATRAS_PAGO)) return err(400, 'La fecha de pago no puede ser anterior en más de una semana al día de hoy.', { fecha_pago: 'Máximo una semana atrás' });
  if (comentario && comentario.length > 300) return err(400, 'El comentario no puede superar 300 caracteres.', { comentario: 'Máximo 300 caracteres' });
  // Método de pago (con qué se pagó). Ningún método tiene descuento: el monto no cambia.
  const metodo = String(headers['x-metodo-pago'] || '').toUpperCase(); const detalle = String(headers['x-metodo-detalle'] || '').toUpperCase() || null;
  const permitidos = p.categoria === 'Préstamos' ? METODOS_PRESTAMO : METODOS;
  if (!metodo) return err(400, 'Selecciona el método de pago.', { metodo_pago: 'Selecciona el método de pago' });
  if (!permitidos[metodo]) return err(400, p.categoria === 'Préstamos' ? 'Para préstamos solo se paga con transferencia (cuenta bancaria) o tarjeta de crédito.' : 'Método de pago inválido.', { metodo_pago: 'Método de pago inválido' });
  if (permitidos[metodo].length && !permitidos[metodo].includes(detalle)) return err(400, 'Completa el método de pago.', { metodo_detalle: metodo === 'BILLETERA' ? 'Selecciona Plin, Yape o Agora' : 'Selecciona crédito o débito' });
  if (!permitidos[metodo].length && detalle) return err(400, 'Método de pago inválido.', { metodo_pago: 'Método de pago inválido' });
  const v = validarArchivo(bodyCrudo, headers); if (v.e) return v.e;
  const rep = await archivoRepetido(v.hash, p.id); if (rep) return rep;
  const mora = calcMora(p.monto, p.mora_tna || 0, diasEntre(p.fecha_vencimiento, fecha));   // mora hasta la fecha de pago (solo préstamos atrasados)

  // Un solo comando SQL = operación atómica: o pasa a PAGADO con su evidencia, o no pasa nada.
  const r = await query(`
    WITH u AS (
      UPDATE pagos SET estado='PAGADO', fecha_pago=$2, hora_pago=$3, comentario=$4, pagado_por=$5, metodo_pago=$9, metodo_detalle=$10, mora_pagada=$11
      WHERE id=$1 AND estado='PENDIENTE' AND NOT congelado AND NOT EXISTS (SELECT 1 FROM evidencias WHERE hash=$12) RETURNING id
    )
    INSERT INTO evidencias (pago_id, datos, nombre_original, tipo_mime, subido_por, comentario, hash)
    SELECT id, $6, $7, $8, $5, $4, $12 FROM u RETURNING pago_id`,
    [p.id, fecha, hora, comentario, usuario.id, bodyCrudo, v.nombre, v.tipo[0], metodo, detalle, mora, v.hash]);
  if (!r.length) return err(409, 'Solo se puede registrar como realizado un pago Pendiente.');
  return { status: 200, json: { ok: true, concepto: p.concepto, fecha_pago: fecha, hora_pago: hora, archivo: v.nombre, metodo_texto: metodoTexto(metodo, detalle), mora, total: redondeo(p.monto + mora) } };
}

// ---------- HU-07: cambiar la evidencia (máx. 3 intentos; el archivo reemplazado queda como intento previo) ----------
async function cambiarEvidencia({ params, bodyCrudo, headers, usuario }) {
  const [p] = await query('SELECT id, estado, monto::float8 AS monto FROM pagos WHERE id = $1', [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado !== 'PAGADO') return err(409, 'Solo se puede cambiar la evidencia de un pago Pagado.');
  const [{ usados }] = await query('SELECT count(*)::int AS usados FROM evidencias WHERE pago_id = $1 AND NOT vigente', [p.id]);
  if (usados >= MAX_CAMBIOS_EVIDENCIA) return err(409, `Se alcanzó el máximo de ${MAX_CAMBIOS_EVIDENCIA} intentos de cambio de evidencia.`);
  let comentario = null;
  try { comentario = decodeURIComponent(headers['x-comentario'] || '').trim() || null; } catch { comentario = null; }
  if (comentario && comentario.length > 300) return err(400, 'El comentario no puede superar 300 caracteres.', { comentario: 'Máximo 300 caracteres' });
  const v = validarArchivo(bodyCrudo, headers); if (v.e) return v.e;
  const rep = await archivoRepetido(v.hash, p.id); if (rep) return rep;

  const [{ vig }] = await query('SELECT count(*)::int AS vig FROM evidencias WHERE pago_id = $1 AND vigente', [p.id]);
  let r;
  if (!vig) {
    // Pago Pagado que (por datos antiguos) no tiene archivo vigente: el nuevo pasa a ser la evidencia vigente, sin gastar un intento.
    r = await query('INSERT INTO evidencias (pago_id, datos, nombre_original, tipo_mime, subido_por, vigente, comentario, hash) VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING pago_id',
      [p.id, bodyCrudo, v.nombre, v.tipo[0], usuario.id, comentario, v.hash]);
    if (r.length) return { status: 200, json: { ok: true, intentos_restantes: MAX_CAMBIOS_EVIDENCIA - usados, sin_vigente: true } };
  }
  // Un solo comando: archiva la vigente (con su número de intento y hora) y deja la nueva como vigente.
  r = await query(`
    WITH u AS (
      UPDATE evidencias SET vigente = false, numero_intento = (SELECT count(*) FROM evidencias WHERE pago_id = $1 AND NOT vigente) + 1, reemplazada_en = now()
      WHERE pago_id = $1 AND vigente AND (SELECT count(*) FROM evidencias WHERE pago_id = $1 AND NOT vigente) < ${MAX_CAMBIOS_EVIDENCIA}
        AND NOT EXISTS (SELECT 1 FROM evidencias WHERE hash = $7)
      RETURNING pago_id
    )
    INSERT INTO evidencias (pago_id, datos, nombre_original, tipo_mime, subido_por, vigente, comentario, hash)
    SELECT pago_id, $2, $3, $4, $5, true, $6, $7 FROM u RETURNING pago_id`,
    [p.id, bodyCrudo, v.nombre, v.tipo[0], usuario.id, comentario, v.hash]);
  if (!r.length) return err(409, 'No fue posible cambiar la evidencia de este pago.');
  return { status: 200, json: { ok: true, intentos_restantes: MAX_CAMBIOS_EVIDENCIA - (usados + 1) } };
}

// ---------- Congelar / descongelar un pago (solo gerente) ----------
// Un pago congelado no se puede registrar como realizado y no genera mora; se muestra con el estado «Congelado».
// POST /api/pagos/:id/congelar  { motivo? }   ·   POST /api/pagos/:id/descongelar
async function congelar({ params, body }) {
  const [p] = await query('SELECT id, estado, congelado, concepto FROM pagos WHERE id = $1', [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado === 'PAGADO') return err(409, 'Un pago que ya está Pagado no se puede congelar.');
  if (p.congelado) return err(409, 'Este pago ya está congelado.');
  const motivo = String(body.motivo ?? '').trim();
  if (motivo.length > 200) return err(400, 'El motivo no puede superar 200 caracteres.', { motivo: 'Máximo 200 caracteres' });
  const r = await query(`UPDATE pagos SET congelado = true, congelado_en = now(), motivo_congelado = $2 WHERE id = $1 AND estado = 'PENDIENTE' AND NOT congelado RETURNING id`, [p.id, motivo || null]);
  if (!r.length) return err(409, 'No fue posible congelar el pago.');
  return { status: 200, json: { ok: true, concepto: p.concepto } };
}
async function descongelar({ params }) {
  const [p] = await query('SELECT id, estado, congelado, concepto FROM pagos WHERE id = $1', [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (!p.congelado) return err(409, 'Este pago no está congelado.');
  const r = await query('UPDATE pagos SET congelado = false, congelado_en = NULL, motivo_congelado = NULL WHERE id = $1 AND congelado RETURNING id', [p.id]);
  if (!r.length) return err(409, 'No fue posible descongelar el pago.');
  return { status: 200, json: { ok: true, concepto: p.concepto } };
}

// ---------- Ver detalles: todos los datos de un pago (y, si es un préstamo, todas sus cuotas) ----------
// GET /api/pagos/:id/detalle — lo pueden ver el gerente y el asistente
async function detalle({ params }) {
  const [p0] = await query(`${SELECT} WHERE p.id = $1`, [params.id]);
  if (!p0) return err(404, 'Pago no encontrado');
  const p = conAlerta(p0);
  const [extra] = await query(`SELECT to_char(x.creado_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS registrado_en, u.nombre AS pagado_por_nombre
    FROM pagos x LEFT JOIN usuarios u ON u.id = x.pagado_por WHERE x.id = $1`, [p.id]);
  let prestamo = null; let cuotas = null;
  if (p.prestamo_id) {
    [prestamo] = await query(`SELECT entidad, monto_total::float8 AS monto_total, num_cuotas, mora_tna::float8 AS mora_tna, fecha_vencimiento_total, fecha_primera_cuota
      FROM prestamos WHERE id = $1`, [p.prestamo_id]);
    const filas = (await query(`${SELECT} WHERE p.prestamo_id = $1 ORDER BY p.numero_cuota`, [p.prestamo_id])).map(conAlerta);
    cuotas = filas.map((c) => ({ id: c.id, codigo: c.codigo, numero_cuota: c.numero_cuota, fecha_vencimiento: c.fecha_vencimiento, monto: c.monto, mora: c.mora, total: c.total,
      estado: c.estado, estado_visible: c.estado_visible, congelado: c.congelado, alerta: c.alerta, dias: c.dias, fecha_pago: c.fecha_pago, hora_pago: c.hora_pago, metodo_texto: c.metodo_texto, actual: c.id === p.id }));
    const pagadas = filas.filter((c) => c.estado === 'PAGADO');
    prestamo.resumen = { pagadas: pagadas.length, pendientes: filas.length - pagadas.length, atrasadas: filas.filter((c) => c.alerta === 'ATRASADO').length,
      total_pagado: suma(pagadas), saldo: suma(filas.filter((c) => c.estado !== 'PAGADO')) };
  }
  return { status: 200, json: { pago: { ...p, ...extra }, prestamo, cuotas } };
}

// ---------- HU-03: evidencia vigente + intentos previos (solo gerente) ----------
// GET /api/pagos/:id/evidencias
async function infoEvidencias({ params }) {
  const [p] = await query(`${SELECT} WHERE p.id = $1`, [params.id]);
  if (!p) return err(404, 'Pago no encontrado');
  if (p.estado === 'PENDIENTE') return err(409, 'Este pago aún no tiene evidencia porque no se ha registrado como realizado.');
  const archivos = await query(`
    SELECT id, vigente, numero_intento, nombre_original AS nombre, tipo_mime AS tipo, comentario,
           to_char(reemplazada_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS reemplazada_en
    FROM evidencias WHERE pago_id = $1 ORDER BY vigente DESC, numero_intento DESC`, [p.id]);
  if (!archivos.length) return err(404, 'Este pago no tiene evidencia.');
  const { id, codigo, concepto, entidad, monto, fecha_pago, hora_pago, comentario } = p; const q = conAlerta(p);
  return { status: 200, json: { pago: { id, codigo, concepto, entidad, monto, fecha_pago, hora_pago, comentario, categoria: p.categoria, detalle: q.detalle, metodo_texto: q.metodo_texto, mora: q.mora, total: q.total }, vigente: archivos.find((a) => a.vigente), previos: archivos.filter((a) => !a.vigente) } };
}
// GET /api/evidencias/:id[?descargar=1] — ver o descargar un archivo (vigente o intento previo)
async function verArchivo({ params, query: qs }) {
  const [e] = await query('SELECT datos, tipo_mime, nombre_original FROM evidencias WHERE id = $1', [params.id]);
  if (!e) return err(404, 'Archivo no encontrado');
  return { status: 200, buffer: e.datos, tipo: e.tipo_mime, nombre: e.nombre_original, descargar: qs.get('descargar') === '1' };
}

module.exports = { congelar, descongelar, detalle, listar, panel, porVencer, categorias, verificar, crear, pagar, cambiarEvidencia, infoEvidencias, verArchivo, MAX_BYTES };
