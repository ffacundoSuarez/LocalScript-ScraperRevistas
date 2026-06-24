import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getSupermarket } from './supermarkets.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface PdfLink {
  url: string;
  filename: string;
}

function toPdfLink(url: string): PdfLink {
  return { url, filename: decodeURIComponent(path.basename(new URL(url).pathname)) };
}

/**
 * Folletos MOSTRADOS: anchors que tienen un .pdf y un `data-name`. Sirve para sitios (ej. Vital)
 * que embeben además los PDFs de TODAS las sucursales en un dump oculto; nos quedamos sólo con los
 * que la página efectivamente muestra (una localidad), deduplicando por `data-name`.
 */
function findDisplayedFolletos(html: string, base: string): PdfLink[] {
  const byName = new Map<string, PdfLink>();
  const anchorRe = /<a\b([^>]*)>/gi;
  let a: RegExpExecArray | null;
  while ((a = anchorRe.exec(html)) !== null) {
    const attrs = a[1];
    const name = attrs.match(/data-name="([^"]+)"/i)?.[1];
    const pdf = attrs.match(/(https?:\/\/[^"'\s]+?\.pdf)/i)?.[1];
    if (!name || !pdf) continue;
    try {
      if (!byName.has(name)) byName.set(name, toPdfLink(new URL(pdf, base).href));
    } catch {
      /* URL inválida → ignorar */
    }
  }
  return [...byName.values()];
}

/** Baja el HTML de la página de ofertas y extrae los links a PDFs. */
export async function findPdfLinks(offersUrl: string): Promise<PdfLink[]> {
  const res = await fetch(offersUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`No pude leer ${offersUrl}: HTTP ${res.status}`);
  const html = await res.text();

  // 1) Si la página marca los folletos mostrados con data-name (Vital), usamos sólo esos.
  const displayed = findDisplayedFolletos(html, offersUrl);
  if (displayed.length > 0) return displayed;

  // 2) Si no, agarramos todos los .pdf del HTML (Makro: links directos al CDN).
  const found = new Set<string>();
  const re = /['"(]([^'"()\s]+?\.pdf)(?:\?[^'"()\s]*)?['")]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      found.add(new URL(m[1], offersUrl).href);
    } catch {
      /* URL inválida → ignorar */
    }
  }
  return [...found].map(toPdfLink);
}

/** Descarga un PDF a destDir con su nombre original. Si ya existe, lo saltea. Devuelve la ruta local. */
export async function downloadPdf(link: PdfLink, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, link.filename);
  if (existsSync(dest)) {
    console.log(`  · ya existe, salteo: ${link.filename}`);
    return dest;
  }
  const res = await fetch(link.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`No pude descargar ${link.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`  ✓ ${link.filename} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  return dest;
}

/** Busca y descarga todas las revistas PDF de un super. Devuelve las rutas locales. */
export async function downloadMagazines(superId: string): Promise<string[]> {
  const sm = getSupermarket(superId);
  if (!sm.offersUrl) {
    throw new Error(`El super "${superId}" (estrategia ${sm.strategy}) no tiene offersUrl con PDFs directos.`);
  }
  console.log(`Buscando PDFs en ${sm.offersUrl} ...`);
  const links = await findPdfLinks(sm.offersUrl);
  if (links.length === 0) {
    console.warn(`⚠️  No encontré PDFs en ${sm.offersUrl}.`);
    return [];
  }
  console.log(`Encontrados ${links.length} PDF(s):`);
  for (const l of links) console.log(`  - ${l.filename}`);

  const destDir = path.resolve('data', 'pdfs', superId);
  const paths: string[] = [];
  for (const link of links) paths.push(await downloadPdf(link, destDir));
  return paths;
}

// CLI: `npx tsx src/download.ts --super=makro` → sólo descarga (para probar la descarga aislada).
if (process.argv[1]?.endsWith('download.ts')) {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--super='));
  const superId = arg?.split('=')[1];
  if (!superId) {
    console.error('Uso: npx tsx src/download.ts --super=<nombre>');
    process.exit(1);
  }
  downloadMagazines(superId)
    .then((paths) => console.log(`\n✅ ${paths.length} PDF(s) en data/pdfs/${superId}/\n`))
    .catch((err) => {
      console.error('❌ Error:', err.message);
      process.exit(1);
    });
}
