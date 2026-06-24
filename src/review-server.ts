import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { superDir, loadQueue, setStatus, reviewPath, type ReviewStatus } from './store.js';

function parseSuper(): string {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--super='));
  const name = arg?.split('=')[1];
  if (!name) {
    console.error('Uso: npm run review -- --super=<nombre>');
    process.exit(1);
  }
  return name;
}

const supermarket = parseSuper();
const PORT = Number(process.env.PORT ?? 3000);

if (!existsSync(reviewPath(supermarket))) {
  console.error(`❌ No existe ${reviewPath(supermarket)}.`);
  console.error(`   Corré primero:  npm run run -- data/pdfs/<archivo>.pdf --super=${supermarket}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Front estático + PNGs de las páginas del super
app.use('/', express.static(path.resolve('public', 'review')));
app.use('/pages', express.static(path.join(superDir(supermarket), 'pages')));

app.get('/api/queue', async (_req, res) => {
  const queue = await loadQueue(supermarket);
  if (!queue) return res.status(404).json({ error: 'sin cola' });
  const pending = queue.items.filter((it) => it.status === 'pending').length;
  const accepted = queue.items.filter((it) => it.status === 'accepted').length;
  const rejected = queue.items.filter((it) => it.status === 'rejected').length;
  res.json({ supermarket, source_pdf: queue.source_pdf, counts: { total: queue.items.length, pending, accepted, rejected }, items: queue.items });
});

app.post('/api/review/:id', async (req, res) => {
  const status = req.body?.status as ReviewStatus;
  if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') {
    return res.status(400).json({ error: 'status inválido' });
  }
  const updated = await setStatus(supermarket, req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'item no encontrado' });
  res.json(updated);
});

app.listen(PORT, () => {
  console.log(`\n🔎 Revisión de "${supermarket}" en  http://localhost:${PORT}\n`);
});
