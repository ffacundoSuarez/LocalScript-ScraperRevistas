/**
 * Reintentos con backoff exponencial + jitter para llamadas transitorias (red / APIs de IA).
 * Reintenta sólo lo que tiene sentido reintentar: errores de red (sin `status`) y HTTP 429/5xx.
 * Los 4xx "de verdad" (400, 401, 404...) NO se reintentan: son fallas determinísticas.
 */
export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  label?: string;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function isRetriable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return true; // sin status → error de red/timeout → reintentable
  return status === 429 || status >= 500;
}

/** Si el error trae header Retry-After (429), respetarlo; si no, backoff exponencial con jitter. */
function waitMsFor(err: unknown, attempt: number, baseMs: number): number {
  const retryAfter = (err as { headers?: { get?: (k: string) => string | null } })?.headers?.get?.(
    'retry-after',
  );
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetriable(err)) throw err;
      const waitMs = waitMsFor(err, attempt, baseMs);
      const what = opts.label ? `${opts.label}: ` : '';
      console.warn(`  ⚠️  ${what}fallo transitorio, reintento ${attempt + 1}/${retries} en ${Math.round(waitMs)}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/**
 * `fetch` con reintentos. Reintenta en errores de red y en respuestas 429/5xx; cualquier otra
 * respuesta (incl. 404/403) se devuelve tal cual para que el llamador la maneje como hoy
 * (ej. el loop de Publuu corta en el primer 404). No cambia el contrato de `fetch`.
 */
export async function fetchRetry(
  url: string | URL,
  init?: RequestInit,
  label?: string,
): Promise<Response> {
  return withRetry(async () => {
    const res = await fetch(url, init);
    if (res.status === 429 || res.status >= 500) {
      const err = Object.assign(new Error(`HTTP ${res.status} en ${label ?? String(url)}`), {
        status: res.status,
        headers: res.headers,
      });
      throw err;
    }
    return res;
  }, { label: label ?? String(url) });
}
