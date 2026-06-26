import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MatchResult } from './match.js';
import type { ExtractedProduct } from './extract.js';
import { detectImage } from './image.js';

export type ReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface ReviewItem {
  id: string;
  source_pdf: string; // de qué revista salió (un super puede tener varias)
  page: number;
  page_image: string; // relativo al dir del super, ej. "pages/<hash>/page-16.png"
  extracted: {
    name: string;
    brand: string | null;
    ean: string | null;
    price: number | null;
    promo_price: number | null;
    promo_text: string | null;
    quantity: string | null;
  };
  proposed_match:
    | { product_id: string; name: string; brand: string | null; ean: string | null; quantity: string | null }
    | null;
  confidence: number;
  method: 'ean' | 'llm' | 'none';
  reason: string;
  candidates: { product_id: string; name: string; brand: string | null }[];
  status: ReviewStatus;
  reviewed_at: string | null;
}

export interface ReviewQueue {
  supermarket: string;
  source_pdf: string;
  generated_at: string;
  items: ReviewItem[];
}

// --- Rutas ---------------------------------------------------------------
export function superDir(supermarket: string): string {
  return path.resolve('data', 'output', supermarket);
}
export function reviewPath(supermarket: string): string {
  return path.join(superDir(supermarket), 'review.json');
}
function allPath(supermarket: string): string {
  return path.join(superDir(supermarket), 'all.json');
}

export function pdfHash(pdfPath: string, content: Buffer): string {
  return createHash('sha1').update(path.basename(pdfPath)).update(content).digest('hex').slice(0, 10);
}

// --- Cache de extracción (visión) -----------------------------------------
// La visión es lo que cuesta dinero, así que la persistimos por página a medida que sale.
// Si una corrida se corta, la siguiente reanuda: sólo se llama a visión para las páginas que faltan.
function extractedPath(supermarket: string, hash: string): string {
  return path.join(superDir(supermarket), 'extracted', `${hash}.json`);
}

/** Levanta la extracción ya hecha de una revista (hash): Map<nº de página → productos>. */
export async function loadExtraction(
  supermarket: string,
  hash: string,
): Promise<Map<number, ExtractedProduct[]>> {
  const file = extractedPath(supermarket, hash);
  if (!existsSync(file)) return new Map();
  try {
    const arr = JSON.parse(await readFile(file, 'utf8')) as { page: number; products: ExtractedProduct[] }[];
    return new Map(arr.map((e) => [e.page, e.products]));
  } catch {
    return new Map();
  }
}

/** Persiste la extracción de una revista (hash). Se llama tras cada página para no perder visión. */
export async function saveExtraction(
  supermarket: string,
  hash: string,
  byPage: Map<number, ExtractedProduct[]>,
): Promise<void> {
  const file = extractedPath(supermarket, hash);
  await mkdir(path.dirname(file), { recursive: true });
  const arr = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, products]) => ({ page, products }));
  await writeFile(file, JSON.stringify(arr, null, 2), 'utf8');
}

/**
 * Guarda los PNG de las páginas bajo pages/<hash>/ (un subdir por PDF, así varias revistas del
 * mismo super no se pisan) y devuelve un map nº de página → ruta relativa.
 */
export async function savePages(
  supermarket: string,
  hash: string,
  pages: Buffer[],
  firstPage = 1,
): Promise<Map<number, string>> {
  const dir = path.join(superDir(supermarket), 'pages', hash);
  await mkdir(dir, { recursive: true });
  const map = new Map<number, string>();
  for (let i = 0; i < pages.length; i++) {
    const pageNo = firstPage + i; // nº real (puede empezar en >1 si se pidió un rango)
    const { ext } = detectImage(pages[i]); // PNG/JPEG/WebP según la fuente
    const rel = path.join('pages', hash, `page-${String(pageNo).padStart(2, '0')}.${ext}`);
    await writeFile(path.join(superDir(supermarket), rel), pages[i]);
    map.set(pageNo, rel.replace(/\\/g, '/'));
  }
  return map;
}

