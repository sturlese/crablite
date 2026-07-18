// Keyed async mutex — serialize async work by key (per chat, per file). Both the
// reactive path (handle.ts) and the proactive path (heartbeat.ts) route their
// per-chat turns through this so they never write the same session concurrently.
// Because every turn runs through here, the tails map is also the shutdown seam:
// drainLocks() awaits it to let in-flight work finish before the process exits.

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

/**
 * Await all in-flight and queued locked work, bounded by `timeoutMs`.
 * Resolves `true` once every tail has settled — including work queued while
 * draining (e.g. a deferred memory flush scheduled by a finishing turn) —
 * or `false` (never rejects) if the timeout fires with work still pending.
 * Graceful shutdown uses this: stop intake first, then drain, then exit.
 */
export function drainLocks(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.(); // never keep the (shutting-down) process alive
  });
  const drained = (async () => {
    // Tail promises never reject (withLock swallows settlement), so all() is
    // safe. Re-sweep: a settling task may have queued new work on the map.
    while (tails.size > 0) {
      await Promise.all([...tails.values()]);
    }
    return true;
  })();
  return Promise.race([drained, timedOut]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
