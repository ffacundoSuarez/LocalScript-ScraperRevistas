let queue = [];      // items pendientes a revisar
let pos = 0;         // índice actual dentro de queue
let counts = { accepted: 0, rejected: 0, total: 0 };
let currentSuper = null;

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('es-AR')}`);

async function init() {
  const res = await fetch('/api/supers');
  const { supers } = await res.json();
  const sel = $('super-select');
  if (!supers.length) {
    sel.innerHTML = '<option>sin colas</option>';
    return;
  }
  sel.innerHTML = supers.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  sel.addEventListener('change', () => load(sel.value));
  currentSuper = supers[0].id;
  await load(currentSuper);
}

async function load(superName) {
  currentSuper = superName;
  $('super-select').value = superName;
  const res = await fetch('/api/queue?super=' + encodeURIComponent(superName));
  const data = await res.json();
  counts = { accepted: data.counts.accepted, rejected: data.counts.rejected, total: data.counts.total };
  queue = data.items.filter((it) => it.status === 'pending');
  pos = 0;
  render();
}

function render() {
  if (pos >= queue.length) return showDone();
  $('app').classList.remove('hidden');
  $('done').classList.add('hidden');

  const it = queue[pos];
  $('progress').textContent =
    `${pos + 1} / ${queue.length} pendientes · ${counts.accepted} aceptados · ${counts.rejected} rechazados`;

  $('page-img').src = '/img/' + encodeURIComponent(currentSuper) + '/' + it.page_image;
  $('page-tag').textContent = `pág. ${it.page}${it.source_pdf ? ' · ' + it.source_pdf : ''}`;

  const e = it.extracted;
  $('extracted').innerHTML = rows([
    ['Nombre', e.name],
    ['Marca', e.brand],
    ['Cantidad', e.quantity],
    ['Precio', fmtMoney(e.price)],
    ['Promo', e.promo_price != null ? fmtMoney(e.promo_price) : e.promo_text],
    ['EAN', e.ean],
  ]);

  const pct = Math.round((it.confidence || 0) * 100);
  $('conf-fill').style.width = pct + '%';
  $('conf-fill').style.background = pct >= 70 ? 'var(--accept)' : pct >= 45 ? '#d69e2e' : 'var(--reject)';
  $('conf-label').textContent = pct + '%' + (it.method === 'ean' ? ' (EAN)' : '');

  const m = it.proposed_match || {};
  $('proposed').innerHTML = rows([
    ['Nombre', m.name],
    ['Marca', m.brand],
    ['Cantidad', m.quantity],
    ['EAN', m.ean],
  ]);
  $('reason').textContent = it.reason || '';
}

function rows(pairs) {
  return pairs
    .map(([k, v]) => `<dt>${k}</dt><dd>${v == null || v === '' ? '—' : escapeHtml(String(v))}</dd>`)
    .join('');
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function decide(status) {
  if (pos >= queue.length) return;
  const it = queue[pos];
  await fetch('/api/review/' + encodeURIComponent(it.id) + '?super=' + encodeURIComponent(currentSuper), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (status === 'accepted') counts.accepted++;
  else counts.rejected++;
  pos++;
  render();
}

function showDone() {
  $('app').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('done-summary').textContent =
    `${counts.accepted} aceptados · ${counts.rejected} rechazados · sobre ${counts.total} matches propuestos.`;
}

$('accept').addEventListener('click', () => decide('accepted'));
$('reject').addEventListener('click', () => decide('rejected'));

// --- Zoom in-place sobre la imagen de la página (rueda + arrastre) -----------
// Sin salir de la revisión: rueda para acercar/alejar sobre el cursor, arrastrar
// para mover, doble click para volver al encuadre.
const pageImg = $('page-img');
const pageCol = document.querySelector('.page-col');
let zScale = 1, zBase = 1, zX = 0, zY = 0;

function zClamp() {
  const cw = pageCol.clientWidth, ch = pageCol.clientHeight;
  const sw = pageImg.naturalWidth * zScale, sh = pageImg.naturalHeight * zScale;
  zX = sw <= cw ? (cw - sw) / 2 : Math.min(0, Math.max(cw - sw, zX));
  zY = sh <= ch ? (ch - sh) / 2 : Math.min(0, Math.max(ch - sh, zY));
}
function zApply() {
  zClamp();
  pageImg.style.transform = `translate(${zX}px, ${zY}px) scale(${zScale})`;
  pageCol.classList.toggle('zoomed', zScale > zBase + 0.001);
}
function zFit() {
  const cw = pageCol.clientWidth, ch = pageCol.clientHeight;
  const nw = pageImg.naturalWidth, nh = pageImg.naturalHeight;
  if (!nw || !nh) return;
  zBase = Math.min(cw / nw, ch / nh);
  zScale = zBase;
  zX = (cw - nw * zBase) / 2;
  zY = (ch - nh * zBase) / 2;
  zApply();
}
pageImg.addEventListener('load', zFit); // re-encuadra al cambiar de item
window.addEventListener('resize', zFit);

pageCol.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = pageCol.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const next = Math.min(Math.max(zScale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), zBase), zBase * 12);
  // mantener fijo el punto bajo el cursor
  zX = cx - (cx - zX) * (next / zScale);
  zY = cy - (cy - zY) * (next / zScale);
  zScale = next;
  if (zScale <= zBase + 0.001) zFit(); else zApply();
}, { passive: false });

let zDrag = false, zlx = 0, zly = 0;
pageCol.addEventListener('mousedown', (e) => {
  if (zScale <= zBase + 0.001) return; // sólo se puede mover cuando hay zoom
  zDrag = true; zlx = e.clientX; zly = e.clientY;
  pageCol.classList.add('dragging');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!zDrag) return;
  zX += e.clientX - zlx; zY += e.clientY - zly;
  zlx = e.clientX; zly = e.clientY;
  zApply();
});
window.addEventListener('mouseup', () => { zDrag = false; pageCol.classList.remove('dragging'); });
pageCol.addEventListener('dblclick', zFit);

document.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'a') decide('accepted');
  else if (k === 'r') decide('rejected');
});

init();
