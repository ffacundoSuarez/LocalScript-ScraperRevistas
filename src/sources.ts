import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSupermarket } from './supermarkets.js';
import { findPdfLinks, downloadPdf } from './download.js';
import { renderPdfToImages } from './render.js';
import { pdfHash } from './store.js';
import { fetchRetry } from './retry.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Una revista = un set de imágenes de página. PDFs y flipbooks se unifican acá. */
export interface MagazineSource {
  id: string; // hash estable (para ids de items y subcarpeta de PNGs)
  label: string; // nombre legible de la revista
  pages: Buffer[]; // imágenes de página (PNG/JPEG/WebP)
  firstPage: number; // nº real de la 1ª página de `pages` (1-based; >1 si se pidió un rango)
}

/** Selección de páginas a procesar (1-based, inclusiva). `--pages=N` → {start:1,end:N}; `--pages=A-B` → {start:A,end:B}. */
export interface PageSelection {
  start: number;
  end?: number;
}

/** Recorta una lista a la selección pedida y devuelve también el nº real de la 1ª página. */
function applySelection<T>(all: T[], sel?: PageSelection): { items: T[]; firstPage: number } {
  if (!sel) return { items: all, firstPage: 1 };
  const start = Math.max(1, sel.start);
  const end = sel.end ?? all.length;
  return { items: all.slice(start - 1, end), firstPage: start };
}

function idFromString(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/** Convierte un PDF local en un source (render → imágenes). */
export async function pdfFileSource(pdfPath: string, sel?: PageSelection): Promise<MagazineSource> {
  const buf = await readFile(pdfPath);
  const all = await renderPdfToImages(pdfPath);
  const { items: pages, firstPage } = applySelection(all, sel);
  return { id: pdfHash(pdfPath, buf), label: path.basename(pdfPath), pages, firstPage };
}

/** Estrategia html-pdf-links: baja todos los PDFs de la página de ofertas y los renderiza. */
async function pdfLinkSources(superId: string, sel?: PageSelection): Promise<MagazineSource[]> {
  const sm = getSupermarket(superId);
  const links = await findPdfLinks(sm.offersUrl!);
  console.log(`Encontrados ${links.length} PDF(s).`);
  const destDir = path.resolve('data', 'pdfs', superId);
  const out: MagazineSource[] = [];
  for (const link of links) {
    const localPath = await downloadPdf(link, destDir);
    out.push(await pdfFileSource(localPath, sel));
  }
  return out;
}

/**
 * Descubre la URL del libro PubHTML5 vigente desde una página (ej. la home del super), que es donde
 * el super linkea el flipbook del período actual. Así NO hardcodeamos el libro: cuando publican uno
 * nuevo, lo tomamos solo. Cae a `fallback` (la URL configurada) si no aparece o la página falla.
 */
async function discoverPubhtml5Url(offersUrl: string, fallback?: string): Promise<string> {
  try {
    const html = await (await fetchRetry(offersUrl, { headers: { 'User-Agent': UA } }, offersUrl)).text();
    const m = html.match(/https?:\/\/[a-z0-9-]*\.?pubhtml5\.com\/[a-z0-9]+\/[a-z0-9]+\/?/i);
    if (m) {
      const url = m[0].endsWith('/') ? m[0] : `${m[0]}/`;
      console.log(`PubHTML5 descubierto en ${offersUrl}: ${url}`);
      return url;
    }
    console.warn(`⚠️  No encontré flipbook PubHTML5 en ${offersUrl}.`);
  } catch (err) {
    console.warn(`⚠️  No pude leer ${offersUrl} (${(err as Error).message}).`);
  }
  if (fallback) {
    console.warn(`   Uso la URL configurada de fallback: ${fallback}`);
    return fallback;
  }
  throw new Error(`No pude descubrir el flipbook PubHTML5 desde ${offersUrl} y no hay fallback.`);
}

/** Estrategia pubhtml5: parsea el config.js del flipbook y baja las imágenes de página (WebP). */
async function pubhtml5Source(bookUrl: string, sel?: PageSelection): Promise<MagazineSource> {
  const cfgUrl = new URL('javascript/config.js', bookUrl).href;
  const res = await fetchRetry(cfgUrl, { headers: { 'User-Agent': UA } }, cfgUrl);
  if (!res.ok) throw new Error(`No pude leer config PubHTML5 (${cfgUrl}): HTTP ${res.status}`);
  const cfg = await res.text();

  const title = cfg.match(/"title":"([^"]*)"/)?.[1] ?? 'Revista';
  // Cada página trae "n":["<hash>.webp"] en orden. Conservamos el orden (NO deduplicar).
  const allFiles = [...cfg.matchAll(/"n":\[([^\]]*)\]/g)]
    .map((m) => m[1].match(/[a-f0-9]{32}\.webp/i)?.[0])
    .filter((f): f is string => Boolean(f));
  if (allFiles.length === 0) throw new Error('No encontré imágenes de página en el config de PubHTML5.');
  console.log(`PubHTML5 "${title}": ${allFiles.length} páginas.`);
  const { items: files, firstPage } = applySelection(allFiles, sel);
  if (files.length === 0) throw new Error(`El rango pedido no cae dentro de las ${allFiles.length} páginas.`);

  const pages: Buffer[] = [];
  for (const f of files) {
    const u = new URL(`files/large/${f}`, bookUrl).href;
    const r = await fetchRetry(u, { headers: { 'User-Agent': UA, Referer: bookUrl } }, f);
    if (!r.ok) throw new Error(`No pude bajar la página ${f}: HTTP ${r.status}`);
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  return { id: idFromString(bookUrl), label: title, pages, firstPage };
}