function toReviewItem(
  r: MatchResult,
  id: string,
  pageImage: string,
  sourcePdf: string,
): ReviewItem {
  return {
    id,
    source_pdf: sourcePdf,
    page: r.page,
    page_image: pageImage,
    extracted: {
      name: r.item.name,
      brand: r.item.brand,
      ean: r.item.ean,
      price: r.item.price,
      promo_price: r.item.promo_price,
      promo_text: r.item.promo_text,
      quantity: r.item.quantity,
    },
    proposed_match: r.matched
      ? {
          product_id: r.matched.id,
          name: r.matched.name,
          brand: r.matched.brand ?? null,
          ean: r.matched.ean ?? null,
          quantity: r.matched.quantity ?? null,
        }
      : null,
    confidence: r.confidence,
    method: r.method,
    reason: r.reason,
    candidates: r.candidates.map((c) => ({ product_id: c.id, name: c.name, brand: c.brand ?? null })),
    status: 'pending',
    reviewed_at: null,
  };
}

/**
 * Escribe la cola de revisión (sólo items con match propuesto) y un dump completo (all.json).
 * Hace merge por id con la cola previa para no perder estados ya revisados al re-correr.
 */
export async function writeQueue(
  supermarket: string,
  sourcePdf: string,
  results: MatchResult[],
  hash: string,
  pageImages: Map<number, string>,
): Promise<ReviewQueue> {
  await mkdir(superDir(supermarket), { recursive: true });

  // índice estable por página para este PDF (hash)
  const perPageCount = new Map<number, number>();
  const current = results.map((r) => {
    const idx = perPageCount.get(r.page) ?? 0;
    perPageCount.set(r.page, idx + 1);
    return toReviewItem(r, `${hash}-p${r.page}-${idx}`, pageImages.get(r.page) ?? '', sourcePdf);
  });

  // all.json (dump completo): refresca los items de ESTE hash, conserva los de otras revistas.
  const allItems = mergeByHash(await readItems(allPath(supermarket)), current, hash);
  await writeFile(allPath(supermarket), JSON.stringify(allItems, null, 2), 'utf8');

  // review.json (cola): sólo los que tienen match, con merge de estados previos por id.
  const prevQueueItems = (await loadQueue(supermarket))?.items ?? [];
  const prevById = new Map(prevQueueItems.map((it) => [it.id, it]));
  const currentQueue = current
    .filter((it) => it.proposed_match !== null)
    .map((it) => {
      const old = prevById.get(it.id);
      return old && old.status !== 'pending'
        ? { ...it, status: old.status, reviewed_at: old.reviewed_at }
        : it;
    });
  const items = mergeByHash(prevQueueItems, currentQueue, hash);

  const queue: ReviewQueue = {
    supermarket,
    source_pdf: [...new Set(items.map((it) => it.source_pdf))].join(', '),
    generated_at: new Date().toISOString(),
    items,
  };
  await writeFile(reviewPath(supermarket), JSON.stringify(queue, null, 2), 'utf8');
  return queue;
}

/** Reemplaza los items de un hash dado, conservando los del resto de los hashes (otras revistas). */
function mergeByHash(prev: ReviewItem[], current: ReviewItem[], hash: string): ReviewItem[] {
  const kept = prev.filter((it) => !it.id.startsWith(`${hash}-`));
  return [...kept, ...current];
}

async function readItems(file: string): Promise<ReviewItem[]> {
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ReviewItem[];
  } catch {
    return [];
  }
}

// --- Lectura/escritura para el servidor de revisión ----------------------
export async function loadQueue(supermarket: string): Promise<ReviewQueue | null> {
  if (!existsSync(reviewPath(supermarket))) return null;
  return JSON.parse(await readFile(reviewPath(supermarket), 'utf8')) as ReviewQueue;
}

export async function setStatus(
  supermarket: string,
  id: string,
  status: ReviewStatus,
): Promise<ReviewItem | null> {
  const queue = await loadQueue(supermarket);
  if (!queue) return null;
  const item = queue.items.find((it) => it.id === id);
  if (!item) return null;
  item.status = status;
  item.reviewed_at = new Date().toISOString();
  await writeFile(reviewPath(supermarket), JSON.stringify(queue, null, 2), 'utf8');
  return item;
}
