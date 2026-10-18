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
const TZ = 'America/Lima';
const fechaLima = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const horaLima = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const sumaDias = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nombreMes = (m) => { const [y, mm] = m.split('-').map(Number); const t = new Date(y, mm - 1, 1).toLocaleDateString('es-PE', { month: 'long' }); return `${t[0].toUpperCase()}${t.slice(1)} ${y}`; };

let usuario = null, mes = null, pagosMes = [], pagosVencer = [], vistaMes = 'lista', diasVencer = 3;

// ---------- Utilidades ----------
async function api(url, opciones = {}) {
  let r;
  try { r = await fetch(url, opciones); } catch { throw Object.assign(new Error('Sin conexión'), { red: true }); }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { mostrarLogin(datos.reemplazada ? datos.error : ''); throw Object.assign(new Error('Sesión expirada'), { sesion: true }); }
  if (!r.ok) throw Object.assign(new Error(datos.error || 'Error'), { campos: datos.campos, status: r.status });
  return datos;
}
const enviarJson = (url, metodo, cuerpo) => api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
const enviarArchivo = (url, archivo, extra = {}) => api(url, { method: 'PUT', body: archivo,
  headers: { 'Content-Type': archivo.type || 'application/octet-stream', 'X-Nombre': encodeURIComponent(archivo.name), ...extra } });