/**
 * Estrategia publuu (Comodín): el visor Publuu firma el PDF, pero sus imágenes de página están en
 * CloudFront SIN firma con un patrón predecible. Usamos Playwright SÓLO para descubrir el patrón de
 * URL vigente (host + segmento, que cambian por período) y después bajamos todas las páginas con
 * fetch plano en alta resolución (_1200). Navegador mínimo, descarga liviana.
 */
async function publuuSource(offersUrl: string, sel?: PageSelection): Promise<MagazineSource> {
  // 1) Flipbook vigente desde la página de Comodín (browser-free).
  const html = await (await fetchRetry(offersUrl, { headers: { 'User-Agent': UA } }, offersUrl)).text();
  const fb = html.match(/publuu\.com\/flip-book\/(\d+)\/(\d+)/i);
  if (!fb) throw new Error(`No encontré el flipbook Publuu en ${offersUrl}.`);
  const embed = `https://publuu.com/flip-book/${fb[1]}/${fb[2]}/page/1?embed`;

  // 2) Descubrir el patrón de imagen con Playwright (carga el visor y captura una request de página).
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let template: string | null = null; // ".../txt/<fb>" sin el sufijo _<pág>_<ancho>.webp
  try {
    const page = await (await browser.newContext({ userAgent: UA })).newPage();
    page.on('request', (req) => {
      const m = req.url().match(/^(https?:\/\/[^/]+\/\d+\/\d+\/\d+\/txt\/\d+)_\d+_\d+\.webp/i);
      if (m && !template) template = m[1];
    });
    await page.goto(embed, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
  } finally {
    await browser.close();
  }
  if (!template) throw new Error('No pude descubrir las imágenes del flipbook Publuu.');

  // 3) Bajar páginas <template>_<n>_1200.webp (alta resolución) desde la 1ª pedida hasta que una
  //    falle (404 = fin de la revista) o se llegue al final del rango.
  const firstPage = Math.max(1, sel?.start ?? 1);
  const lastPage = sel?.end ?? 500;
  const pages: Buffer[] = [];
  for (let p = firstPage; p <= lastPage; p++) {
    const r = await fetchRetry(`${template}_${p}_1200.webp`, { headers: { 'User-Agent': UA } }, `publuu pág. ${p}`);
    if (!r.ok) break;
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  if (pages.length === 0) throw new Error('No bajé ninguna página del flipbook Publuu (¿rango fuera de la revista?).');
  console.log(`Publuu: ${pages.length} páginas bajadas (desde la ${firstPage}).`);

  return { id: idFromString(embed), label: `Comodín revista ${fb[2]}`, pages, firstPage };
}

/** Devuelve todas las revistas de un super (descargando lo que haga falta). */
export async function getMagazines(superId: string, sel?: PageSelection): Promise<MagazineSource[]> {
  const sm = getSupermarket(superId);
  switch (sm.strategy) {
    case 'html-pdf-links':
      return pdfLinkSources(superId, sel);
    case 'pubhtml5': {
      // Si el super tiene offersUrl (su home), descubrimos el libro vigente ahí y usamos
      // pubhtml5Url sólo como fallback. Así el flipbook se re-descubre cada período.
      const bookUrl = sm.offersUrl
        ? await discoverPubhtml5Url(sm.offersUrl, sm.pubhtml5Url)
        : sm.pubhtml5Url!;
      return [await pubhtml5Source(bookUrl, sel)];
    }
    case 'publuu':
      return [await publuuSource(sm.offersUrl!, sel)];
    default:
      throw new Error(`Estrategia no soportada: ${sm.strategy}`);
  }
}
