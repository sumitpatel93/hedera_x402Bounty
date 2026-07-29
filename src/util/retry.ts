export async function retry<T>(fn: () => Promise<T>, opts: { attempts?: number; delayMs?: number; isReady?: (result: T) => boolean } = {}): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 1500;
  let lastResult: T | undefined;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      lastResult = await fn();
      if (!opts.isReady || opts.isReady(lastResult)) return lastResult;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (lastResult !== undefined) return lastResult;
  throw lastError ?? new Error("retry: exhausted attempts with no result");
}
