import { describe, it, expect } from "vitest";
import { withLock } from "../src/util/lock.js";

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
