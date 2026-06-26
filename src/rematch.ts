import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getCatalog } from './products.js';
import { buildCatalogIndex, matchItems } from './match.js';
import type { ExtractedProduct } from './extract.js';
import { superDir, writeQueue, reviewPath, loadQueue } from './store.js';

/**
 * Re-corre SOLO el matching a partir de all.json (los productos ya extraídos por visión),
 * sin volver a renderizar ni llamar a GPT-4 Vision. Sirve para iterar el juez/umbral barato.
 * Maneja varias revistas por super agrupando por hash.
 *
 * Uso: npx tsx src/rematch.ts --super=<nombre>
 */
function parseSuper(): string {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--super='));
  const name = arg?.split('=')[1];
  if (!name) {
    console.error('Uso: npx tsx src/rematch.ts --super=<nombre>');
    process.exit(1);
  }
  return name;
}

interface AllItem {
  id: string;
  source_pdf: string;
  page: number;
  page_image: string;
  extracted: {
    name: string;
    brand: string | null;
    ean: string | null;
    price: number | null;
    promo_price: number | null;
    promo_text: string | null;
    quantity: string | null;
  };
}

async function main() {
  const supermarket = parseSuper();
  const allFile = path.join(superDir(supermarket), 'all.json');
  if (!existsSync(allFile)) {
    console.error(`❌ No existe ${allFile}. Corré primero el pipeline completo (run.ts).`);
    process.exit(1);
  }

  const all = JSON.parse(await readFile(allFile, 'utf8')) as AllItem[];
  console.log(`Re-match de ${supermarket}: ${all.length} productos ya extraídos (sin visión).`);

  const index = await buildCatalogIndex(await getCatalog());

  // agrupar por hash (cada revista) preservando el orden original
  const byHash = new Map<string, AllItem[]>();
  for (const it of all) {
    const hash = it.id.split('-')[0];
    (byHash.get(hash) ?? byHash.set(hash, []).get(hash)!).push(it);
  }

  for (const [hash, group] of byHash) {
    const pageImages = new Map<number, string>();
    for (const it of group) pageImages.set(it.page, it.page_image);

    const entries = group.map((it) => ({
      item: { ...it.extracted, confidence: 1 } as ExtractedProduct,
      page: it.page,
    }));
    const results = await matchItems(entries, index);
    await writeQueue(supermarket, group[0]?.source_pdf ?? 'unknown', results, hash, pageImages);
  }

  const queue = await loadQueue(supermarket);
  const items = queue?.items ?? [];
  console.log(`\n📊 ${items.length} matches propuestos en la cola.\n`);
  for (const it of items) {
    const conf = `${Math.round(it.confidence * 100)}%`.padStart(4);
    console.log(`  ✅ [${conf}] p${it.page} ${it.extracted.brand ?? ''} ${it.extracted.name}  →  ${it.proposed_match?.name}`);
  }
  console.log(`\n💾 Cola actualizada: ${reviewPath(supermarket)}\n`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
