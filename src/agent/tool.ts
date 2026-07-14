// The tool contract. A tool is a plain object with a JSON-Schema `parameters`
// and an async `execute`. Every tool provider (core tools, memory, reminders,
// subagent) implements this type; it lives apart from the concrete core tools
// so those modules can depend on the contract without pulling in exec/shell.

import type { ToolSchema } from "../codex/responses.js";

export type ToolContext = {
  workspaceDir: string;
  depth: number; // subagent depth (0 = main agent)
  chatId?: string;
  chatType?: "direct" | "group";
  chatReply?: (text: string) => Promise<void>;
  signal?: AbortSignal;
};

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any, ctx: ToolContext) => Promise<string>;
};

export function toSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
