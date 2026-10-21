// Frontend sin framework. Los comentarios HU-xx indican qué historia de usuario cumple cada bloque.
// Gerente: panel de monitoreo (HU-02) y evidencias (HU-03). Asistente: pagos del mes en lista/calendario (HU-04),
// registrar (HU-05), pagar con evidencia (HU-06), cambiar evidencia (HU-07), por vencer (HU-08) y aviso (HU-09).
const $ = (id) => document.getElementById(id);
const soles = (n) => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtFecha = (f) => (f ? f.split('-').reverse().join('/') : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_BYTES = 5 * 1024 * 1024;
const TIPOS = ['image/jpeg', 'image/png', 'application/pdf'];
const MSG_FORMATOS = 'Formato no admitido. Formatos admitidos: JPG, PNG o PDF.';
const MSG_TAMANO = 'El archivo no puede superar 5 MB.';
const MAX_ARCHIVOS = 3, MAX_TOTAL = 3 * MAX_BYTES;   // hasta 3 archivos, 15 MB entre todos
const TZ = 'America/Lima';
const fechaLima = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const horaLima = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const sumaDias = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nombreMes = (m) => { const [y, mm] = m.split('-').map(Number); const t = new Date(y, mm - 1, 1).toLocaleDateString('es-PE', { month: 'long' }); return `${t[0].toUpperCase()}${t.slice(1)} ${y}`; };

let categoriasLista = [];
let usuario = null, mes = null, pagosMes = [], pagosVencer = [], vistaMes = 'lista', diasVencer = 3;

// ---------- Utilidades ----------
async function api(url, opciones = {}) {
  let r;
  try { r = await fetch(url, opciones); } catch { throw Object.assign(new Error('Sin conexión'), { red: true }); }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { mostrarLogin(datos.reemplazada ? datos.error : ''); throw Object.assign(new Error('Sesión expirada'), { sesion: true }); }
  if (!r.ok) throw Object.assign(new Error(datos.error || 'Error'), { campos: datos.campos, status: r.status, requiereJustificacion: !!datos.requiere_justificacion });
  return datos;
}
const enviarJson = (url, metodo, cuerpo) => api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
// Envía de 1 a 3 archivos en un solo cuerpo; X-Archivos indica nombre y tamaño de cada uno.
const enviarArchivos = (url, archivos, extra = {}) => { const lista = [...archivos];
  return api(url, { method: 'PUT', body: new Blob(lista), headers: { 'Content-Type': 'application/octet-stream', 'X-Archivos': encodeURIComponent(JSON.stringify(lista.map((f) => ({ n: f.name, t: f.size })))), ...extra } }); };

function aviso(titulo, texto, extra) {
  $('msg-titulo').textContent = titulo; $('msg-texto').textContent = texto;
  const b = $('msg-extra'); b.hidden = !extra; if (extra) { b.textContent = extra.texto; b.onclick = () => { $('dlg-msg').close(); extra.accion(); }; }
  $('dlg-msg').showModal();
}
let temporizador;
function toast(texto) { const t = $('toast'); t.textContent = '✅ ' + texto; t.hidden = false; clearTimeout(temporizador); temporizador = setTimeout(() => (t.hidden = true), 6000); }
const limpiarErrores = (raiz) => raiz.querySelectorAll('.campo-error').forEach((e) => (e.textContent = ''));
const celdaMonto = (p) => soles(p.total ?? p.monto) + (p.mora > 0 ? `<span class="mora">incl. mora ${soles(p.mora)}</span>` : '');
const detalleHtml = (p) => (p.detalle || []).map(([k, v]) => [k, esc(v)]);
const cuenta = (n) => `<span class="cuenta" data-valor="${Number(n)}">${soles(n)}</span>`;   // monto que «sube» desde 0 al abrirse (animarContadores)
const sinMovimiento = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function animarContadores(raiz = document) {
  raiz.querySelectorAll('.cuenta[data-valor]').forEach((el) => {
    const fin = Number(el.dataset.valor); if (sinMovimiento || !Number.isFinite(fin)) return;
    const ms = Math.min(1100, 500 + Math.log10(Math.abs(fin) + 10) * 120); const t0 = performance.now(); el.textContent = soles(0);
    const paso = (t) => { const k = Math.min(1, (t - t0) / ms); el.textContent = soles(k < 1 ? fin * (1 - Math.pow(1 - k, 3)) : fin); if (k < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  });
}
const dl = (pares) => pares.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
document.querySelectorAll('[data-cerrar]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); b.closest('dialog').close(); }));
$('msg-ok').onclick = () => $('dlg-msg').close();
const tamanoTxt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
function validarArchivos(fs) {
  const l = [...fs];
  if (!l.length) return 'Debes adjuntar la evidencia del pago.';
  if (l.length > MAX_ARCHIVOS) return `Puedes subir como máximo ${MAX_ARCHIVOS} archivos.`;
  for (const f of l) { const e = validarArchivo(f); if (e) return `«${f.name}»: ${e}`; }
  if (l.reduce((t, f) => t + f.size, 0) > MAX_TOTAL) return 'Entre los 3 archivos no pueden superar 15 MB.';
  const vistos = new Set(); for (const f of l) { const k = `${f.name}|${f.size}|${f.lastModified}`; if (vistos.has(k)) return `«${f.name}» está repetido en este envío.`; vistos.add(k); }
  return '';
}
// Archivos elegidos (máximo 3). Cada uno tiene una ✕ para quitarlo y se pueden agregar otros después.
const seleccion = { pagar: [], cambiar: [] };
const clave = (f) => `${f.name}|${f.size}|${f.lastModified}`;
function pintarSeleccion(pre) {
  const l = seleccion[pre];
  $(`${pre}-lista`).innerHTML = l.map((f, i) => `<li><span>${esc(f.name)}</span><span class="arch-der"><small>${tamanoTxt(f.size)}</small><button type="button" class="btn-x" data-quitar="${i}" title="Quitar este archivo" aria-label="Quitar ${esc(f.name)}">✕</button></span></li>`).join('')
    + (l.length > 1 ? `<li class="total"><b>Total (${l.length} de ${MAX_ARCHIVOS})</b><small>${tamanoTxt(l.reduce((t, f) => t + f.size, 0))} de 15 MB</small></li>` : '');
  $(`${pre}-lista`).querySelectorAll('[data-quitar]').forEach((b) => (b.onclick = () => { l.splice(Number(b.dataset.quitar), 1); $(`err-${pre}-archivo`).textContent = ''; ocultarJust(pre); pintarSeleccion(pre); }));
  $(`${pre}-archivo`).disabled = l.length >= MAX_ARCHIVOS;               // con 3 archivos ya no se puede agregar más hasta quitar alguno
}
function limpiarSeleccion(pre) { seleccion[pre] = []; $(`${pre}-archivo`).value = ''; pintarSeleccion(pre); }
function enlazarArchivos(pre) {
  const inp = $(`${pre}-archivo`);
  inp.addEventListener('change', () => {
    const nuevos = [...inp.files]; inp.value = ''; const err = $(`err-${pre}-archivo`); err.textContent = ''; ocultarJust(pre);
    let sobran = 0;
    for (const f of nuevos) {
      if (seleccion[pre].some((x) => clave(x) === clave(f))) continue;                 // ya está en la lista
      if (seleccion[pre].length >= MAX_ARCHIVOS) { sobran++; continue; }
      seleccion[pre].push(f);
    }
    pintarSeleccion(pre);
    if (sobran) err.textContent = `Solo se pueden subir ${MAX_ARCHIVOS} archivos: se agregaron los primeros y se ignoraron ${sobran}. Quita uno con la ✕ para elegir otro.`;
    else { const ea = validarArchivos(seleccion[pre]); if (ea) err.textContent = ea; }
  });
}
const ocultarJust = (pre) => { $(`${pre}-just`).hidden = true; $(`${pre}-just-t`).value = ''; $(`err-${pre}-just`).textContent = ''; };
const mostrarJust = (pre, msg, campo) => { $(`${pre}-just`).hidden = false; $(`${pre}-just-msg`).textContent = msg; $(`err-${pre}-just`).textContent = campo || ''; $(`${pre}-just-t`).focus(); };
// ¿Falta la justificación? (solo cuando el servidor avisó que hay archivos repetidos)
function falloJust(pre) { if ($(`${pre}-just`).hidden) return false; if ($(`${pre}-just-t`).value.trim().length < 10) { $(`err-${pre}-just`).textContent = 'Escribe al menos 10 caracteres explicando por qué lo vuelves a subir'; return true; } return false; }
const cabJust = (pre) => ($(`${pre}-just`).hidden ? {} : { 'X-Justificacion': encodeURIComponent($(`${pre}-just-t`).value.trim()) });
function validarArchivo(f) {
  if (!f) return 'Debes adjuntar la evidencia del pago.';
  if (!TIPOS.includes(f.type)) return MSG_FORMATOS;
  if (f.size > MAX_BYTES) return MSG_TAMANO;
  return '';
}

// ---------- HU-01: sesión ----------
function mostrarLogin(mensaje = '') {
  usuario = null; clearInterval(vigilante); $('vista-asist').hidden = true; $('vista-gerente').hidden = true; $('vista-login').hidden = false;
  $('error-login').textContent = mensaje; document.querySelectorAll('dialog[open]').forEach((d) => d.close());
}
// Sesión única: se consulta cada 15 s (y al volver a la pestaña) para cerrar la sesión si se inició en otro dispositivo
let vigilante;
function vigilarSesion() { clearInterval(vigilante); vigilante = setInterval(() => { if (usuario) api('/api/yo').catch(() => {}); }, 15000); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && usuario) api('/api/yo').catch(() => {}); });

async function iniciar(recienIngresado = false, yaAutenticado = null) {
  try { usuario = yaAutenticado || await api('/api/yo'); } catch { return mostrarLogin(); }
  $('vista-login').hidden = true; vigilarSesion();
  if (usuario.rol === 'GERENTE') {                       // HU-02: pantalla principal del gerente
    $('vista-gerente').hidden = false; $('vista-asist').hidden = true;
    $('g-usuario').textContent = usuario.nombre; $('g-avatar').textContent = usuario.nombre[0].toUpperCase();
    return cargarPanel();
  }
  $('vista-asist').hidden = false; $('vista-gerente').hidden = true;   // HU-04: pantalla principal del asistente
  $('usuario').textContent = `${usuario.nombre} (asistente)`;
  cambiarVista('mes'); mes = null;
  const [, , datosVencer] = await Promise.all([
    cargarMes(),
    api('/api/pagos/categorias').then((c) => { categoriasLista = c; $('sel-cat').innerHTML = '<option value="">Selecciona…</option>' + c.map((x) => `<option value="${x.id}">${x.nombre}</option>`).join(''); }).catch(() => {}),
    cargarVencer(),
  ]);
  if (recienIngresado) avisoAlIngresar(datosVencer);
}

const inputUsuario = $('form-login').usuario;
let tErrUsuario;
const avisoEspacios = () => { $('err-usuario').textContent = 'El usuario no puede contener espacios en blanco'; clearTimeout(tErrUsuario); tErrUsuario = setTimeout(() => ($('err-usuario').textContent = ''), 3000); };
inputUsuario.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); avisoEspacios(); } });
inputUsuario.addEventListener('input', () => { if (/\s/.test(inputUsuario.value)) { inputUsuario.value = inputUsuario.value.replace(/\s/g, ''); avisoEspacios(); } });

