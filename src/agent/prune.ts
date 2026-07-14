// Transcript pruning. crablite injects identity/memory via the system prompt,
// so the transcript is pure conversation — we simply keep the most recent items
// that fit a char budget, without leaving orphan tool outputs (which the
// Responses API rejects). Cheaper than LLM compaction (see openclaw_research §3).

import type { ResponseItem } from "../codex/responses.js";

const DEFAULT_BUDGET_CHARS = 120_000; // ~30k tokens
export const FLUSH_TRIGGER_CHARS = 90_000; // flush durable facts before we drop context
export const FLUSH_MIN_GROWTH_CHARS = 40_000; // re-flush only after this much new growth

export function estimateChars(items: ResponseItem[]): number {
  let total = 0;
  for (const item of items) total += estimateItem(item);
  return total;
}

function estimateItem(item: ResponseItem): number {
  try {
    return JSON.stringify(item).length;
  } catch {
    return 0;
  }
}

export function pruneForContext(items: ResponseItem[], budgetChars = DEFAULT_BUDGET_CHARS): ResponseItem[] {
  if (estimateChars(items) <= budgetChars) return items;

  const kept: ResponseItem[] = [];
  let size = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const s = estimateItem(item);
    if (size + s > budgetChars && kept.length) break;
    kept.unshift(item);
    size += s;
  }

  // Drop leading tool items so we never keep a function_call_output whose
  // matching function_call was pruned away.
  while (kept.length && kept[0]?.type !== "message") kept.shift();

  // Always retain the first message as the conversation anchor (design D12).
  const anchor = items.find((it) => it.type === "message");
  if (anchor && !kept.includes(anchor)) {
    kept.unshift(anchor);
  }
  return kept;
}
