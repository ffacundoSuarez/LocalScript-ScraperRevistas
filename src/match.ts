import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { config } from './config.js';
import type { CatalogProduct } from './products.js';
import type { ExtractedProduct } from './extract.js';

const client = new OpenAI({ apiKey: config.openaiApiKey });
const EMB_CACHE = path.resolve('data', 'cache', 'embeddings.json');

// ---------------------------------------------------------------------------
// Normalización: clave para no comparar "1L" con "1000 ml" como cosas distintas.
// ---------------------------------------------------------------------------
function stripAccents(s: string): string {
  // ̀-ͯ = marcas diacríticas combinables (acentos) tras NFD
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeText(s: string): string {
  let t = stripAccents(s.toLowerCase());
  // unificar unidades comunes
  t = t
    .replace(/(\d+)\s*(lt|lts|litros?)\b/g, '$1l')
    .replace(/(\d+)\s*(cc|ml|mililitros?)\b/g, '$1ml')
    .replace(/(\d+)\s*(kg|kilos?|kilogramos?)\b/g, '$1kg')
    .replace(/(\d+)\s*(gr|grs|gramos?)\b/g, '$1g')
    .replace(/\bx\s*(\d+)/g, 'x$1');
  return t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function productText(p: CatalogProduct): string {
  return normalizeText([p.brand, p.name, p.quantity].filter(Boolean).join(' '));
}

/**
 * ¿El candidato es de la misma marca que el item? Compara la marca normalizada del item
 * contra (marca + nombre) del candidato, porque a veces la marca viene dentro del nombre
 * y no en el campo `brand`. normalizeText ya colapsa acentos/mayúsculas (AYUDÍN == Ayudin).
 *
 * Importante: el match es por **palabra completa**, no substring. Si no, una marca corta como
 * "Lava" (lavavajillas) matchearía cualquier "LAVAndina" → falso positivo cross-marca.
 */
function brandMatches(itemBrand: string, c: CatalogProduct): boolean {
  const needle = normalizeText(itemBrand).split(' ').filter(Boolean);
  if (needle.length === 0) return true;
  const hay = normalizeText(`${c.brand ?? ''} ${c.name}`).split(' ');
  // ¿aparece la marca como secuencia de palabras completas dentro del candidato?
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/** Palabras "de contenido" (sin números/unidades ni tokens muy cortos), para chequear solapamiento. */
function contentTokens(s: string): Set<string> {
  return new Set(normalizeText(s).split(' ').filter((w) => w.length >= 3 && !/\d/.test(w)));
}

function itemText(item: ExtractedProduct): string {
  return normalizeText([item.brand, item.name, item.quantity].filter(Boolean).join(' '));
}

// ---------------------------------------------------------------------------
// Embeddings del catálogo (cache en disco, keyed por modelo + hash del contenido)
// ---------------------------------------------------------------------------
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await client.embeddings.create({ model: config.embeddingModel, input: texts });
  return res.data.map((d) => d.embedding);
}

export interface CatalogIndex {
  products: CatalogProduct[];
  embeddings: number[][];
  byEan: Map<string, CatalogProduct>;
}

/** Construye (o levanta del cache) los embeddings del catálogo. */
export async function buildCatalogIndex(products: CatalogProduct[]): Promise<CatalogIndex> {
  const texts = products.map(productText);
  const hash = crypto
    .createHash('sha1')
    .update(config.embeddingModel + '\n' + texts.join('\n'))
    .digest('hex');

  let embeddings: number[][] | undefined;
  if (existsSync(EMB_CACHE)) {
    const cached = JSON.parse(await readFile(EMB_CACHE, 'utf8')) as {
      hash: string;
      embeddings: number[][];
    };
    if (cached.hash === hash) embeddings = cached.embeddings;
  }

  if (!embeddings) {
    console.log(`  · generando embeddings de ${products.length} productos del catálogo...`);
    embeddings = await embedBatch(texts);
    await mkdir(path.dirname(EMB_CACHE), { recursive: true });
    await writeFile(EMB_CACHE, JSON.stringify({ hash, embeddings }), 'utf8');
  }

  const byEan = new Map<string, CatalogProduct>();
  for (const p of products) if (p.ean) byEan.set(p.ean.replace(/\D/g, ''), p);

  return { products, embeddings, byEan };
}

// ---------------------------------------------------------------------------
// Matching: EAN exacto → retrieval por embeddings → juez LLM
// ---------------------------------------------------------------------------
const Judgement = z.object({
  best_candidate_id: z
    .string()
    .nullable()
    .describe('id del candidato MÁS probable de ser el mismo producto, o null si ninguno tiene relación'),
  confidence: z
    .number()
    .describe('0 a 1: qué tan seguro estás de que best_candidate_id es el mismo producto que el de la revista'),
  reason: z.string().describe('Justificación breve en español'),
});

const JUDGE_SYSTEM = `Sos un verificador de coincidencias de productos de limpieza/supermercado.
Te doy un producto leído de una revista y candidatos del catálogo que YA son de la misma marca.
Tu tarea: decidir si alguno es el MISMO producto, o si ninguno lo es.

Reglas:
- Devolvé best_candidate_id sólo si es el MISMO producto: misma línea/variante/tipo
  (ej. "lavandina en gel original" = "lavandina en gel original").
- Una diferencia de tamaño/presentación (510ml vs 500ml, 1L vs 900ml) NO descarta el match:
  sólo baja un poco la confianza. El tamaño es lo ÚNICO en lo que sos flexible.
- Si es un TIPO de producto distinto aunque sea la misma marca
  (ej. "CIF Lustramuebles" vs "CIF Limpiador Baño", o "Ayudín Lavandina" vs "Ayudín Quitamanchas"),
  devolvé best_candidate_id = null: NO es el mismo producto.
- Si ninguno es el mismo producto, devolvé null. Es totalmente esperable y correcto:
  la mayoría de los productos de la revista NO están en este catálogo.
- confidence: 0.9+ mismo producto casi idéntico; 0.6-0.8 mismo producto con dudas de tamaño/formato;
  <0.3 producto distinto.`;

export interface MatchResult {
  item: ExtractedProduct;
  page: number;
  method: 'ean' | 'llm' | 'none';
  matched: CatalogProduct | null;
  confidence: number;
  reason: string;
  candidates: CatalogProduct[];
}

export async function matchItem(
  item: ExtractedProduct,
  page: number,
  index: CatalogIndex,
  topK = 8,
): Promise<MatchResult> {
  // 1) EAN exacto (gratis)
  if (item.ean) {
    const hit = index.byEan.get(item.ean.replace(/\D/g, ''));
    if (hit) {
      return {
        item, page, method: 'ean', matched: hit, confidence: 1,
        reason: 'EAN idéntico', candidates: [hit],
      };
    }
  }

  // 2) Retrieval por embeddings → top-K candidatos
  const [queryEmb] = await embedBatch([itemText(item)]);
  const scored = index.products
    .map((p, i) => ({ p, score: cosine(queryEmb, index.embeddings[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  let candidates = scored.map((s) => s.p);

  // 2b) Filtro de marca (determinístico): la marca es el discriminador. Si el item trae marca,
  // sólo dejamos candidatos de esa misma marca → mata los falsos positivos cross-marca antes del juez.
  if (item.brand && normalizeText(item.brand)) {
    const sameBrand = candidates.filter((c) => brandMatches(item.brand!, c));
    if (sameBrand.length === 0) {
      return {
        item, page, method: 'none', matched: null, confidence: 0,
        reason: `Sin candidatos de la marca "${item.brand}" en el catálogo`, candidates,
      };
    }
    candidates = sameBrand;
  }

  // 3) Juez LLM
  const candidateList = candidates
    .map((c) => `- id=${c.id} | marca=${c.brand ?? '?'} | ${c.name} | cant=${c.quantity ?? '?'} | ean=${c.ean ?? '?'}`)
    .join('\n');

  const completion = await client.beta.chat.completions.parse({
    model: config.judgeModel,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: `PRODUCTO DE LA REVISTA:
marca=${item.brand ?? '?'} | ${item.name} | cant=${item.quantity ?? '?'} | ean=${item.ean ?? '?'}

CANDIDATOS DEL CATÁLOGO:
${candidateList || '(sin candidatos)'}`,
      },
    ],
    response_format: zodResponseFormat(Judgement, 'judgement'),
  });

  const j = completion.choices[0]?.message.parsed;
  const best = j?.best_candidate_id
    ? candidates.find((c) => c.id === j.best_candidate_id) ?? null
    : null;
  const confidence = j?.confidence ?? 0;

  // Ruteo por umbral (lo decidimos nosotros, no el modelo):
  // hay candidato con confianza suficiente → va a la cola de revisión; si no → no_match.
  if (best && confidence >= config.matchThreshold) {
    // Guardia para items SIN marca legible: sin el ancla de marca, el juez a veces acepta
    // productos de tipo totalmente distinto (ej. "Aceite" → "Lavandina"). Exigimos al menos
    // una palabra de contenido en común con el candidato; si no, descartamos.
    const hasBrand = !!(item.brand && normalizeText(item.brand));
    if (!hasBrand) {
      const itemTok = contentTokens(item.name);
      const candTok = contentTokens(`${best.brand ?? ''} ${best.name}`);
      const overlap = [...itemTok].some((t) => candTok.has(t));
      if (!overlap) {
        return {
          item, page, method: 'none', matched: null, confidence,
          reason: `Sin marca y sin palabras en común con "${best.name}" → descartado`, candidates,
        };
      }
    }
    return { item, page, method: 'llm', matched: best, confidence, reason: j?.reason ?? '', candidates };
  }

  return {
    item, page, method: 'none', matched: null,
    confidence, reason: j?.reason ?? 'Sin coincidencia suficiente', candidates,
  };
}
