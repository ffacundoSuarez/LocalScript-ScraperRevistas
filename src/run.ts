import path from 'node:path';
import { getCatalog } from './products.js';
import { extractProductsFromPage } from './extract.js';
import { buildCatalogIndex, matchItem, type CatalogIndex, type MatchResult } from './match.js';
import { savePages, writeQueue, reviewPath } from './store.js';
import { getMagazines, pdfFileSource, type MagazineSource } from './sources.js';

interface Args {
  pdfPath?: string;
  superName: string;
  maxPages?: number;
  refresh: boolean;
  fromUrl: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Map<string, string>();
  for (const a of argv.filter((a) => a.startsWith('--'))) {
    const [k, v] = a.replace(/^--/, '').split('=');
    flags.set(k, v ?? 'true');
  }
  const pdfPath = positional[0];
  const fromUrl = flags.has('from-url');
  const superName = flags.get('super') ?? (pdfPath ? path.parse(pdfPath).name : undefined);

  if (!fromUrl && !pdfPath) {
    console.error('Uso: npx tsx src/run.ts <ruta.pdf> --super=makro [--pages=2] [--refresh]');
    console.error('  o: npx tsx src/run.ts --super=makro --from-url   (descarga + procesa)');
    process.exit(1);
  }
  if (!superName) {
    console.error('Falta --super=<nombre> (requerido con --from-url).');
    process.exit(1);
  }
  return {
    pdfPath,
    superName,
    maxPages: flags.has('pages') ? Number(flags.get('pages')) : undefined,
    refresh: flags.has('refresh'),
    fromUrl,
  };
}

/** Procesa una revista (set de imágenes): guarda PNGs → extracción visión → match → escribe cola. */
async function processMagazine(
  superName: string,
  source: MagazineSource,
  index: CatalogIndex,
): Promise<void> {
  console.log(`\n📄 ${source.label} (${source.pages.length} páginas)`);
  const pageImages = await savePages(superName, source.id, source.pages);

  const items: { item: Awaited<ReturnType<typeof extractProductsFromPage>>[number]; page: number }[] = [];
  for (let i = 0; i < source.pages.length; i++) {
    const products = await extractProductsFromPage(source.pages[i], i + 1);
    for (const item of products) items.push({ item, page: i + 1 });
  }
  console.log(`   ${items.length} productos extraídos. Matcheando...`);

  const results: MatchResult[] = [];
  for (const { item, page } of items) results.push(await matchItem(item, page, index));

  const matched = results.filter((r) => r.matched).length;
  const queue = await writeQueue(superName, source.label, results, source.id, pageImages);
  console.log(`   ✓ ${matched}/${results.length} con match. Cola total del super: ${queue.items.length}.`);
}

async function main() {
  const args = parseArgs();
  console.log(`\n🏪 ScraperRevistas — super: ${args.superName}\n`);

  console.log('1) Cargando catálogo...');
  const index = await buildCatalogIndex(await getCatalog(args.refresh));
  console.log(`   ${index.products.length} productos.`);

  console.log(args.fromUrl ? '\n2) Obteniendo revistas...' : '\n2) Cargando PDF local...');
  const sources = args.fromUrl
    ? await getMagazines(args.superName, args.maxPages)
    : [await pdfFileSource(args.pdfPath!, args.maxPages)];
  if (sources.length === 0) {
    console.error('No se obtuvo ninguna revista. Abortando.');
    process.exit(1);
  }

  console.log(`\n3) Procesando ${sources.length} revista(s)...`);
  for (const source of sources) {
    await processMagazine(args.superName, source, index);
  }

  console.log(`\n💾 Cola en ${reviewPath(args.superName)}`);
  console.log(`   Revisá en la UI:  npx tsx src/review-server.ts --super=${args.superName}\n`);
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