$('form-login').onsubmit = async (e) => {
  e.preventDefault(); limpiarErrores(e.target); $('error-login').textContent = '';
  const f = e.target; const u = f.usuario.value; const c = f.clave.value;
  if (!u.trim() && !c) { $('error-login').textContent = 'Ingrese usuario y contraseña'; return; }
  if (!u.trim()) { $('err-usuario').textContent = 'Ingrese usuario'; return; }
  if (/\s/.test(u)) { $('err-usuario').textContent = 'El usuario no puede contener espacios en blanco'; return; }
  if (!c) { $('err-clave').textContent = 'Ingrese contraseña'; return; }
  const boton = f.querySelector('button'); boton.disabled = true; boton.textContent = 'INGRESANDO…';
  try {
    const u2 = await enviarJson('/api/login', 'POST', { usuario: u, clave: c });
    f.reset(); await iniciar(true, u2);
  } catch (err) {
    if (err.status === 401) $('error-login').textContent = 'Las credenciales no son válidas.';
    else if (err.status === 400) { $('error-login').textContent = err.message; if (err.campos) { $('err-usuario').textContent = err.campos.usuario || ''; $('err-clave').textContent = err.campos.clave || ''; } }
    else $('error-login').textContent = 'No fue posible iniciar sesión.';
  } finally { boton.disabled = false; boton.textContent = 'ACCESO'; }
};
const cerrarSesion = async () => { try { await enviarJson('/api/logout', 'POST', {}); } catch { /* igual se cierra */ } mostrarLogin(); };
$('btn-salir').onclick = cerrarSesion; $('g-salir').onclick = cerrarSesion;

// =====================================================================
// GERENTE — HU-02 panel de monitoreo
// =====================================================================
function tarjetaKpi(clase, icono, titulo, n, monto) {
  return `<div class="g-kpi ${clase}"><div class="g-kpi-ic">${icono}</div><div><small>${titulo}</small><b>${cuenta(monto)}</b><span>${n} ${n === 1 ? 'pago' : 'pagos'}</span></div></div>`;
}
// Estado visible de un pago: Pendiente, Pagado, Atrasado o Congelado (y, si es Pendiente y está cerca, cuántos días faltan)
function chipEstado(p) {
  const e = p.estado_visible || (p.estado === 'PAGADO' ? 'PAGADO' : p.alerta === 'ATRASADO' ? 'ATRASADO' : 'PENDIENTE');
  if (e === 'PAGADO') return '<span class="etq PAGADO">Pagado</span>';
  if (e === 'CONGELADO') return '<span class="etq CONGELADO">Congelado</span>';
  if (e === 'ATRASADO') return `<span class="etq ATRASADO">Atrasado · ${-p.dias} ${-p.dias === 1 ? 'día' : 'días'}</span>`;
  return '<span class="etq PENDIENTE">Pendiente</span>' + (p.alerta === 'POR_VENCER' ? ` <span class="etq POR_VENCER">${p.dias === 0 ? 'Vence hoy' : p.dias === 1 ? 'Falta 1 día' : `Faltan ${p.dias} días`}</span>` : '');
}
const etqSituacion = chipEstado;
const claseFila = (p) => (p.estado_visible === 'CONGELADO' ? 'fila-congelada' : p.alerta === 'ATRASADO' ? 'fila-atrasada' : '');
const btnCong = (p) => (p.estado === 'PENDIENTE' ? `<button class="btn btn-hielo btn-sm" data-cong="${p.id}">${p.congelado ? 'Descongelar' : '❄ Congelar'}</button>` : '');
const motivoCong = (p) => (p.congelado && p.motivo_congelado ? `<span class="motivo">${esc(p.motivo_congelado)}</span>` : '');

