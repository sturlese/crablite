// Keyed async mutex — serialize async work by key (per chat, per file). Both the
// reactive path (handle.ts) and the proactive path (heartbeat.ts) route their
// per-chat turns through this so they never write the same session concurrently.

const tails = new Map<string, Promise<void>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run fn after the previous task settles (success OR failure — a failed prior
  // turn must not deadlock the queue).
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  // Bound the map: drop the key once this is the last queued task.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
