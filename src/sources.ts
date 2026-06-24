import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSupermarket } from './supermarkets.js';
import { findPdfLinks, downloadPdf } from './download.js';
import { renderPdfToImages } from './render.js';
import { pdfHash } from './store.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Una revista = un set de imágenes de página. PDFs y flipbooks se unifican acá. */
export interface MagazineSource {
  id: string; // hash estable (para ids de items y subcarpeta de PNGs)
  label: string; // nombre legible de la revista
  pages: Buffer[]; // imágenes de página (PNG/JPEG/WebP)
}

function idFromString(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/** Convierte un PDF local en un source (render → imágenes). */
export async function pdfFileSource(pdfPath: string, maxPages?: number): Promise<MagazineSource> {
  const buf = await readFile(pdfPath);
  let pages = await renderPdfToImages(pdfPath);
  if (maxPages) pages = pages.slice(0, maxPages);
  return { id: pdfHash(pdfPath, buf), label: path.basename(pdfPath), pages };
}

/** Estrategia html-pdf-links: baja todos los PDFs de la página de ofertas y los renderiza. */
async function pdfLinkSources(superId: string, maxPages?: number): Promise<MagazineSource[]> {
  const sm = getSupermarket(superId);
  const links = await findPdfLinks(sm.offersUrl!);
  console.log(`Encontrados ${links.length} PDF(s).`);
  const destDir = path.resolve('data', 'pdfs', superId);
  const out: MagazineSource[] = [];
  for (const link of links) {
    const localPath = await downloadPdf(link, destDir);
    out.push(await pdfFileSource(localPath, maxPages));
  }
  return out;
}

/** Estrategia pubhtml5: parsea el config.js del flipbook y baja las imágenes de página (WebP). */
async function pubhtml5Source(bookUrl: string, maxPages?: number): Promise<MagazineSource> {
  const cfgUrl = new URL('javascript/config.js', bookUrl).href;
  const res = await fetch(cfgUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`No pude leer config PubHTML5 (${cfgUrl}): HTTP ${res.status}`);
  const cfg = await res.text();

  const title = cfg.match(/"title":"([^"]*)"/)?.[1] ?? 'Revista';
  // Cada página trae "n":["<hash>.webp"] en orden. Conservamos el orden (NO deduplicar).
  let files = [...cfg.matchAll(/"n":\[([^\]]*)\]/g)]
    .map((m) => m[1].match(/[a-f0-9]{32}\.webp/i)?.[0])
    .filter((f): f is string => Boolean(f));
  if (files.length === 0) throw new Error('No encontré imágenes de página en el config de PubHTML5.');
  console.log(`PubHTML5 "${title}": ${files.length} páginas.`);
  if (maxPages) files = files.slice(0, maxPages);

  const pages: Buffer[] = [];
  for (const f of files) {
    const u = new URL(`files/large/${f}`, bookUrl).href;
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: bookUrl } });
    if (!r.ok) throw new Error(`No pude bajar la página ${f}: HTTP ${r.status}`);
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  return { id: idFromString(bookUrl), label: title, pages };
}

/**
 * Estrategia publuu (Comodín): el visor Publuu firma el PDF, pero sus imágenes de página están en
 * CloudFront SIN firma con un patrón predecible. Usamos Playwright SÓLO para descubrir el patrón de
 * URL vigente (host + segmento, que cambian por período) y después bajamos todas las páginas con
 * fetch plano en alta resolución (_1200). Navegador mínimo, descarga liviana.
 */
async function publuuSource(offersUrl: string, maxPages?: number): Promise<MagazineSource> {
  // 1) Flipbook vigente desde la página de Comodín (browser-free).
  const html = await (await fetch(offersUrl, { headers: { 'User-Agent': UA } })).text();
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

  // 3) Bajar páginas <template>_<n>_1200.webp (alta resolución) hasta que una falle.
  const pages: Buffer[] = [];
  for (let p = 1; p <= 500; p++) {
    if (maxPages && pages.length >= maxPages) break;
    const r = await fetch(`${template}_${p}_1200.webp`, { headers: { 'User-Agent': UA } });
    if (!r.ok) break;
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  if (pages.length === 0) throw new Error('No bajé ninguna página del flipbook Publuu.');
  console.log(`Publuu: ${pages.length} páginas bajadas.`);

  return { id: idFromString(embed), label: `Comodín revista ${fb[2]}`, pages };
}

/** Devuelve todas las revistas de un super (descargando lo que haga falta). */
export async function getMagazines(superId: string, maxPages?: number): Promise<MagazineSource[]> {
  const sm = getSupermarket(superId);
  switch (sm.strategy) {
    case 'html-pdf-links':
      return pdfLinkSources(superId, maxPages);
    case 'pubhtml5':
      return [await pubhtml5Source(sm.pubhtml5Url!, maxPages)];
    case 'publuu':
      return [await publuuSource(sm.offersUrl!, maxPages)];
    default:
      throw new Error(`Estrategia no soportada: ${sm.strategy}`);
  }
}