let panelDatos = null;
async function cargarPanel() {
  $('g-error').hidden = true;
  let d;
  try { d = await api('/api/panel'); }
  catch (e) { if (e.sesion) return; $('g-contenido').hidden = true; $('g-error').hidden = false; $('g-error').textContent = 'No fue posible cargar el panel.'; return; }
  $('g-contenido').hidden = false;
  const hh = new Date().toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  $('g-sub').textContent = `${nombreMes(d.mes)} · datos al ${fmtFecha(d.hoy)} ${hh}`;
  const r = d.resumen;
  $('g-resumen').innerHTML = tarjetaKpi('solido', '✔', 'Pagados', r.pagados.n, r.pagados.monto) + tarjetaKpi('', '⏳', 'Pendientes', r.pendientes.n, r.pendientes.monto)
    + tarjetaKpi('', '⚠', 'Atrasados', r.atrasados.n, r.atrasados.monto) + tarjetaKpi('hielo', '❄', 'Congelados', r.congelados.n, r.congelados.monto) + tarjetaKpi('', '◷', 'Pagos de hoy', d.hoy_lista.length, d.hoy_lista.reduce((s, p) => s + p.monto, 0));
  animarContadores($('g-resumen')); panelDatos = d;
  $('g-vacio').hidden = d.hay_pagos;                        // «no hay pagos registrados para este mes»

  // Tablas
  const tabla = (idf, idv, filas, html) => { $(idf).innerHTML = filas.map(html).join(''); $(idv).hidden = filas.length > 0; };
  tabla('g-hoy-f', 'g-hoy-v', d.hoy_lista, (p) => `<tr class="${claseFila(p)}"><td class="cod">${p.codigo}</td><td><b>${esc(p.concepto)}</b></td><td>${esc(p.entidad)}</td><td class="monto">${celdaMonto(p)}</td><td>${chipEstado(p)}${motivoCong(p)}</td><td><div class="acc-col">${btnCong(p)}${btnVer(p.id)}</div></td></tr>`);
  tabla('g-pagado-f', 'g-pagado-v', d.pagados, (p) => `<tr><td class="cod">${p.codigo}</td><td><b>${esc(p.concepto)}</b></td><td>${esc(p.entidad)}</td><td><span class="cat">${esc(p.categoria)}</span></td><td class="monto">${celdaMonto(p)}</td><td>${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}</td><td>${esc(p.metodo_texto || '—')}</td><td><div class="acc-col"><button class="btn btn-claro btn-sm" data-evid="${p.id}">Ver evidencia</button>${btnVer(p.id)}</div></td></tr>`);
  const filaPend = (p) => `<tr class="${claseFila(p)}"><td class="cod">${p.codigo}</td><td><b>${esc(p.concepto)}</b></td><td>${esc(p.entidad)}</td><td class="monto">${celdaMonto(p)}</td><td>${fmtFecha(p.fecha_vencimiento)}</td><td>${chipEstado(p)}${motivoCong(p)}</td><td><div class="acc-col">${btnCong(p)}${btnVer(p.id)}</div></td></tr>`;
  tabla('g-pend-f', 'g-pend-v', d.pendientes.filter((p) => !p.congelado), filaPend);
  tabla('g-cong-f', 'g-cong-v', d.pendientes.filter((p) => p.congelado), filaPend);
  tabla('g-cambios-f', 'g-cambios-v', d.cambios, (c) => `<tr><td class="cod">${c.codigo}</td><td><b>${esc(c.concepto)}</b><br><small>${esc(c.entidad)}</small></td><td>Intento ${c.numero_intento}</td><td>${esc(c.fecha_hora)}</td><td><button class="btn btn-claro btn-sm" data-evid="${c.pago_id}">Ver evidencia</button></td></tr>`);
  document.querySelectorAll('[data-evid]').forEach((b) => (b.onclick = () => abrirEvidencia(b.dataset.evid)));
  document.querySelectorAll('#vista-gerente [data-cong]').forEach((b) => (b.onclick = () => abrirCongelar([...d.hoy_lista, ...d.pendientes].find((x) => String(x.id) === b.dataset.cong))));
  document.querySelectorAll('#vista-gerente [data-ver]').forEach((b) => (b.onclick = () => abrirDetalle(b.dataset.ver)));
}
$('g-actualizar').onclick = async () => { const b = $('g-actualizar'); b.disabled = true; await cargarPanel(); b.disabled = false; };
document.querySelectorAll('.lateral-nav a').forEach((a) => a.addEventListener('click', () => { document.querySelectorAll('.lateral-nav a').forEach((x) => x.classList.toggle('activo', x === a)); }));

// ---------- Ver detalles de un pago (gerente y asistente) ----------
const estadoCuota = chipEstado;
async function abrirDetalle(id) {
  let d;
  try { d = await api(`/api/pagos/${id}/detalle`); }
  catch (e) { if (e.sesion) return; return aviso('Detalles del pago', 'No fue posible cargar los detalles del pago.'); }
  const p = d.pago; const pagado = p.estado === 'PAGADO';
  $('det-datos').innerHTML = dl([
    ['ID', p.codigo], ['Estado', estadoCuota(p)], ['Concepto', esc(p.concepto)], ['Entidad', esc(p.entidad)], ['Categoría', esc(p.categoria)], ...detalleHtml(p),
    ...(p.congelado ? [['Congelado desde', esc(p.congelado_en || '—')], ['Motivo del congelamiento', p.motivo_congelado ? esc(p.motivo_congelado) : '—']] : []),
    ['Monto', cuenta(p.monto)], ...(p.mora > 0 ? [[pagado ? 'Mora pagada' : 'Mora por atraso', cuenta(p.mora)], [pagado ? 'Total pagado' : 'Total a pagar', cuenta(p.total)]] : []),
    ['Vencimiento', fmtFecha(p.fecha_vencimiento)], ['Registrado el', esc(p.registrado_en)],
    ...(pagado ? [['Fecha y hora de pago', `${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}`], ['Método de pago', esc(p.metodo_texto || '—')], ['Pagado por', esc(p.pagado_por_nombre || '—')],
      ['Comentario', p.comentario ? esc(p.comentario) : '—'], ['Evidencia', esc(p.evidencia_nombre || '—')], ['Cambios de evidencia', `${p.intentos_usados} de 3`]] : [])]);
  const pre = d.prestamo; $('det-prestamo').hidden = !pre;
  if (pre) {
    const r = pre.resumen;
    $('det-pre-datos').innerHTML = dl([['Entidad bancaria', esc(pre.entidad)], ['Monto total', cuenta(pre.monto_total)], ['Número de cuotas', String(pre.num_cuotas)], ['Mora (TNA, base 360 días)', `${pre.mora_tna} %`],
      ['Primera cuota', fmtFecha(pre.fecha_primera_cuota)], ['Vence el préstamo', fmtFecha(pre.fecha_vencimiento_total)],
      ['Avance', `${r.pagadas} pagadas · ${r.pendientes} pendientes${r.atrasadas ? ` (${r.atrasadas} atrasadas)` : ''}`], ['Total pagado', cuenta(r.total_pagado)], ['Saldo por pagar', cuenta(r.saldo)]]);
    $('det-cuotas').innerHTML = d.cuotas.map((c) => `<tr class="${c.actual ? 'cuota-actual' : ''}"><td>${c.numero_cuota} de ${pre.num_cuotas}${c.actual ? ' ◀' : ''}</td><td class="cod">${c.codigo}</td><td>${fmtFecha(c.fecha_vencimiento)}</td>
      <td class="der">${cuenta(c.monto)}</td><td class="der">${c.mora > 0 ? cuenta(c.mora) : '—'}</td><td class="der">${cuenta(c.total)}</td><td>${estadoCuota(c)}</td><td>${c.estado === 'PAGADO' ? `${fmtFecha(c.fecha_pago)} ${esc(c.hora_pago || '')}<br><small>${esc(c.metodo_texto || '')}</small>` : '—'}</td></tr>`).join('');
  }
  const ev = $('det-evid'); ev.hidden = !(usuario && usuario.rol === 'GERENTE' && pagado);
  ev.onclick = () => { $('dlg-detalle').close(); abrirEvidencia(p.id); };
  const cg = $('det-cong'); cg.hidden = !(usuario && usuario.rol === 'GERENTE' && p.estado === 'PENDIENTE'); cg.textContent = p.congelado ? 'Descongelar' : '❄ Congelar';
  cg.onclick = () => abrirCongelar(p);
  $('dlg-detalle').showModal(); animarContadores($('dlg-detalle'));
}
$('det-cerrar').onclick = () => $('dlg-detalle').close();

