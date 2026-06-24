import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pdf } from 'pdf-to-img';

/**
 * Renderiza un PDF local a un PNG por página.
 * Usa pdf-to-img (pure-JS sobre pdfjs + @napi-rs/canvas prebuilt), así que NO
 * necesita compilar canvas nativo → anda en Windows sin dolores.
 *
 * @param scale factor de resolución; 2–3 da buena nitidez para que el modelo lea precios chicos.
 */
export async function renderPdfToImages(
  pdfPath: string,
  scale = 2.5,
): Promise<Buffer[]> {
  const document = await pdf(pdfPath, { scale });
  const pages: Buffer[] = [];
  for await (const page of document) {
    pages.push(page);
  }
  return pages;
}

// CLI: `npm run render -- <ruta.pdf>` → guarda los PNG en data/output/pages/ para inspeccionarlos.
if (process.argv[1]?.endsWith('render.ts')) {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Uso: npm run render -- <ruta-al-pdf>');
    process.exit(1);
  }
  const outDir = path.resolve('data', 'output', 'pages');
  renderPdfToImages(pdfPath)
    .then(async (pages) => {
      await mkdir(outDir, { recursive: true });
      for (let i = 0; i < pages.length; i++) {
        const file = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
        await writeFile(file, pages[i]);
      }
      console.log(`✅ ${pages.length} páginas renderizadas en ${outDir}`);
    })
    .catch((err) => {
      console.error('❌ Error renderizando el PDF:', err.message);
      process.exit(1);
    });
}
