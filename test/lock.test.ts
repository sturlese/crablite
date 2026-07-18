import { describe, it, expect } from "vitest";
import { withLock, drainLocks } from "../src/util/lock.js";

const delayed = (order: number[], n: number, ms: number) => () =>
  new Promise<void>((r) =>
    setTimeout(() => {
      order.push(n);
      r();
    }, ms),
  );

describe("withLock", () => {
  it("serializes tasks with the same key in submission order", async () => {
    const order: number[] = [];
    await Promise.all([
      withLock("k", delayed(order, 1, 30)),
      withLock("k", delayed(order, 2, 5)),
      withLock("k", delayed(order, 3, 1)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs different keys concurrently", async () => {
    const order: number[] = [];
    await Promise.all([withLock("a", delayed(order, 1, 30)), withLock("b", delayed(order, 2, 5))]);
    expect(order).toEqual([2, 1]);
  });

  it("does not deadlock the queue after a rejection", async () => {
    await expect(
      withLock("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withLock("k", async () => "ok")).resolves.toBe("ok");
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("drainLocks", () => {
  it("resolves true immediately when no locked work is pending", async () => {
    await expect(drainLocks(50)).resolves.toBe(true);
  });

  it("resolves true only once in-flight work has settled", async () => {
    const gate = deferred();
    const task = withLock("drain-a", () => gate.promise);
    let result: boolean | undefined;
    const drain = drainLocks(2_000).then((v) => {
      result = v;
      return v;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(result).toBeUndefined(); // still draining: the task has not settled
    gate.resolve();
    await expect(drain).resolves.toBe(true);
    await task;
  });

  it("awaits work queued during the drain by a finishing task", async () => {
    const first = deferred();
    const second = deferred();
    let followUp: Promise<void> | undefined;
    const firstTask = withLock("drain-b", async () => {
      await first.promise;
      // A finishing turn queues follow-up work on its own key — the
      // deferred-memory-flush pattern the drain must not orphan.
      followUp = withLock("drain-b", () => second.promise);
    });
    let result: boolean | undefined;
    const drain = drainLocks(2_000).then((v) => {
      result = v;
      return v;
    });
    first.resolve();
    await firstTask;
    await new Promise((r) => setTimeout(r, 20));
    expect(result).toBeUndefined(); // re-sweep found the queued follow-up
    second.resolve();
    await expect(drain).resolves.toBe(true);
    await followUp;
  });

  // KEEP THIS TEST LAST in the file: the never-settling task leaves a
  // permanent tail in the module-level lock map, so any withLock/drainLocks
  // use on it afterwards would hang until its own timeout.
  it("resolves false (never rejects) when the timeout fires with work still pending", async () => {
    void withLock("drain-timeout", () => new Promise<never>(() => {}));
    await expect(drainLocks(30)).resolves.toBe(false);
  });
});