// ---------- Congelar / descongelar un pago (solo gerente) ----------
let congPago = null;
function abrirCongelar(p) {
  congPago = p; const des = !!p.congelado;
  $('cong-titulo').textContent = des ? 'Descongelar pago' : 'Congelar pago';
  $('cong-datos').innerHTML = dl([['ID', p.codigo], ['Concepto', esc(p.concepto)], ['Entidad', esc(p.entidad)], ['Categoría', esc(p.categoria)], ['Monto', cuenta(p.total ?? p.monto)], ['Vencimiento', fmtFecha(p.fecha_vencimiento)], ['Estado actual', chipEstado(p)], ...(des && p.motivo_congelado ? [['Motivo', esc(p.motivo_congelado)]] : [])]);
  $('cong-motivo-lab').hidden = des; $('cong-motivo').value = ''; $('cong-error').textContent = '';
  $('cong-nota').textContent = des ? 'Al descongelarlo, el pago vuelve a Pendiente (o Atrasado si ya venció) y el asistente podrá registrarlo como realizado.'
    : 'Un pago congelado no puede registrarse como realizado, no se marca como atrasado ni genera mora, y deja de aparecer en «Por vencer» del asistente hasta que lo descongeles.';
  $('cong-confirmar').textContent = des ? 'Descongelar pago' : 'Congelar pago';
  if ($('dlg-detalle').open) $('dlg-detalle').close();
  $('dlg-congelar').showModal(); animarContadores($('cong-datos'));
}
$('cong-confirmar').onclick = async () => {
  const b = $('cong-confirmar'); b.disabled = true; $('cong-error').textContent = ''; const des = !!congPago.congelado;
  try {
    await enviarJson(`/api/pagos/${congPago.id}/${des ? 'descongelar' : 'congelar'}`, 'POST', des ? {} : { motivo: $('cong-motivo').value.trim() });
    $('dlg-congelar').close(); toast(des ? `Pago «${congPago.concepto}» descongelado.` : `Pago «${congPago.concepto}» congelado.`); await cargarPanel();
  } catch (e) { if (!e.sesion) $('cong-error').textContent = e.status && e.status < 500 ? e.message : 'No fue posible completar la operación. El pago conserva su estado.'; }
  finally { b.disabled = false; }
};

// ---------- HU-03: evidencia (solo gerente) ----------
async function abrirEvidencia(pagoId) {
  let d;
  try { d = await api(`/api/pagos/${pagoId}/evidencias`); }
  catch (e) { if (e.sesion) return; return aviso('Evidencia', e.status === 409 ? e.message : 'No fue posible mostrar la evidencia.'); }
  const p = d.pago;
  $('evid-datos').innerHTML = dl([['ID', p.codigo], ['Concepto', esc(p.concepto)], ['Entidad', esc(p.entidad)], ['Categoría', esc(p.categoria)], ...detalleHtml(p), ['Monto', cuenta(p.monto)], ...(p.mora > 0 ? [['Mora pagada', cuenta(p.mora)], ['Total pagado', cuenta(p.total)]] : []), ['Método de pago', esc(p.metodo_texto || '—')], ['Fecha y hora de pago', `${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}`], ['Comentario del pago', p.comentario ? esc(p.comentario) : '—']]);
  const mostrar = (a, etiqueta) => {
    const url = `/api/evidencias/${a.id}`;
    $('evid-cuerpo').innerHTML = `<p class="evid-etq">${etiqueta}: ${esc(a.nombre)}</p><p class="evid-com">Comentario: ${a.comentario ? esc(a.comentario) : '—'}</p>` + (a.justificacion ? `<p class="evid-just">⚠ Archivo repetido. Justificación: ${esc(a.justificacion)}</p>` : '') + (a.tipo === 'application/pdf' ? `<iframe src="${url}" title="Evidencia"></iframe>` : `<img src="${url}" alt="Evidencia del pago">`);
    $('evid-descargar').href = url + '?descargar=1'; $('evid-descargar').hidden = false;
  };
  const vig = d.vigentes && d.vigentes.length ? d.vigentes : [d.vigente];
  mostrar(vig[0], vig.length > 1 ? `Evidencia vigente (1 de ${vig.length})` : 'Evidencia vigente');
  const grupos = {}; d.previos.forEach((a) => (grupos[a.numero_intento] = grupos[a.numero_intento] || []).push(a));
  $('evid-previos').innerHTML = (vig.length > 1 ? `<h4>Archivos de la evidencia vigente (${vig.length})</h4><div class="evid-arch">${vig.map((a, i) => `<button class="btn btn-claro btn-sm" data-vig="${a.id}">${i + 1}. ${esc(a.nombre)}</button>`).join('')}</div>` : '')
    + (d.previos.length ? `<h4>Intentos previos (solo lectura)</h4>` + Object.keys(grupos).sort((x, y) => y - x).map((n) => `<p class="evid-lote">Intento ${n} · reemplazado el ${esc(grupos[n][0].reemplazada_en)} · ${grupos[n].length} archivo${grupos[n].length > 1 ? 's' : ''}</p><ul class="previos">${grupos[n].map((a) => `<li><span>${esc(a.nombre)}<br><small>Comentario: ${a.comentario ? esc(a.comentario) : '—'}${a.justificacion ? ` · Justificación: ${esc(a.justificacion)}` : ''}</small></span>
      <button class="btn btn-claro btn-sm" data-prev="${a.id}">Ver</button> <a class="btn btn-claro btn-sm" href="/api/evidencias/${a.id}?descargar=1">Descargar</a></li>`).join('')}</ul>`).join('') : '');
  $('evid-previos').querySelectorAll('[data-prev]').forEach((b) => (b.onclick = () => mostrar(d.previos.find((x) => String(x.id) === b.dataset.prev), 'Intento previo')));
  $('evid-previos').querySelectorAll('[data-vig]').forEach((b) => (b.onclick = () => mostrar(vig.find((x) => String(x.id) === b.dataset.vig), 'Evidencia vigente')));
  $('dlg-evid').showModal(); animarContadores($('evid-datos'));
}
$('evid-cerrar').onclick = () => { $('dlg-evid').close(); $('evid-cuerpo').innerHTML = ''; };

// =====================================================================
// ASISTENTE
// =====================================================================
function cambiarVista(v) {
  $('vista-mes').hidden = v !== 'mes'; $('vista-vencer').hidden = v !== 'vencer';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('activa', t.dataset.vista === v));
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = async () => { cambiarVista(t.dataset.vista); if (t.dataset.vista === 'vencer') await cargarVencer(); }));

const etiquetaEstado = (p) => chipEstado(p) + motivoCong(p);
const btnVer = (id) => `<button class="btn btn-claro btn-sm" data-ver="${id}">Ver detalles</button>`;
function botonesPago(p) {
  if (p.congelado) return `<div class="acc-col"><span class="nota-cong">❄ Congelado por el gerente</span>${btnVer(p.id)}</div>`;
  if (p.estado === 'PENDIENTE') return `<div class="acc-col"><button class="btn btn-primario btn-sm" data-pagar="${p.id}">Registrar pago</button>${btnVer(p.id)}</div>`;
  return `<div class="acc-col"><button class="btn btn-claro btn-sm" data-cambiar="${p.id}">Cambiar evidencia</button><small>Cambios: ${p.intentos_usados}/3</small>${btnVer(p.id)}</div>`;
}

