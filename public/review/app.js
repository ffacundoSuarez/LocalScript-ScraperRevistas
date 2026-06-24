let queue = [];      // items pendientes a revisar
let pos = 0;         // índice actual dentro de queue
let counts = { accepted: 0, rejected: 0, total: 0 };

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('es-AR')}`);

async function load() {
  const res = await fetch('/api/queue');
  const data = await res.json();
  $('super').textContent = `· ${data.supermarket} (${data.source_pdf})`;
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

  $('page-img').src = '/' + it.page_image;
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
  await fetch('/api/review/' + encodeURIComponent(it.id), {
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
document.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'a') decide('accepted');
  else if (k === 'r') decide('rejected');
});

load();
