import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { fetchRetry } from './retry.js';

const CACHE_PATH = path.resolve('data', 'products.json');

/**
 * El esquema real del producto todavía no está confirmado, así que guardamos el
 * objeto crudo y exponemos una vista normalizada que "adivina" los campos comunes.
 * Cuando veamos la respuesta real, ajustamos `pick(...)` a los nombres exactos.
 */
export interface CatalogProduct {
  id: string;
  name: string;
  brand?: string;
  ean?: string;
  quantity?: string;
  raw: Record<string, unknown>;
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return undefined;
}

export function normalizeProduct(raw: Record<string, unknown>): CatalogProduct {
  return {
    id: pick(raw, ['id', 'product_id', 'sku', 'uuid', 'code']) ?? '',
    name: pick(raw, ['name', 'title', 'product_name', 'description', 'nombre']) ?? '',
    brand: pick(raw, ['brand', 'marca', 'brand_name', 'manufacturer']),
    ean: pick(raw, ['ean', 'barcode', 'gtin', 'ean13', 'codigo_barras', 'cod_barras']),
    quantity: pick(raw, [
      'quantity', 'size', 'content', 'presentation', 'unit', 'cantidad', 'contenido',
    ]),
    raw,
  };
}

/** El endpoint puede devolver un array directo o envolverlo en data/products/items/results. */
function extractArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === 'object') {
    for (const key of ['data', 'products', 'items', 'results']) {
      const value = (json as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return [];
}

interface PageResult {
  items: Record<string, unknown>[];
  totalPages: number;
}

/** La API pagina con `page` (1-based); `offset` lo ignora. El total real viene en pagination.totalPages. */
async function fetchPage(page: number, limit: number): Promise<PageResult> {
  const url = new URL(config.productsApiUrl);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));

  const res = await fetchRetry(url, { headers: { 'X-API-Key': config.productsApiKey } }, 'Products API');
  if (!res.ok) {
    throw new Error(`Products API ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const pagination = (json?.pagination ?? {}) as { totalPages?: number };
  return { items: extractArray(json), totalPages: pagination.totalPages ?? 1 };
}

/** Trae todo el catálogo recorriendo page = 1..totalPages. */
async function fetchAllProducts(): Promise<Record<string, unknown>[]> {
  const limit = 200; // máximo que acepta el endpoint
  const all: Record<string, unknown>[] = [];

  const first = await fetchPage(1, limit);
  all.push(...first.items);
  for (let page = 2; page <= first.totalPages; page++) {
    const { items } = await fetchPage(page, limit);
    all.push(...items);
    process.stdout.write(`  · traídos ${all.length} productos (página ${page}/${first.totalPages})...\r`);
  }
  process.stdout.write('\n');
  return all;
}

/**
 * Devuelve el catálogo, usando el cache local si existe (salvo forceRefresh).
 * Los productos no cambian seguido, así no re-pegamos al endpoint en cada corrida.
 */
export async function getCatalog(forceRefresh = false): Promise<CatalogProduct[]> {
  if (!forceRefresh && existsSync(CACHE_PATH)) {
    const cached = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as Record<string, unknown>[];
    return cached.map(normalizeProduct);
  }

  const raw = await fetchAllProducts();
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(raw, null, 2), 'utf8');
  return raw.map(normalizeProduct);
}

// CLI: `npm run products` → trae el catálogo y muestra 1 producto para confirmar el esquema real.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('products.ts')) {
  getCatalog(true)
    .then((products) => {
      console.log(`\n✅ Catálogo: ${products.length} productos cacheados en ${CACHE_PATH}\n`);
      if (products[0]) {
        console.log('Campos crudos del primer producto (para ajustar el matcher):');
        console.log(JSON.stringify(products[0].raw, null, 2));
        console.log('\nVista normalizada:');
        console.log(JSON.stringify({ ...products[0], raw: undefined }, null, 2));
      }
    })
    .catch((err) => {
      console.error('❌ Error trayendo el catálogo:', err.message);
      process.exit(1);
    });
}