// ---------- HU-04: pagos del mes (lista y calendario) ----------
async function cargarMes() {
  let d;
  try { d = await api('/api/pagos' + (mes ? `?mes=${mes}` : '')); }
  catch (e) { if (e.sesion) return; $('filas').innerHTML = ''; $('m-vista-cal').innerHTML = ''; $('resumen').innerHTML = ''; return vacioMes('No fue posible obtener los pagos del mes.', true); }
  mes = d.mes; pagosMes = d.pagos;
  $('mes-titulo').textContent = nombreMes(mes);
  const r = d.resumen;
  $('resumen').innerHTML = `
    <div class="kpi azul"><div class="kpi-icono">💼</div><div><small>Total del mes</small><b>${cuenta(r.total_mes)}</b></div></div>
    <div class="kpi verde"><div class="kpi-icono">✅</div><div><small>Ya pagado</small><b>${cuenta(r.pagado_mes)}</b></div></div>
    <div class="kpi ambar"><div class="kpi-icono">⏳</div><div><small>Falta pagar (${r.n_pendientes})</small><b>${cuenta(r.pendiente_total)}</b></div></div>`;
  animarContadores($('resumen'));
  if (!d.pagos.length) vacioMes('No hay pagos registrados para este mes.', false); else $('vacio-mes').hidden = true;
  $('m-vista-lista').hidden = vistaMes !== 'lista' || !d.pagos.length; $('m-vista-cal').hidden = vistaMes !== 'cal' || !d.pagos.length;
  $('filas').innerHTML = d.pagos.map((p) => `<tr class="${claseFila(p)}">
    <td class="cod">${p.codigo}</td><td><b>${esc(p.concepto)}</b><br><small>${esc(p.entidad)}</small></td><td><span class="cat">${esc(p.categoria)}</span></td><td class="monto">${celdaMonto(p)}</td>
    <td>${fmtFecha(p.fecha_vencimiento)}</td><td>${etiquetaEstado(p)}</td><td>${p.estado === 'PAGADO' ? `${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}<br><small>${esc(p.metodo_texto || '')}</small>` : '—'}</td><td class="acciones">${botonesPago(p)}</td></tr>`).join('');
  pintarCalendario(d);
  enlazarAcciones(document.getElementById('vista-mes'));
}
function vacioMes(txt, esError) { const v = $('vacio-mes'); v.hidden = false; v.textContent = txt; v.className = 'vacio' + (esError ? ' error' : ''); $('m-vista-lista').hidden = true; $('m-vista-cal').hidden = true; }

function pintarCalendario(d) {
  const [y, m] = d.mes.split('-').map(Number); const dias = new Date(y, m, 0).getDate(); const inicio = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const porDia = {}; d.pagos.filter((p) => p.fecha_vencimiento.slice(0, 7) === d.mes).forEach((p) => (porDia[Number(p.fecha_vencimiento.slice(8))] ||= []).push(p));
  const previos = d.pagos.filter((p) => p.fecha_vencimiento.slice(0, 7) < d.mes);   // atrasados de meses anteriores
  let celdas = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((t) => `<div class="cal-cab">${t}</div>`).join('') + '<div class="cal-vacio"></div>'.repeat(inicio);
  for (let n = 1; n <= dias; n++) {
    const f = `${d.mes}-${String(n).padStart(2, '0')}`;
    celdas += `<div class="cal-dia${f === d.hoy ? ' hoy' : ''}"><span class="cal-n">${n}</span>${(porDia[n] || []).map((p) => `<button class="cal-pago ${p.estado === 'PAGADO' ? 'ok' : p.congelado ? 'cong' : p.alerta === 'ATRASADO' ? 'atr' : 'pen'}" data-detalle="${p.id}" title="${esc(p.concepto)} · ${esc(p.entidad)} · ${soles(p.monto)}">${esc(p.concepto)}</button>`).join('')}</div>`;
  }
  $('m-vista-cal').innerHTML = (previos.length ? `<div class="cal-previos"><b>Atrasados de meses anteriores:</b> ${previos.map((p) => `<button class="cal-pago atr" data-detalle="${p.id}">${esc(p.concepto)} (${fmtFecha(p.fecha_vencimiento)})</button>`).join('')}</div>` : '') + `<div class="cal">${celdas}</div>`;
  $('m-vista-cal').querySelectorAll('[data-detalle]').forEach((b) => (b.onclick = () => {
    const p = pagosMes.find((x) => String(x.id) === b.dataset.detalle);
    aviso(`${p.codigo} · ${p.concepto}`, `Entidad: ${p.entidad}\nCategoría: ${p.categoria}\n${(p.detalle || []).map(([k, v]) => `${k}: ${v}\n`).join('')}Monto: ${soles(p.monto)}\n${p.mora > 0 ? `Mora: ${soles(p.mora)} (total ${soles(p.total)})\n` : ''}${p.metodo_texto ? `Método de pago: ${p.metodo_texto}\n` : ''}Vencimiento: ${fmtFecha(p.fecha_vencimiento)}\nEstado: ${p.estado === 'PAGADO' ? `Pagado el ${fmtFecha(p.fecha_pago)} ${p.hora_pago || ''}` : p.congelado ? 'Congelado por el gerente' : p.alerta === 'ATRASADO' ? 'Atrasado' : 'Pendiente'}`,
      p.estado === 'PENDIENTE' && !p.congelado ? { texto: 'Registrar pago', accion: () => abrirPagar(p) } : null);
  }));
}
$('m-lista').onclick = () => { vistaMes = 'lista'; $('m-lista').classList.add('activo'); $('m-cal').classList.remove('activo'); cargarMes(); };
$('m-cal').onclick = () => { vistaMes = 'cal'; $('m-cal').classList.add('activo'); $('m-lista').classList.remove('activo'); cargarMes(); };
const moverMes = (n) => { const [y, m] = mes.split('-').map(Number); const dt = new Date(y, m - 1 + n, 1); mes = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; return cargarMes(); };
$('mes-ant').onclick = () => moverMes(-1); $('mes-sig').onclick = () => moverMes(1);

// ---------- HU-08: por vencer ----------
async function cargarVencer() {
  let d;
  try { d = await api('/api/pagos/por-vencer'); }
  catch (e) { if (e.sesion) return null; $('filas-vencer').innerHTML = ''; $('vacio-vencer').hidden = false; $('vacio-vencer').className = 'vacio error'; $('vacio-vencer').textContent = 'No fue posible obtener los pagos por vencer.'; return null; }
  pagosVencer = d.pagos; diasVencer = d.dias_por_vencer; $('dias-vencer').textContent = diasVencer;
  $('n-vencer').textContent = d.pagos.length; $('n-vencer').hidden = !d.pagos.length;
  $('vacio-vencer').hidden = d.pagos.length > 0; $('vacio-vencer').className = 'vacio'; $('vacio-vencer').textContent = 'No hay pagos por vencer.';
  $('filas-vencer').innerHTML = d.pagos.map((p) => `<tr class="${claseFila(p)}"><td class="cod">${p.codigo}</td><td><b>${esc(p.concepto)}</b><br><small>${esc(p.entidad)}</small></td><td><span class="cat">${esc(p.categoria)}</span></td>
    <td class="monto">${celdaMonto(p)}</td><td>${fmtFecha(p.fecha_vencimiento)}</td>
    <td>${chipEstado(p)}</td>
    <td class="acciones">${botonesPago(p)}</td></tr>`).join('');
  enlazarAcciones($('vista-vencer'));
  return d;
}

