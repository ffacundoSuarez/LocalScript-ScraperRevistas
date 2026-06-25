# Ingesta de revistas por supermercado

Cómo el script obtiene las revistas/folletos de cada super. Cada uno publica distinto, así que hay
una **estrategia por super** (`src/supermarkets.ts` → campo `strategy`). Toda estrategia termina
produciendo lo mismo: una `MagazineSource` = `{ id, label, pages: Buffer[] }` (imágenes de página).
De ahí en adelante el pipeline es común (visión → match → cola de revisión).

Archivos clave:
- `src/supermarkets.ts` — config por super (URL + estrategia).
- `src/sources.ts` — `getMagazines(superId)`: descubre/descarga y devuelve las imágenes de página.
- `src/download.ts` — helpers de PDFs (`findPdfLinks`, `downloadPdf`).

---

## Resumen

| Super | Estrategia | Cómo se obtiene | Navegador |
|---|---|---|---|
| **Makro** | `html-pdf-links` | HTML estático con `<a href=...pdf>` directos a un CDN | No |
| **Vital** | `html-pdf-links` | HTML estático; se filtran los folletos **mostrados** (1 localidad) | No |
| **Rosental** | `pubhtml5` | Flipbook PubHTML5: se parsea `config.js` y se bajan las imágenes WebP | No |
| **Comodín** | `publuu` | Flipbook Publuu: Playwright descubre el patrón de imágenes, luego fetch plano | Sí (mínimo) |

---

## Makro — `html-pdf-links`
- Página: `https://makro.com.ar/ofertas/`
- El HTML linkea los PDFs directo a un CDN (b-cdn.net). Se bajan todos los `.pdf` de la página.
- `findPdfLinks` cae al modo "todos los .pdf" porque Makro NO usa anchors con `data-name`.

## Vital — `html-pdf-links` (con filtro de localidad)
- Página: `https://www.vital.com.ar/ofertas/`
- **Ojo:** el HTML embebe los folletos de **todas las sucursales** (~25 PDFs) en un dump oculto para
  el dropdown. Pero los folletos **realmente mostrados** (una localidad) están en anchors de compartir
  con atributo `data-name`. Como los productos son los mismos en todas las localidades, nos quedamos
  sólo con esos (7 folletos), deduplicando por `data-name`.
- Implementado en `findPdfLinks` → `findDisplayedFolletos`: si hay anchors con `.pdf` + `data-name`,
  usa sólo esos; si no, baja todos (caso Makro).

## Rosental — `pubhtml5`
- Revista: flipbook **PubHTML5** `https://online.pubhtml5.com/oggo/ignq/` (linkeado desde la home).
- El `config.js` del libro es público y trae el título, la cantidad de páginas y los nombres de las
  imágenes por página (`"n":["<hash>.webp"]`, en orden).
- Las imágenes grandes están en `<bookUrl>files/large/<hash>.webp`. Se bajan directo (sin navegador).
- ⚠️ Tiene **148 páginas** → en pruebas usar `--pages=N` para no gastar de más en visión.

## Comodín — `publuu`
- Página: `https://supermercadoscomodin.com/maxicomodin/` → embebe un flipbook **Publuu**
  (`publuu.com/flip-book/<acc>/<fb>`) que cambia cada período.
- El PDF de Publuu está firmado (CloudFront, `Key-Pair-Id`) → no se baja directo. **Pero** las
  imágenes de página están en CloudFront **sin firma**, con patrón predecible:
  `https://<host>/<acc>/<fb>/<seg>/txt/<fb>_<página>_1200.webp` (`_1200` es la máxima resolución).
- Como `host`/`seg` pueden rotar por período, se usa **Playwright sólo para descubrir el patrón
  vigente** (carga el visor y captura una request de imagen). Después se bajan todas las páginas con
  fetch plano hasta que una da 404/403 (las páginas son contiguas 1..N).
- Flujo: `/maxicomodin/` (browser-free) → flipbook actual → Playwright (descubrir patrón) → fetch imágenes.

---

## Agregar un super nuevo
1. Inspeccionar la página de ofertas con `curl` (no WebFetch: descarta el JS). Buscar `.pdf`, `iframe`,
   y plataformas de flipbook (`publuu`, `pubhtml5`, `issuu`, `anyflip`, `fliphtml5`, `3dissue`...).
2. Elegir/crear la `strategy` adecuada en `src/sources.ts` y agregar la config en `src/supermarkets.ts`.
3. Probar la descarga aislada y luego el pipeline con `--pages=2` (barato).

## Comandos
```bash
npx tsx src/run.ts --super=<makro|vital|rosental|comodin> --from-url [--pages=N]
npx tsx src/download.ts --super=<makro|vital>   # sólo descarga (supers con PDFs)
npx tsx src/review-server.ts                    # UI de revisión (selector de super)
```
