import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { superDir, loadQueue, setStatus, reviewPath, type ReviewStatus } from './store.js';
import { SUPERMARKETS } from './supermarkets.js';

const PORT = Number(process.env.PORT ?? 3000);

/** Supers configurados que ya tienen cola generada (data/output/<id>/review.json). */
function availableSupers(): { id: string; name: string }[] {
  return Object.values(SUPERMARKETS)
    .filter((sm) => existsSync(reviewPath(sm.id)))
    .map((sm) => ({ id: sm.id, name: sm.name }));
}

const app = express();
app.use(express.json());

// Front estático
app.use('/', express.static(path.resolve('public', 'review')));

// Imágenes de páginas, namespaced por super: /img/<super>/pages/<hash>/page-NN.png
app.get('/img/:super/*', (req, res) => {
  const rel = (req.params as Record<string, string>)[0];
  if (rel.includes('..')) return res.status(400).end();
  res.sendFile(path.join(superDir(req.params.super), rel));
});

// Lista de supers disponibles (para el selector)
app.get('/api/supers', (_req, res) => {
  res.json({ supers: availableSupers() });
});

app.get('/api/queue', async (req, res) => {
  const supermarket = String(req.query.super ?? '');
  if (!supermarket) return res.status(400).json({ error: 'falta ?super=' });
  const queue = await loadQueue(supermarket);
  if (!queue) return res.status(404).json({ error: 'sin cola' });
  const pending = queue.items.filter((it) => it.status === 'pending').length;
  const accepted = queue.items.filter((it) => it.status === 'accepted').length;
  const rejected = queue.items.filter((it) => it.status === 'rejected').length;
  res.json({
    supermarket,
    source_pdf: queue.source_pdf,
    counts: { total: queue.items.length, pending, accepted, rejected },
    items: queue.items,
  });
});

app.post('/api/review/:id', async (req, res) => {
  const supermarket = String(req.query.super ?? req.body?.super ?? '');
  if (!supermarket) return res.status(400).json({ error: 'falta ?super=' });
  const status = req.body?.status as ReviewStatus;
  if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') {
    return res.status(400).json({ error: 'status inválido' });
  }
  const updated = await setStatus(supermarket, req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'item no encontrado' });
  res.json(updated);
});

app.listen(PORT, () => {
  const supers = availableSupers();
  console.log(`\n🔎 Revisión de matches en  http://localhost:${PORT}`);
  console.log(supers.length ? `   Supers con cola: ${supers.map((s) => s.id).join(', ')}\n` : '   ⚠️  No hay colas todavía. Corré primero src/run.ts.\n');
});