// ---------- HU-09: aviso al iniciar sesión ----------
function avisoAlIngresar(d) {
  if (!d || !d.pagos.length) return;
  const atr = d.pagos.filter((p) => p.alerta === 'ATRASADO').length; const por = d.pagos.length - atr;
  const partes = []; if (por) partes.push(`${por} ${por === 1 ? 'pago por vencer' : 'pagos por vencer'}`); if (atr) partes.push(`${atr} ${atr === 1 ? 'pago atrasado' : 'pagos atrasados'}`);
  aviso('Avisos de pagos', `Tienes ${partes.join(' y ')}.`, { texto: 'Ver pagos por vencer', accion: () => cambiarVista('vencer') });
}

function enlazarAcciones(raiz) {
  raiz.querySelectorAll('[data-pagar]').forEach((b) => (b.onclick = () => abrirPagar(buscarPago(b.dataset.pagar))));
  raiz.querySelectorAll('[data-ver]').forEach((b) => (b.onclick = () => abrirDetalle(b.dataset.ver)));
  raiz.querySelectorAll('[data-cambiar]').forEach((b) => (b.onclick = () => abrirCambiar(buscarPago(b.dataset.cambiar))));
}
const buscarPago = (id) => pagosMes.find((x) => String(x.id) === id) || pagosVencer.find((x) => String(x.id) === id);
async function refrescar() { await Promise.all([cargarMes(), cargarVencer()]); }

// ---------- HU-05: registrar pago por realizar ----------
// La categoría se elige primero y el formulario cambia según ella.
let nuevoDatos = null;
const IMPUESTOS = { SUNAT: ['IGV', 'Impuesto a la renta'], SAT: ['Impuesto predial', 'Impuesto vehicular'] };
const CATS = ['Servicios', 'Proveedores', 'Impuestos', 'Préstamos'];
const catActual = () => (categoriasLista.find((c) => String(c.id) === $('sel-cat').value) || {}).nombre || '';
function mostrarFormulario() {
  const c = catActual();
  CATS.forEach((n) => ($('f-' + n).hidden = n !== c));
  $('f-comun').hidden = !c || c === 'Préstamos';
  $('lab-suministro').hidden = !(c === 'Servicios' && ['Luz', 'Agua'].includes($('n-tipo').value));
}
$('sel-cat').onchange = () => { limpiarErrores($('dlg-nuevo')); $('nuevo-error').textContent = ''; mostrarFormulario(); };
$('n-tipo').onchange = mostrarFormulario;
$('n-ent-imp').onchange = () => {
  const l = IMPUESTOS[$('n-ent-imp').value] || [];
  $('n-imp').innerHTML = l.length ? '<option value="">Selecciona…</option>' + l.map((x) => `<option>${x}</option>`).join('') : '<option value="">Primero elige la entidad</option>';
};
const soloLetras = (e) => { e.target.value = e.target.value.replace(/[^\p{L} ]/gu, '').replace(/ {2,}/g, ' '); };
$('n-ent-serv').addEventListener('input', soloLetras); $('n-ent-pre').addEventListener('input', soloLetras);
$('n-ruc').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
// Ayuda en vivo: cuántas cuotas corresponden entre las dos fechas (1 cuota = 1 mes)
const sumaMeses = (f, n) => { const [y, m, d] = f.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const u = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, u))).toISOString().slice(0, 10); };
function pistaCuotas() {
  const p = $('n-primera').value, t = $('n-venc-total').value, h = $('hint-cuotas');
  h.hidden = !(p && t && t >= p); if (h.hidden) return;
  let n = 1; while (sumaMeses(p, n) <= t) n++;
  h.textContent = `ℹ️ Entre ${fmtFecha(p)} y ${fmtFecha(t)} corresponden ${n} ${n === 1 ? 'cuota' : 'cuotas'} (1 cuota por mes).`;
}
$('n-primera').addEventListener('input', pistaCuotas); $('n-venc-total').addEventListener('input', pistaCuotas);
$('n-cuotas').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
$('n-recibo').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^A-Za-z0-9-]/g, ''); });
$('n-suministro').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 12); });

