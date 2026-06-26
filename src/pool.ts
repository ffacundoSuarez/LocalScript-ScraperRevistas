/**
 * Corre `fn` sobre `items` con concurrencia acotada a `limit`, **preservando el orden** de entrada
 * en el resultado (results[i] corresponde a items[i]). Clave para que los ids de la cola
 * (`hash-p<page>-<idx>`, que dependen del orden) queden estables aunque las tareas terminen
 * desordenadas.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
