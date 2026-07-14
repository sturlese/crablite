// Autonomous subagents. `spawn_subagent` is a normal model-facing tool — the
// agent decides to delegate, no user command needed (OpenClaw: sessions_spawn).
// The child is an isolated run of the SAME loop with a subagent system prompt;
// its final message is returned to the parent. ACP and background/parallel
// children are intentionally dropped for the Lite version.

import { runAgentLoop } from "./loop.js";
import { CORE_TOOLS } from "./tools.js";
import type { Tool } from "./tool.js";
import { MEMORY_TOOLS } from "../memory/search.js";
import { userItem } from "../codex/responses.js";
import { log } from "../logger.js";

export function buildSubagentPrompt(depth: number, maxDepth: number): string {
  const lines = [
    "You are a SUBAGENT spawned to complete exactly one task.",
    "The task is in the first `[Subagent Task]` message.",
    "",
    "- Work autonomously with your tools. There is no user to ask — do not ask questions.",
    "- You can read/write memory and run commands, but you do NOT talk to the end user.",
    "- When finished, your FINAL message is returned verbatim to the agent that spawned you.",
    "  Make it a complete, self-contained result (findings, answer, or a summary of what you did).",
    "- Be focused and concise. Do not start unrelated work.",
  ];
  if (depth < maxDepth) {
    lines.push(
      "- For genuinely parallel or complex sub-work you may spawn your own subagents with a clear brief.",
    );
  }
  return lines.join("\n");
}

export function makeSpawnTool(opts: {
  model: string;
  maxDepth: number;
  idleTimeoutMs: number;
  maxRounds: number;
}): Tool {
  return {
    name: "spawn_subagent",
    description:
      "Delegate a bounded task to a fresh, isolated child agent that runs on its own and returns " +
      "its result to you. Use this for well-scoped sub-tasks (research, a multi-step chore) that " +
      "are cleaner in a separate context. Give a clear objective, inputs, and the expected output.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task brief for the child." },
        label: { type: "string", description: "Short label for logs (optional)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const childDepth = ctx.depth + 1;
      if (ctx.depth >= opts.maxDepth) {
        return "Cannot spawn: subagent depth limit reached. Do this task yourself.";
      }
      const task = String(args.task ?? "").trim();
      if (!task) return "ERROR: empty task.";
      log.info(`spawn_subagent (depth ${childDepth})`, String(args.label ?? task.slice(0, 60)));

      // Children get memory + core tools, but not `message` (no user), and only
      // get `spawn_subagent` if another level of depth remains.
      const childTools: Tool[] = [
        ...CORE_TOOLS.filter((t) => t.name !== "message"),
        ...MEMORY_TOOLS,
      ];
      if (childDepth < opts.maxDepth) childTools.push(makeSpawnTool(opts));

      const result = await runAgentLoop({
        model: opts.model,
        instructions: buildSubagentPrompt(childDepth, opts.maxDepth),
        input: [userItem(`[Subagent Task]\n${task}`)],
        tools: childTools,
        ctx: { workspaceDir: ctx.workspaceDir, depth: childDepth, signal: ctx.signal },
        maxRounds: opts.maxRounds,
        idleTimeoutMs: opts.idleTimeoutMs,
        signal: ctx.signal,
      });

      return result.text || "(subagent finished without producing output)";
    },
  };
}