// «Pago atrasado»: la fecha debe ser anterior a hoy (hasta 1 año atrás); si no, debe ser hoy o posterior (hasta 1 año)
function ajustarFechaVenc() {
  const atr = $('n-atrasado').checked; const hoyL = fechaLima(); const v = $('n-venc'); $('hint-atrasado').hidden = !atr;
  const lim = new Date(); lim.setFullYear(lim.getFullYear() + (atr ? -1 : 1));
  if (atr) { v.min = fechaLima(lim); v.max = sumaDias(hoyL, -1); if (v.value && v.value >= hoyL) v.value = ''; }
  else { v.min = hoyL; v.max = fechaLima(lim); if (v.value && v.value < hoyL) v.value = ''; }
}
$('n-atrasado').onchange = ajustarFechaVenc;
$('btn-nuevo').onclick = () => {
  ['n-tipo', 'n-ent-serv', 'n-recibo', 'n-suministro', 'n-ruc', 'n-razon', 'n-ent-imp', 'n-monto', 'n-venc', 'n-ent-pre', 'n-monto-total', 'n-cuotas', 'n-mora', 'n-venc-total', 'n-primera'].forEach((i) => ($(i).value = ''));
  $('n-ent-imp').onchange(); pistaCuotas(); $('sel-cat').value = ''; mostrarFormulario(); limpiarErrores($('dlg-nuevo'));
  const max = new Date(); max.setFullYear(max.getFullYear() + 1);
  $('n-venc').min = $('n-primera').min = fechaLima(); $('n-venc').max = $('n-primera').max = fechaLima(max);
  $('n-atrasado').checked = false; ajustarFechaVenc();
  $('n-venc-total').min = fechaLima(); { const m5 = new Date(); m5.setFullYear(m5.getFullYear() + 10); $('n-venc-total').max = fechaLima(m5); }
  $('nuevo-error').textContent = ''; $('nuevo-error2').textContent = ''; $('nuevo-paso1').hidden = false; $('nuevo-paso2').hidden = true; $('dlg-nuevo').showModal();
};
function leerNuevo() {
  const c = catActual(); const b = { categoria_id: $('sel-cat').value };
  if (c && c !== 'Préstamos') b.atrasado = $('n-atrasado').checked;
  if (c === 'Servicios') Object.assign(b, { tipo_servicio: $('n-tipo').value, entidad: $('n-ent-serv').value, numero_recibo: $('n-recibo').value, ...(['Luz', 'Agua'].includes($('n-tipo').value) ? { codigo_suministro: $('n-suministro').value } : {}), monto: $('n-monto').value, fecha_vencimiento: $('n-venc').value });
  else if (c === 'Proveedores') Object.assign(b, { ruc: $('n-ruc').value, razon_social: $('n-razon').value, monto: $('n-monto').value, fecha_vencimiento: $('n-venc').value });
  else if (c === 'Impuestos') Object.assign(b, { entidad: $('n-ent-imp').value, concepto_impuesto: $('n-imp').value, monto: $('n-monto').value, fecha_vencimiento: $('n-venc').value });
  else if (c === 'Préstamos') Object.assign(b, { entidad: $('n-ent-pre').value, monto_total: $('n-monto-total').value, num_cuotas: $('n-cuotas').value, mora_tna: $('n-mora').value, fecha_vencimiento_total: $('n-venc-total').value, fecha_primera_cuota: $('n-primera').value });
  return b;
}
function resumenNuevo(d, cat) { const f = resumenNuevo0(d, cat); return d.atrasado ? [...f, ['Situación', '<span class="etq ATRASADO">Pago atrasado</span>']] : f; }
function resumenNuevo0(d, cat) {
  const t = (k) => esc((d[k] ?? '').toString().trim());
  if (cat === 'Servicios') return [['Categoría', cat], ['Servicio', t('tipo_servicio')], ['Entidad', t('entidad')], ['N.º de recibo', t('numero_recibo')], ...(d.codigo_suministro ? [['Código de suministro', t('codigo_suministro')]] : []), ['Monto', soles(d.monto)], ['Vencimiento', fmtFecha(d.fecha_vencimiento)]];
  if (cat === 'Proveedores') return [['Categoría', cat], ['RUC', t('ruc')], ['Razón social', t('razon_social')], ['Monto', soles(d.monto)], ['Vencimiento', fmtFecha(d.fecha_vencimiento)]];
  if (cat === 'Impuestos') return [['Categoría', cat], ['Entidad', t('entidad')], ['Impuesto', t('concepto_impuesto')], ['Monto', soles(d.monto)], ['Vencimiento', fmtFecha(d.fecha_vencimiento)]];
  return [['Categoría', cat], ['Entidad bancaria', t('entidad')], ['Monto total', soles(d.monto_total)], ['Número de cuotas', t('num_cuotas')], ['Mora (TNA, base 360 días)', `${Number(d.mora_tna)} %`], ['Vence el préstamo', fmtFecha(d.fecha_vencimiento_total)], ['Primera cuota', fmtFecha(d.fecha_primera_cuota)]];
}
$('nuevo-continuar').onclick = async () => {
  limpiarErrores($('dlg-nuevo')); $('nuevo-error').textContent = '';
  nuevoDatos = leerNuevo();
  try {
    const r = await enviarJson('/api/pagos/verificar', 'POST', nuevoDatos);
    const cat = catActual();
    $('nuevo-resumen').innerHTML = dl(resumenNuevo(nuevoDatos, cat));
    const cu = $('nuevo-cuotas'); cu.hidden = !r.cuotas;
    if (r.cuotas) cu.innerHTML = `<p class="confirma-t">Previsualización de las ${r.cuotas.length} ${r.cuotas.length === 1 ? 'cuota' : 'cuotas'} que se generarán:</p><div class="cuotas-scroll"><table class="cuotas-tabla"><thead><tr><th>Cuota</th><th>Fecha de vencimiento</th><th class="der">Monto</th></tr></thead><tbody>${r.cuotas.map((q) => `<tr><td>${q.numero} de ${r.cuotas.length}</td><td>${fmtFecha(q.fecha)}</td><td class="der">${cuenta(q.monto)}</td></tr>`).join('')}</tbody></table></div>`;
    const dup = $('nuevo-dup'); dup.hidden = !r.duplicado;
    if (r.duplicado) { const x = r.duplicado; dup.innerHTML = `⚠ Este pago podría ser un pago repetido. Ya existe: <b>${esc(x.concepto)}</b> · ${esc(x.entidad)} · ${esc(x.categoria)} · ${soles(x.monto)} · vence ${fmtFecha(x.fecha_vencimiento)} (${x.estado === 'PAGADO' ? 'Pagado' : 'Pendiente'}). Puedes cancelar o confirmar el registro.`; }
    $('nuevo-paso1').hidden = true; $('nuevo-paso2').hidden = false; animarContadores($('nuevo-cuotas'));
  } catch (e) {
    if (e.sesion) return;
    if (e.campos) document.querySelectorAll('#dlg-nuevo [data-err]').forEach((s) => (s.textContent = e.campos[s.dataset.err] || ''));
    $('nuevo-error').textContent = e.campos ? 'Corrige los campos indicados.' : 'No fue posible validar el pago.';
  }
};
$('nuevo-volver').onclick = () => { $('nuevo-paso1').hidden = false; $('nuevo-paso2').hidden = true; };
$('nuevo-confirmar').onclick = async () => {
  const b = $('nuevo-confirmar'); b.disabled = true; $('nuevo-error2').textContent = '';
  try {
    const r = await enviarJson('/api/pagos', 'POST', nuevoDatos);
    $('dlg-nuevo').close(); toast(r.cuotas ? `${r.concepto} registrado: se generaron ${r.cuotas} pagos pendientes.` : `Pago «${r.concepto}» registrado como pendiente.`); await refrescar();
  } catch (e) { if (!e.sesion) $('nuevo-error2').textContent = e.campos ? Object.values(e.campos)[0] : 'No fue posible registrar el pago.'; }
  finally { b.disabled = false; }
};

