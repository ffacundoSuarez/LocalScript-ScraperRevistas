import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SUPERMARKETS } from './supermarkets.js';
import { superDir, type ReviewItem } from './store.js';

/**
 * Genera docs/OUTPUTS-FOLLETOS.md: el resultado del lector de revistas, **item por item**,
 * incluyendo los que NO matchearon. Solo LEE all.json (el dump completo de cada super) — no toca
 * el pipeline ni paga nada, así que se puede re-correr gratis para iterar el formato.
 *
 * Uso: npx tsx src/report.ts
 */

const OUT = path.resolve('docs', 'OUTPUTS-FOLLETOS.md');

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

const money = (n: number | null): string | null =>
  n === null || n === undefined ? null : `$${n.toLocaleString('es-AR')}`;

/** Limpia un valor de texto extraído por visión: descarta ruido ("null", ".", "/", solo símbolos). */
function clean(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  // núcleo sin símbolos de borde: descarta ": null", ".", "/", "null", etc.
  const core = t.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9]+$/i, '');
  if (!core || /^(null|undefined)$/i.test(core)) return '';
  return t;
}

const dash = (s: string | null | undefined): string => clean(s) || '—';

/** idx que va al final del id `<hash>-p<page>-<idx>`, para ordenar dentro de la página. */
function idIndex(id: string): number {
  const m = id.match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

async function loadAll(superId: string): Promise<ReviewItem[] | null> {
  const file = path.join(superDir(superId), 'all.json');
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8')) as ReviewItem[];
}

/** Línea de precio: "Precio: $X · Promo: $Y (texto)". Omite las partes que no hay. */
function priceLine(it: ReviewItem['extracted']): string | null {
  const parts: string[] = [];
  const p = money(it.price);
  const pp = money(it.promo_price);
  if (p) parts.push(`Precio: ${p}`);
  if (pp) parts.push(`Promo: ${pp}${it.promo_text ? ` (${it.promo_text})` : ''}`);
  else if (it.promo_text) parts.push(`Promo: ${it.promo_text}`);
  return parts.length ? parts.join(' · ') : null;
}

/** Bloque detallado para un item CON match. */
function matchBlock(it: ReviewItem): string {
  const e = it.extracted;
  const m = it.proposed_match!;
  const conf = `${Math.round(it.confidence * 100)}%`;
  const label = [clean(e.brand), e.name].filter(Boolean).join(' ');
  const lines: string[] = [];
  lines.push(`### ✅ pág. ${it.page} · ${label}`.trimEnd());
  lines.push('');
  lines.push(`**Leído de la revista:** ${e.name}`);
  lines.push('');
  lines.push(`- Marca: ${dash(e.brand)} · Cantidad: ${dash(e.quantity)} · EAN: ${dash(e.ean)}`);
  const pl = priceLine(e);
  if (pl) lines.push(`- ${pl}`);
  lines.push('');
  lines.push(`**Match propuesto del catálogo** (confianza ${conf} · método \`${it.method}\`):`);
  lines.push('');
  const catEan = m.ean ? ` · EAN ${m.ean}` : '';
  lines.push(`- ${m.name} · marca ${dash(m.brand)}${catEan}`);
  if (it.reason) lines.push(`- _Por qué:_ ${it.reason}`);
  return lines.join('\n');
}

/** Una línea para un item SIN match. */
function noMatchLine(it: ReviewItem): string {
  const e = it.extracted;
  const label = [clean(e.brand), e.name].filter(Boolean).join(' ');
  const reason = it.reason ? ` · _${it.reason}_` : '';
  return `- ❌ pág. ${it.page} · **${label}** — no encontrado/matcheado${reason}`;
}

function superSection(name: string, items: ReviewItem[]): string {
  const sorted = [...items].sort((a, b) => a.page - b.page || idIndex(a.id) - idIndex(b.id));
  const matched = sorted.filter((it) => it.proposed_match !== null);
  const out: string[] = [];
  out.push(`## ${name}`);
  out.push('');
  out.push(`**${sorted.length} productos leídos** · ✅ ${matched.length} con match · ❌ ${sorted.length - matched.length} sin match`);
  out.push('');
  for (const it of sorted) {
    out.push(it.proposed_match !== null ? matchBlock(it) : noMatchLine(it));
    out.push('');
  }
  return out.join('\n');
}

async function main() {
  const sections: string[] = [];
  const summary: { name: string; total: number; matched: number; gen: string }[] = [];

  for (const sm of Object.values(SUPERMARKETS)) {
    const items = await loadAll(sm.id);
    if (!items || items.length === 0) continue;
    const matched = items.filter((it) => it.proposed_match !== null).length;
    // generated_at no vive en all.json; lo tomamos de review.json si está.
    let gen = '';
    const reviewFile = path.join(superDir(sm.id), 'review.json');
    if (existsSync(reviewFile)) {
      try {
        gen = fmtDate((JSON.parse(await readFile(reviewFile, 'utf8')) as { generated_at: string }).generated_at);
      } catch {
        /* sin fecha */
      }
    }
    summary.push({ name: sm.name, total: items.length, matched, gen });
    sections.push(superSection(sm.name, items));
  }

  const totalRead = summary.reduce((s, r) => s + r.total, 0);
  const totalMatched = summary.reduce((s, r) => s + r.matched, 0);

  const head: string[] = [];
  head.push('# Outputs de folletos — qué encontró el lector de revistas');
  head.push('');
  head.push('> Resultado del lector, **producto por producto**. Por cada item leído de la revista se');
  head.push('> indica si se encontró un match en el catálogo (con cuál y por qué hay confianza) o si no');
  head.push('> se encontró (con el motivo). La mayoría da "no encontrado" **correctamente**: el catálogo');
  head.push('> de esta prueba es **solo de limpieza** (~768 productos) y las revistas mayoristas traen de');
  head.push('> todo (alimentos, bebidas, electro…). Los conteos pueden variar un poco entre corridas');
  head.push('> porque la decisión final la toma un modelo de IA (juez).');
  head.push('');
  head.push('## Resumen');
  head.push('');
  head.push('| Super | Productos leídos | Con match | Sin match | Corrida |');
  head.push('|---|---:|---:|---:|---|');
  for (const r of summary) {
    head.push(`| ${r.name} | ${r.total.toLocaleString('es-AR')} | ${r.matched} | ${(r.total - r.matched).toLocaleString('es-AR')} | ${r.gen || '—'} |`);
  }
  head.push(`| **Total** | **${totalRead.toLocaleString('es-AR')}** | **${totalMatched}** | **${(totalRead - totalMatched).toLocaleString('es-AR')}** | |`);
  head.push('');
  head.push('---');
  head.push('');

  const md = head.join('\n') + sections.join('\n---\n\n') + '\n';
  await writeFile(OUT, md, 'utf8');
  console.log(`✓ ${OUT}`);
  console.log(`  ${summary.length} supers · ${totalRead} productos · ${totalMatched} con match.`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