function aviso(titulo, texto, extra) {
  $('msg-titulo').textContent = titulo; $('msg-texto').textContent = texto;
  const b = $('msg-extra'); b.hidden = !extra; if (extra) { b.textContent = extra.texto; b.onclick = () => { $('dlg-msg').close(); extra.accion(); }; }
  $('dlg-msg').showModal();
}
let temporizador;
function toast(texto) { const t = $('toast'); t.textContent = '✅ ' + texto; t.hidden = false; clearTimeout(temporizador); temporizador = setTimeout(() => (t.hidden = true), 6000); }
const limpiarErrores = (raiz) => raiz.querySelectorAll('.campo-error').forEach((e) => (e.textContent = ''));
const dl = (pares) => pares.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
document.querySelectorAll('[data-cerrar]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); b.closest('dialog').close(); }));
$('msg-ok').onclick = () => $('dlg-msg').close();
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
    api('/api/pagos/categorias').then((c) => { $('sel-cat').innerHTML = '<option value="">Selecciona…</option>' + c.map((x) => `<option value="${x.id}">${x.nombre}</option>`).join(''); }).catch(() => {}),
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
const COL = { azul: '#3b8cf5', verde: '#12a150', ambar: '#f0a020', rojo: '#d92d4a', morado: '#7b3cf0', cian: '#18b6df' };

function lineaSvg(valores, etiquetas) {
  const W = 560, H = 190, px = 34, py = 18; const max = Math.max(...valores, 1);
  const x = (i) => px + (i * (W - px * 2)) / Math.max(valores.length - 1, 1); const y = (v) => H - py - (v / max) * (H - py * 2);
  const pts = valores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${px},${H - py} ${pts} ${x(valores.length - 1)},${H - py}`;
  const guias = [0, .5, 1].map((f) => `<line x1="${px}" x2="${W - px}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="#e8edf6"/><text x="2" y="${y(max * f) + 4}" font-size="10" fill="#8b95ad">${Math.round(max * f)}</text>`).join('');
  const marcas = etiquetas.map((t, i) => (i % 5 === 0 || i === etiquetas.length - 1 ? `<text x="${x(i)}" y="${H - 2}" font-size="10" text-anchor="middle" fill="#8b95ad">${t}</text>` : '')).join('');
  const puntos = valores.map((v, i) => (v ? `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#fff" stroke="${COL.azul}" stroke-width="2"><title>Día ${etiquetas[i]}: ${soles(v)}</title></circle>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svg-grafico" role="img" aria-label="Lo pagado por día">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COL.azul}" stop-opacity=".35"/><stop offset="1" stop-color="${COL.azul}" stop-opacity="0"/></linearGradient></defs>
    ${guias}<polygon points="${area}" fill="url(#lg)"/><polyline points="${pts}" fill="none" stroke="${COL.azul}" stroke-width="3" stroke-linejoin="round"/>${puntos}${marcas}</svg>`;
}
function donaSvg(partes) {
  const total = partes.reduce((s, p) => s + p.v, 0); const R = 52, C = 2 * Math.PI * R; let acc = 0;
  const arcos = total ? partes.map((p) => { const l = (p.v / total) * C; const a = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.c}" stroke-width="22" stroke-dasharray="${l} ${C - l}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"><title>${p.n}: ${soles(p.v)}</title></circle>`; acc += l; return a; }).join('')
    : `<circle r="${R}" cx="70" cy="70" fill="none" stroke="#e8edf6" stroke-width="22"/>`;
  const leyenda = partes.map((p) => `<li><i style="background:${p.c}"></i>${p.n}<b>${soles(p.v)}</b></li>`).join('');
  return `<div class="dona"><svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Distribución por monto">${arcos}<text x="70" y="75" text-anchor="middle" font-size="13" font-weight="800" fill="#1c2540">${soles(total).replace('S/ ', '')}</text></svg><ul>${leyenda}</ul></div>`;
}
function anilloSvg(pct, color, titulo) {
  const R = 38, C = 2 * Math.PI * R, l = (Math.min(pct, 100) / 100) * C;
  return `<div class="anillo"><svg viewBox="0 0 100 100" width="104" height="104"><circle r="${R}" cx="50" cy="50" fill="none" stroke="#e8edf6" stroke-width="10"/><circle r="${R}" cx="50" cy="50" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${l} ${C}" transform="rotate(-90 50 50)"/><text x="50" y="56" text-anchor="middle" font-size="18" font-weight="800" fill="#1c2540">${pct}%</text></svg><small>${titulo}</small></div>`;
}
function tarjetaKpi(clase, icono, titulo, n, monto) {
  return `<div class="g-kpi ${clase}"><div class="g-kpi-ic">${icono}</div><div><small>${titulo}</small><b>${soles(monto)}</b><span>${n} ${n === 1 ? 'pago' : 'pagos'}</span></div></div>`;
}
const etqSituacion = (p) => (p.alerta === 'ATRASADO' ? `<span class="etq ATRASADO">Atrasado · ${-p.dias} d</span>` : p.alerta === 'POR_VENCER' ? `<span class="etq POR_VENCER">Por vencer</span>` : '<span class="etq PENDIENTE">Pendiente</span>');

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
    + tarjetaKpi('', '⚠', 'Atrasados', r.atrasados.n, r.atrasados.monto) + tarjetaKpi('', '◷', 'Pagos de hoy', d.hoy_lista.length, d.hoy_lista.reduce((s, p) => s + p.monto, 0));
  $('g-vacio').hidden = d.hay_pagos;                        // «no hay pagos registrados para este mes»
  document.querySelectorAll('.g-fila').forEach((x) => (x.hidden = !d.hay_pagos));

  // Gráficos
  const diasMes = Number(d.hoy.slice(8)); const porDia = Array(diasMes).fill(0);
  d.pagados.forEach((p) => { if (p.fecha_pago.slice(0, 7) === d.mes) porDia[Number(p.fecha_pago.slice(8)) - 1] += p.monto; });
  $('g-linea').innerHTML = lineaSvg(porDia, porDia.map((_, i) => String(i + 1)));
  $('g-dona').innerHTML = donaSvg([{ n: 'Pagado', v: r.pagados.monto, c: COL.verde }, { n: 'Pendiente', v: r.pendientes.monto, c: COL.azul }, { n: 'Atrasado', v: r.atrasados.monto, c: COL.rojo }]);
  const cats = {}; [...d.pagados, ...d.pendientes].forEach((p) => (cats[p.categoria] = (cats[p.categoria] || 0) + p.monto));
  const maxC = Math.max(...Object.values(cats), 1); const colores = [COL.azul, COL.cian, COL.morado, COL.ambar];
  $('g-barras').innerHTML = Object.entries(cats).map(([k, v], i) => `<div class="hbar"><span>${esc(k)}</span><div><i style="width:${(v / maxC) * 100}%;background:${colores[i % 4]}"></i></div><b>${soles(v)}</b></div>`).join('') || '<p class="vacio">Sin datos</p>';
  const totalN = r.pagados.n + r.pendientes.n + r.atrasados.n;
  $('g-anillos').innerHTML = anilloSvg(totalN ? Math.round((r.pagados.n / totalN) * 100) : 0, COL.verde, 'Pagados')
    + anilloSvg(totalN ? Math.round((r.pendientes.n / totalN) * 100) : 0, COL.azul, 'Pendientes') + anilloSvg(totalN ? Math.round((r.atrasados.n / totalN) * 100) : 0, COL.rojo, 'Atrasados');
  $('g-bloques').innerHTML = `<div class="bloque b1"><small>Pagos de hoy</small><b>${d.hoy_lista.length}</b></div><div class="bloque b2"><small>Atrasados</small><b>${r.atrasados.n}</b></div>
    <div class="bloque b3"><small>Cambios de evidencia</small><b>${d.cambios.length}</b></div><div class="bloque b4"><small>Pagados este mes</small><b>${r.pagados.n}</b></div>`;

  // Tablas
  const tabla = (idf, idv, filas, html) => { $(idf).innerHTML = filas.map(html).join(''); $(idv).hidden = filas.length > 0; };
  tabla('g-hoy-f', 'g-hoy-v', d.hoy_lista, (p) => `<tr><td><b>${esc(p.concepto)}</b></td><td>${esc(p.entidad)}</td><td class="monto">${soles(p.monto)}</td><td>${p.estado === 'PAGADO' ? '<span class="etq PAGADO">Pagado</span>' : etqSituacion(p)}</td></tr>`);
  tabla('g-pagado-f', 'g-pagado-v', d.pagados, (p) => `<tr><td><b>${esc(p.concepto)}</b></td><td>${esc(p.entidad)}</td><td><span class="cat">${esc(p.categoria)}</span></td><td class="monto">${soles(p.monto)}</td><td>${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}</td><td><button class="btn btn-claro btn-sm" data-evid="${p.id}">Ver evidencia</button></td></tr>`);
  tabla('g-pend-f', 'g-pend-v', d.pendientes, (p) => `<tr class="${p.alerta === 'ATRASADO' ? 'fila-atrasada' : ''}"><td><b>${esc(p.concepto)}</b></td><td>${esc(p.entidad)}</td><td class="monto">${soles(p.monto)}</td><td>${fmtFecha(p.fecha_vencimiento)}</td><td>${etqSituacion(p)}</td></tr>`);
  tabla('g-cambios-f', 'g-cambios-v', d.cambios, (c) => `<tr><td><b>${esc(c.concepto)}</b><br><small>${esc(c.entidad)}</small></td><td>Intento ${c.numero_intento}</td><td>${esc(c.fecha_hora)}</td><td><button class="btn btn-claro btn-sm" data-evid="${c.pago_id}">Ver evidencia</button></td></tr>`);
  document.querySelectorAll('[data-evid]').forEach((b) => (b.onclick = () => abrirEvidencia(b.dataset.evid)));
}
$('g-actualizar').onclick = async () => { const b = $('g-actualizar'); b.disabled = true; await cargarPanel(); b.disabled = false; };
document.querySelectorAll('.lateral-nav a').forEach((a) => a.addEventListener('click', () => { document.querySelectorAll('.lateral-nav a').forEach((x) => x.classList.toggle('activo', x === a)); }));

// ---------- HU-03: evidencia (solo gerente) ----------
async function abrirEvidencia(pagoId) {
  let d;
  try { d = await api(`/api/pagos/${pagoId}/evidencias`); }
  catch (e) { if (e.sesion) return; return aviso('Evidencia', e.status === 409 ? e.message : 'No fue posible mostrar la evidencia.'); }
  const p = d.pago;
  $('evid-datos').innerHTML = dl([['Concepto', esc(p.concepto)], ['Entidad', esc(p.entidad)], ['Monto', soles(p.monto)], ['Fecha y hora de pago', `${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}`], ['Comentario del asistente', p.comentario ? esc(p.comentario) : '—']]);
  const mostrar = (a, etiqueta) => {
    const url = `/api/evidencias/${a.id}`;
    $('evid-cuerpo').innerHTML = `<p class="evid-etq">${etiqueta}: ${esc(a.nombre)}</p>` + (a.tipo === 'application/pdf' ? `<iframe src="${url}" title="Evidencia"></iframe>` : `<img src="${url}" alt="Evidencia del pago">`);
    $('evid-descargar').href = url + '?descargar=1'; $('evid-descargar').hidden = false;
  };
  mostrar(d.vigente, 'Evidencia vigente');
  $('evid-previos').innerHTML = d.previos.length ? `<h4>Intentos previos (solo lectura)</h4><ul class="previos">${d.previos.map((a) => `<li><span>Intento ${a.numero_intento} · ${esc(a.nombre)} · reemplazado el ${esc(a.reemplazada_en)}</span>
      <button class="btn btn-claro btn-sm" data-prev="${a.id}">Ver</button> <a class="btn btn-claro btn-sm" href="/api/evidencias/${a.id}?descargar=1">Descargar</a></li>`).join('')}</ul>` : '';
  $('evid-previos').querySelectorAll('[data-prev]').forEach((b) => (b.onclick = () => mostrar(d.previos.find((x) => String(x.id) === b.dataset.prev), 'Intento previo')));
  $('dlg-evid').showModal();
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

function etiquetaEstado(p) {
  if (p.estado === 'PAGADO') return '<span class="etq PAGADO">Pagado</span>';
  return '<span class="etq PENDIENTE">Pendiente</span>' + (p.alerta === 'ATRASADO' ? ' <span class="etq ATRASADO">Atrasado</span>' : '');
}
function botonesPago(p) {
  if (p.estado === 'PENDIENTE') return `<button class="btn btn-primario btn-sm" data-pagar="${p.id}">Registrar pago</button>`;
  return `<button class="btn btn-claro btn-sm" data-cambiar="${p.id}">Cambiar evidencia</button><br><small>Cambios: ${p.intentos_usados}/3</small>`;
}

// ---------- HU-04: pagos del mes (lista y calendario) ----------
async function cargarMes() {
  let d;
  try { d = await api('/api/pagos' + (mes ? `?mes=${mes}` : '')); }
  catch (e) { if (e.sesion) return; $('filas').innerHTML = ''; $('m-vista-cal').innerHTML = ''; $('resumen').innerHTML = ''; return vacioMes('No fue posible obtener los pagos del mes.', true); }
  mes = d.mes; pagosMes = d.pagos;
  $('mes-titulo').textContent = nombreMes(mes);
  const r = d.resumen; const pct = r.total_mes ? Math.round((r.pagado_mes / r.total_mes) * 100) : 0;
  $('resumen').innerHTML = `
    <div class="kpi azul"><div class="kpi-icono">💼</div><div><small>Total del mes</small><b>${soles(r.total_mes)}</b></div></div>
    <div class="kpi verde"><div class="kpi-icono">✅</div><div><small>Ya pagado</small><b>${soles(r.pagado_mes)}</b></div></div>
    <div class="kpi ambar"><div class="kpi-icono">⏳</div><div><small>Falta pagar (${r.n_pendientes})</small><b>${soles(r.pendiente_total)}</b></div></div>
    <div class="progreso">Avance de pagos del mes: ${pct}%<div class="barra-fondo"><div class="barra-valor" style="width:${pct}%"></div></div></div>`;
  if (!d.pagos.length) vacioMes('No hay pagos registrados para este mes.', false); else $('vacio-mes').hidden = true;
  $('m-vista-lista').hidden = vistaMes !== 'lista' || !d.pagos.length; $('m-vista-cal').hidden = vistaMes !== 'cal' || !d.pagos.length;
  $('filas').innerHTML = d.pagos.map((p) => `<tr class="${p.alerta === 'ATRASADO' ? 'fila-atrasada' : ''}">
    <td><b>${esc(p.concepto)}</b><br><small>${esc(p.entidad)}</small></td><td><span class="cat">${esc(p.categoria)}</span></td><td class="monto">${soles(p.monto)}</td>
    <td>${fmtFecha(p.fecha_vencimiento)}</td><td>${etiquetaEstado(p)}</td><td>${p.estado === 'PAGADO' ? `${fmtFecha(p.fecha_pago)} ${esc(p.hora_pago || '')}` : '—'}</td><td class="acciones">${botonesPago(p)}</td></tr>`).join('');
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
    celdas += `<div class="cal-dia${f === d.hoy ? ' hoy' : ''}"><span class="cal-n">${n}</span>${(porDia[n] || []).map((p) => `<button class="cal-pago ${p.estado === 'PAGADO' ? 'ok' : p.alerta === 'ATRASADO' ? 'atr' : 'pen'}" data-detalle="${p.id}" title="${esc(p.concepto)} · ${esc(p.entidad)} · ${soles(p.monto)}">${esc(p.concepto)}</button>`).join('')}</div>`;
  }
  $('m-vista-cal').innerHTML = (previos.length ? `<div class="cal-previos"><b>Atrasados de meses anteriores:</b> ${previos.map((p) => `<button class="cal-pago atr" data-detalle="${p.id}">${esc(p.concepto)} (${fmtFecha(p.fecha_vencimiento)})</button>`).join('')}</div>` : '') + `<div class="cal">${celdas}</div>`;
  $('m-vista-cal').querySelectorAll('[data-detalle]').forEach((b) => (b.onclick = () => {
    const p = pagosMes.find((x) => String(x.id) === b.dataset.detalle);
    aviso(p.concepto, `Entidad: ${p.entidad}\nCategoría: ${p.categoria}\nMonto: ${soles(p.monto)}\nVencimiento: ${fmtFecha(p.fecha_vencimiento)}\nEstado: ${p.estado === 'PAGADO' ? `Pagado el ${fmtFecha(p.fecha_pago)} ${p.hora_pago || ''}` : p.alerta === 'ATRASADO' ? 'Pendiente (atrasado)' : 'Pendiente'}`,
      p.estado === 'PENDIENTE' ? { texto: 'Registrar pago', accion: () => abrirPagar(p) } : null);
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
  $('filas-vencer').innerHTML = d.pagos.map((p) => `<tr class="${p.alerta === 'ATRASADO' ? 'fila-atrasada' : ''}"><td><b>${esc(p.concepto)}</b><br><small>${esc(p.entidad)}</small></td><td><span class="cat">${esc(p.categoria)}</span></td>
    <td class="monto">${soles(p.monto)}</td><td>${fmtFecha(p.fecha_vencimiento)}</td>
    <td>${p.alerta === 'ATRASADO' ? `<span class="etq ATRASADO">Atrasado · ${-p.dias} ${-p.dias === 1 ? 'día' : 'días'}</span>` : `<span class="etq POR_VENCER">${p.dias === 0 ? 'Vence hoy' : p.dias === 1 ? 'Falta 1 día' : `Faltan ${p.dias} días`}</span>`}</td>
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
  raiz.querySelectorAll('[data-cambiar]').forEach((b) => (b.onclick = () => abrirCambiar(buscarPago(b.dataset.cambiar))));
}
const buscarPago = (id) => pagosMes.find((x) => String(x.id) === id) || pagosVencer.find((x) => String(x.id) === id);
async function refrescar() { await Promise.all([cargarMes(), cargarVencer()]); }

// ---------- HU-05: registrar pago por realizar ----------
let nuevoDatos = null;
$('btn-nuevo').onclick = () => {
  ['n-concepto', 'n-entidad', 'n-monto', 'n-venc'].forEach((i) => ($(i).value = ''));
  $('sel-cat').value = ''; limpiarErrores($('dlg-nuevo')); $('nuevo-error').textContent = ''; $('nuevo-error2').textContent = '';
  $('nuevo-paso1').hidden = false; $('nuevo-paso2').hidden = true; $('n-venc').min = sumaDias(fechaLima(), 1); $('dlg-nuevo').showModal();
};
$('nuevo-continuar').onclick = async () => {
  limpiarErrores($('dlg-nuevo')); $('nuevo-error').textContent = '';
  nuevoDatos = { concepto: $('n-concepto').value, entidad: $('n-entidad').value, categoria_id: $('sel-cat').value, monto: $('n-monto').value, fecha_vencimiento: $('n-venc').value };
  try {
    const r = await enviarJson('/api/pagos/verificar', 'POST', nuevoDatos);
    const cat = $('sel-cat').selectedOptions[0].textContent;
    $('nuevo-resumen').innerHTML = dl([['Concepto', esc(nuevoDatos.concepto.trim())], ['Entidad', esc(nuevoDatos.entidad.trim())], ['Categoría', esc(cat)], ['Monto', soles(nuevoDatos.monto)], ['Vencimiento', fmtFecha(nuevoDatos.fecha_vencimiento)]]);
    const dup = $('nuevo-dup'); dup.hidden = !r.duplicado;
    if (r.duplicado) { const x = r.duplicado; dup.innerHTML = `⚠ Este pago podría ser un pago repetido. Ya existe: <b>${esc(x.concepto)}</b> · ${esc(x.entidad)} · ${esc(x.categoria)} · ${soles(x.monto)} · vence ${fmtFecha(x.fecha_vencimiento)} (${x.estado === 'PAGADO' ? 'Pagado' : 'Pendiente'}). Puedes cancelar o confirmar el registro.`; }
    $('nuevo-paso1').hidden = true; $('nuevo-paso2').hidden = false;
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
    await enviarJson('/api/pagos', 'POST', nuevoDatos);
    $('dlg-nuevo').close(); toast(`Pago «${nuevoDatos.concepto.trim()}» registrado como pendiente.`); await refrescar();
  } catch (e) { if (!e.sesion) $('nuevo-error2').textContent = e.campos ? Object.values(e.campos)[0] : 'No fue posible registrar el pago.'; }
  finally { b.disabled = false; }
};

// ---------- HU-06: registrar pago como realizado ----------
let pagoActual = null;
function datosPago(p) { return dl([['Concepto', esc(p.concepto)], ['Entidad', esc(p.entidad)], ['Categoría', esc(p.categoria)], ['Monto', soles(p.monto)], ['Vencimiento', fmtFecha(p.fecha_vencimiento)]]); }
function abrirPagar(p) {
  pagoActual = p; $('pagar-datos').innerHTML = datosPago(p);
  const hoyL = fechaLima(); const f = $('pagar-fecha'); f.value = hoyL; f.max = hoyL; f.min = sumaDias(hoyL, -7); $('pagar-hora').value = horaLima();
  $('pagar-coment').value = ''; $('pagar-archivo').value = ''; limpiarErrores($('dlg-pagar')); $('pagar-error').textContent = '';
  $('pagar-paso1').hidden = false; $('pagar-paso2').hidden = true; $('dlg-pagar').showModal();
}
$('pagar-continuar').onclick = () => {
  limpiarErrores($('dlg-pagar')); let mal = false;
  const fecha = $('pagar-fecha').value, hora = $('pagar-hora').value, archivo = $('pagar-archivo').files[0];
  if (!fecha) { $('err-pagar-fecha').textContent = 'Indica la fecha de pago'; mal = true; }
  else if (fecha < sumaDias(fechaLima(), -7)) { $('err-pagar-fecha').textContent = 'No puede ser anterior a una semana'; mal = true; }
  if (!hora) { $('err-pagar-hora').textContent = 'Indica la hora de pago'; mal = true; }
  if (fecha && hora && `${fecha} ${hora}` > `${fechaLima()} ${horaLima()}`) { $('err-pagar-fecha').textContent = 'No puede ser posterior al momento actual'; mal = true; }
  const ea = validarArchivo(archivo); if (ea) { $('err-pagar-archivo').textContent = ea; mal = true; }
  if (mal) return;
  $('pagar-resumen').innerHTML = datosPago(pagoActual) + dl([['Fecha y hora de pago', `${fmtFecha(fecha)} ${hora}`], ['Comentario', $('pagar-coment').value.trim() ? esc($('pagar-coment').value.trim()) : '—'], ['Evidencia', esc(archivo.name)]]);
  $('pagar-paso1').hidden = true; $('pagar-paso2').hidden = false;
};
$('pagar-volver').onclick = () => { $('pagar-paso1').hidden = false; $('pagar-paso2').hidden = true; };
$('pagar-confirmar').onclick = async () => {
  const b = $('pagar-confirmar'); b.disabled = true; $('pagar-error').textContent = '';
  const fecha = $('pagar-fecha').value, hora = $('pagar-hora').value, archivo = $('pagar-archivo').files[0];
  try {
    const r = await enviarArchivo(`/api/pagos/${pagoActual.id}/pagar`, archivo, { 'X-Fecha-Pago': fecha, 'X-Hora-Pago': hora, 'X-Comentario': encodeURIComponent($('pagar-coment').value.trim()) });
    $('dlg-pagar').close();
    aviso('Pago registrado', `El pago «${r.concepto}» se registró como realizado.\nFecha y hora: ${fmtFecha(r.fecha_pago)} ${r.hora_pago}\nEvidencia: ${r.archivo}`);
    await refrescar();
  } catch (e) {
    if (e.sesion) return;
    $('pagar-error').textContent = e.red || !e.status || e.status >= 500 ? 'La operación no se completó. El pago sigue Pendiente y sin evidencia.' : e.message;
  } finally { b.disabled = false; }
};

// ---------- HU-07: cambiar evidencia ----------
function abrirCambiar(p) {
  pagoActual = p; const usados = p.intentos_usados || 0; const rest = 3 - usados;
  $('cambiar-datos').innerHTML = datosPago(p) + dl([['Archivo vigente', esc(p.evidencia_nombre || 'Sin archivo')], ['Intentos usados', `${usados} de 3`], ['Intentos disponibles', String(rest)]]);
  $('cambiar-archivo').value = ''; limpiarErrores($('dlg-cambiar')); $('cambiar-error').textContent = '';
  $('cambiar-paso1').hidden = false; $('cambiar-paso2').hidden = true;
  if (rest <= 0) return aviso('Cambio de evidencia', 'Se alcanzó el máximo de 3 intentos de cambio de evidencia para este pago.');
  $('dlg-cambiar').showModal();
}
$('cambiar-continuar').onclick = () => {
  limpiarErrores($('dlg-cambiar')); const a = $('cambiar-archivo').files[0]; const ea = validarArchivo(a);
  if (ea) { $('err-cambiar-archivo').textContent = ea; return; }
  $('cambiar-confirma').textContent = (pagoActual.evidencia_nombre ? `Se reemplazará «${pagoActual.evidencia_nombre}» por «${a.name}». El archivo actual quedará como intento previo y este cambio contará como un intento. ¿Confirmas?` : `Se adjuntará «${a.name}» como evidencia de este pago. ¿Confirmas?`);
  $('cambiar-paso1').hidden = true; $('cambiar-paso2').hidden = false;
};
$('cambiar-volver').onclick = () => { $('cambiar-paso1').hidden = false; $('cambiar-paso2').hidden = true; };
$('cambiar-confirmar').onclick = async () => {
  const b = $('cambiar-confirmar'); b.disabled = true; $('cambiar-error').textContent = '';
  try {
    const r = await enviarArchivo(`/api/pagos/${pagoActual.id}/evidencia`, $('cambiar-archivo').files[0]);
    $('dlg-cambiar').close(); aviso('Evidencia cambiada', `La evidencia se cambió correctamente. Te ${r.intentos_restantes === 1 ? 'queda 1 intento' : `quedan ${r.intentos_restantes} intentos`} de cambio.`); await refrescar();
  } catch (e) { if (!e.sesion) $('cambiar-error').textContent = e.red || !e.status || e.status >= 500 ? 'La operación no se completó. Se mantiene la evidencia actual.' : e.message; }
  finally { b.disabled = false; }
};

iniciar();