// ---------- HU-06: registrar pago como realizado ----------
let pagoActual = null;
function datosPago(p) {
  return dl([['ID', p.codigo], ['Concepto', esc(p.concepto)], ['Entidad', esc(p.entidad)], ['Categoría', esc(p.categoria)], ...detalleHtml(p), ['Monto', cuenta(p.monto)],
    ...(p.mora > 0 ? [['Mora por atraso', cuenta(p.mora)], ['Total a pagar', cuenta(p.total)]] : []), ['Vencimiento', fmtFecha(p.fecha_vencimiento)], ['Estado', chipEstado(p)]]);
}
// Método de pago (con qué se pagó). Préstamos: solo transferencia a cuenta bancaria o tarjeta de crédito.
const SUBS = { BILLETERA: ['Billetera', { PLIN: 'Plin', YAPE: 'Yape', AGORA: 'Agora' }], TARJETA: ['Tipo de tarjeta', { CREDITO: 'Crédito', DEBITO: 'Débito' }] };
function armarMetodos(p) {
  const prest = p.categoria === 'Préstamos';
  $('pagar-metodo').innerHTML = '<option value="">Selecciona…</option>' + (prest
    ? '<option value="TRANSFERENCIA">Transferencia (cuenta bancaria de la empresa)</option><option value="TARJETA">Tarjeta de crédito</option>'
    : '<option value="TRANSFERENCIA">Transferencia (cuenta de la empresa)</option><option value="EFECTIVO">Pago en efectivo</option><option value="BILLETERA">Billetera digital (Plin, Yape o Agora de la empresa)</option><option value="TARJETA">Tarjeta bancaria (crédito o débito)</option>');
  $('pagar-sub-lab').hidden = true; $('pagar-sub').innerHTML = '';
}
function cambiarMetodo() {
  const m = $('pagar-metodo').value; const prest = pagoActual && pagoActual.categoria === 'Préstamos';
  const sub = SUBS[m]; const lab = $('pagar-sub-lab');
  lab.hidden = !sub || prest;                                 // en préstamos la tarjeta es siempre de crédito
  if (sub && !prest) { $('pagar-sub-t').textContent = sub[0]; $('pagar-sub').innerHTML = '<option value="">Selecciona…</option>' + Object.entries(sub[1]).map(([k, v]) => `<option value="${k}">${v}</option>`).join(''); }
  $('err-pagar-metodo').textContent = ''; $('err-pagar-sub').textContent = '';
}
$('pagar-metodo').onchange = cambiarMetodo;
function leerMetodo() {
  const metodo = $('pagar-metodo').value; const prest = pagoActual.categoria === 'Préstamos';
  const detalle = prest && metodo === 'TARJETA' ? 'CREDITO' : (SUBS[metodo] ? $('pagar-sub').value : '');
  const texto = { TRANSFERENCIA: 'Transferencia', EFECTIVO: 'Efectivo' }[metodo] || (metodo === 'BILLETERA' ? `Billetera digital (${SUBS.BILLETERA[1][detalle] || ''})` : `Tarjeta de ${(SUBS.TARJETA[1][detalle] || '').toLowerCase()}`);
  return { metodo, detalle, texto };
}
function abrirPagar(p) {
  pagoActual = p; $('pagar-datos').innerHTML = datosPago(p);
  const hoyL = fechaLima(); const f = $('pagar-fecha'); f.value = hoyL; f.max = hoyL; f.min = sumaDias(hoyL, -7); $('pagar-hora').value = horaLima();
  armarMetodos(p); $('pagar-coment').value = ''; limpiarSeleccion('pagar'); ocultarJust('pagar'); limpiarErrores($('dlg-pagar')); $('pagar-error').textContent = '';
  $('pagar-paso1').hidden = false; $('pagar-paso2').hidden = true; $('dlg-pagar').showModal(); animarContadores($('pagar-datos'));
}
$('pagar-continuar').onclick = () => {
  limpiarErrores($('dlg-pagar')); let mal = false;
  const fecha = $('pagar-fecha').value, hora = $('pagar-hora').value, archivo = [...seleccion.pagar];
  if (!fecha) { $('err-pagar-fecha').textContent = 'Indica la fecha de pago'; mal = true; }
  else if (fecha < sumaDias(fechaLima(), -7)) { $('err-pagar-fecha').textContent = 'No puede ser anterior a una semana'; mal = true; }
  if (!hora) { $('err-pagar-hora').textContent = 'Indica la hora de pago'; mal = true; }
  const mp = leerMetodo();
  if (!mp.metodo) { $('err-pagar-metodo').textContent = 'Selecciona el método de pago'; mal = true; }
  else if (SUBS[mp.metodo] && !mp.detalle) { $('err-pagar-sub').textContent = mp.metodo === 'BILLETERA' ? 'Selecciona Plin, Yape o Agora' : 'Selecciona crédito o débito'; mal = true; }
  if (fecha && hora && `${fecha} ${hora}` > `${fechaLima()} ${horaLima()}`) { $('err-pagar-fecha').textContent = 'No puede ser posterior al momento actual'; mal = true; }
  const ea = validarArchivos(archivo); if (ea) { $('err-pagar-archivo').textContent = ea; mal = true; }
  if (!ea && falloJust('pagar')) mal = true;
  if (mal) return;
  $('pagar-resumen').innerHTML = datosPago(pagoActual) + dl([['Método de pago', esc(mp.texto)], ['Fecha y hora de pago', `${fmtFecha(fecha)} ${hora}`], ['Comentario', $('pagar-coment').value.trim() ? esc($('pagar-coment').value.trim()) : '—'], ['Evidencia', archivo.map((f) => esc(f.name)).join('<br>')], ...($('pagar-just').hidden ? [] : [['Justificación', esc($('pagar-just-t').value.trim())]])]);
  $('pagar-paso1').hidden = true; $('pagar-paso2').hidden = false;
};
enlazarArchivos('pagar'); enlazarArchivos('cambiar');
$('pagar-volver').onclick = () => { $('pagar-paso1').hidden = false; $('pagar-paso2').hidden = true; };
$('pagar-confirmar').onclick = async () => {
  const b = $('pagar-confirmar'); b.disabled = true; $('pagar-error').textContent = '';
  const fecha = $('pagar-fecha').value, hora = $('pagar-hora').value, archivo = [...seleccion.pagar];
  try {
    const r = await enviarArchivos(`/api/pagos/${pagoActual.id}/pagar`, archivo, { ...cabJust('pagar'), 'X-Fecha-Pago': fecha, 'X-Hora-Pago': hora, 'X-Metodo-Pago': leerMetodo().metodo, 'X-Metodo-Detalle': leerMetodo().detalle, 'X-Comentario': encodeURIComponent($('pagar-coment').value.trim()) });
    $('dlg-pagar').close();
    aviso('Pago registrado', `El pago «${r.concepto}» se registró como realizado.\nMétodo de pago: ${r.metodo_texto}\n${r.mora > 0 ? `Mora incluida: ${soles(r.mora)} (total ${soles(r.total)})\n` : ''}Fecha y hora: ${fmtFecha(r.fecha_pago)} ${r.hora_pago}\nEvidencia: ${r.archivos.join(', ')}`);
    await refrescar();
  } catch (e) {
    if (e.sesion) return;
    if (e.campos && e.campos.archivo) {            // archivo repetido o inválido: se vuelve al paso 1
      $('pagar-paso1').hidden = false; $('pagar-paso2').hidden = true;
      if (e.requiereJustificacion) { mostrarJust('pagar', e.message, e.campos.justificacion); return; }   // repetido: se acepta con justificación
      limpiarSeleccion('pagar'); ocultarJust('pagar'); $('err-pagar-archivo').textContent = e.campos.archivo; return;
    }
    $('pagar-error').textContent = e.red || !e.status || e.status >= 500 ? 'La operación no se completó. El pago sigue Pendiente y sin evidencia.' : e.message;
  } finally { b.disabled = false; }
};

// ---------- HU-07: cambiar evidencia ----------
function abrirCambiar(p) {
  pagoActual = p; const usados = p.intentos_usados || 0; const rest = 3 - usados;
  $('cambiar-datos').innerHTML = datosPago(p) + dl([['Archivo vigente', esc(p.evidencia_nombre || 'Sin archivo')], ['Intentos usados', `${usados} de 3`], ['Intentos disponibles', String(rest)]]);
  limpiarSeleccion('cambiar'); ocultarJust('cambiar'); $('cambiar-coment').value = ''; limpiarErrores($('dlg-cambiar')); $('cambiar-error').textContent = '';
  $('cambiar-paso1').hidden = false; $('cambiar-paso2').hidden = true;
  if (rest <= 0) return aviso('Cambio de evidencia', 'Se alcanzó el máximo de 3 intentos de cambio de evidencia para este pago.');
  $('dlg-cambiar').showModal(); animarContadores($('cambiar-datos'));
}
$('cambiar-continuar').onclick = () => {
  limpiarErrores($('dlg-cambiar')); const a = [...seleccion.cambiar]; const ea = validarArchivos(a);
  if (ea) { $('err-cambiar-archivo').textContent = ea; return; }
  if (falloJust('cambiar')) return;
  const nombres = a.map((f) => `«${f.name}»`).join(', ');
  $('cambiar-confirma').textContent = (pagoActual.evidencia_nombre ? `Se reemplazará «${pagoActual.evidencia_nombre}» por ${nombres}. Los archivos actuales quedarán como intento previo y este cambio contará como un intento.${$('cambiar-coment').value.trim() ? ` Comentario: «${$('cambiar-coment').value.trim()}».` : ''}${$('cambiar-just').hidden ? '' : ` Justificación: «${$('cambiar-just-t').value.trim()}».`} ¿Confirmas?` : `Se adjuntará ${nombres} como evidencia de este pago.${$('cambiar-just').hidden ? '' : ` Justificación: «${$('cambiar-just-t').value.trim()}».`} ¿Confirmas?`);
  $('cambiar-paso1').hidden = true; $('cambiar-paso2').hidden = false;
};
$('cambiar-volver').onclick = () => { $('cambiar-paso1').hidden = false; $('cambiar-paso2').hidden = true; };
$('cambiar-confirmar').onclick = async () => {
  const b = $('cambiar-confirmar'); b.disabled = true; $('cambiar-error').textContent = '';
  try {
    const r = await enviarArchivos(`/api/pagos/${pagoActual.id}/evidencia`, seleccion.cambiar, { ...cabJust('cambiar'), 'X-Comentario': encodeURIComponent($('cambiar-coment').value.trim()) });
    $('dlg-cambiar').close(); aviso('Evidencia cambiada', `La evidencia se cambió correctamente. Te ${r.intentos_restantes === 1 ? 'queda 1 intento' : `quedan ${r.intentos_restantes} intentos`} de cambio.`); await refrescar();
  } catch (e) {
    if (!e.sesion && e.campos && e.campos.archivo) {
      $('cambiar-paso1').hidden = false; $('cambiar-paso2').hidden = true;
      if (e.requiereJustificacion) { mostrarJust('cambiar', e.message, e.campos.justificacion); return; }
      limpiarSeleccion('cambiar'); ocultarJust('cambiar'); $('err-cambiar-archivo').textContent = e.campos.archivo; return; }
    if (!e.sesion) $('cambiar-error').textContent = e.red || !e.status || e.status >= 500 ? 'La operación no se completó. Se mantiene la evidencia actual.' : e.message; }
  finally { b.disabled = false; }
};

iniciar();
