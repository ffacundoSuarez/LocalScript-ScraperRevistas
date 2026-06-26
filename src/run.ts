import path from 'node:path';
import { config } from './config.js';
import { getCatalog } from './products.js';
import { extractProductsFromPage } from './extract.js';
import { buildCatalogIndex, matchItems, type CatalogIndex } from './match.js';
import { savePages, writeQueue, reviewPath, loadExtraction, saveExtraction } from './store.js';
import { getMagazines, pdfFileSource, type MagazineSource, type PageSelection } from './sources.js';
import { mapPool } from './pool.js';

interface Args {
  pdfPath?: string;
  superName: string;
  pages?: PageSelection;
  refresh: boolean;
  fromUrl: boolean;
}

/** `--pages=N` → primeras N páginas; `--pages=A-B` → de la A a la B (inclusive, 1-based). */
function parsePages(v: string | undefined): PageSelection | undefined {
  if (!v || v === 'true') return undefined;
  const m = v.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) {
    console.error(`--pages inválido: "${v}". Usá N (primeras N) o A-B (rango).`);
    process.exit(1);
  }
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : undefined;
  if (b !== undefined && b < a) {
    console.error(`--pages inválido: el final (${b}) es menor que el inicio (${a}).`);
    process.exit(1);
  }
  return b !== undefined ? { start: a, end: b } : { start: 1, end: a };
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
    console.error('Uso: npx tsx src/run.ts <ruta.pdf> --super=makro [--pages=2|--pages=61-148] [--refresh]');
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
    pages: parsePages(flags.get('pages')),
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
  const first = source.firstPage;
  const last = first + source.pages.length - 1;
  console.log(`\n📄 ${source.label} (${source.pages.length} páginas${first > 1 ? `, ${first}–${last}` : ''})`);
  const pageImages = await savePages(superName, source.id, source.pages, first);

  // Extracción por página con persistencia incremental: si una corrida previa quedó a medias,
  // reanudamos y sólo pagamos visión por las páginas que faltan. Se keyea por nº REAL de página.
  const byPage = await loadExtraction(superName, source.id);
  const todo = source.pages
    .map((buf, i) => ({ buf, page: first + i }))
    .filter(({ page }) => !byPage.has(page));
  if (todo.length < source.pages.length) {
    console.log(`   ↻ reanudando: ${source.pages.length - todo.length} ya extraídas, faltan ${todo.length}.`);
  }
  // Concurrencia acotada para la visión; las escrituras del cache se serializan (mismo archivo).
  let saveChain: Promise<void> = Promise.resolve();
  await mapPool(todo, config.concurrency, async ({ buf, page }) => {
    byPage.set(page, await extractProductsFromPage(buf, page));
    saveChain = saveChain.then(() => saveExtraction(superName, source.id, byPage));
  });
  await saveChain; // flush final del cache

  const items: { item: Awaited<ReturnType<typeof extractProductsFromPage>>[number]; page: number }[] = [];
  for (let page = first; page <= last; page++) {
    for (const item of byPage.get(page) ?? []) items.push({ item, page });
  }
  console.log(`   ${items.length} productos extraídos. Matcheando...`);

  const results = await matchItems(items, index);

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
    ? await getMagazines(args.superName, args.pages)
    : [await pdfFileSource(args.pdfPath!, args.pages)];
  if (sources.length === 0) {
    console.error('No se obtuvo ninguna revista. Abortando.');
    process.exit(1);
  }

  console.log(`\n3) Procesando ${sources.length} revista(s)...`);
  for (const source of sources) {
    await processMagazine(args.superName, source, index);
  }

  console.log(`\n💾 Cola en ${reviewPath(args.superName)}`);
  console.log(`   Revisá en la UI:  npx tsx src/review-server.ts   (elegí el super en el selector)\n`);
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
