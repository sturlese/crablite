// The agent loop primitive: model → tools → model … until the model stops
// asking for tools. OpenClaw delegates this to the embedded "Pi" engine; since
// we only target the Codex Responses API, a small explicit loop is clearer.
//
// Returns the final assistant text plus every new transcript item produced
// (assistant messages, function calls, and function outputs) so the caller can
// persist them.

import {
  callModel,
  assistantItem,
  functionCallItem,
  functionOutputItem,
} from "../codex/responses.js";
import { toSchemas, type Tool, type ToolContext } from "./tools.js";
import { log } from "../logger.js";

export type LoopResult = { text: string; newItems: any[] };

export async function runAgentLoop(params: {
  model: string;
  instructions: string;
  input: any[];
  tools: Tool[];
  ctx: ToolContext;
  maxRounds: number;
  idleTimeoutMs: number;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<LoopResult> {
  const workingInput = [...params.input];
  const newItems: any[] = [];
  const schemas = toSchemas(params.tools);
  let finalText = "";

  for (let round = 0; round < params.maxRounds; round++) {
    const result = await callModel({
      model: params.model,
      instructions: params.instructions,
      input: workingInput,
      tools: schemas,
      onTextDelta: params.onTextDelta,
      idleTimeoutMs: params.idleTimeoutMs,
      signal: params.signal,
    });

    if (result.text) {
      const item = assistantItem(result.text);
      newItems.push(item);
      workingInput.push(item);
      finalText = result.text;
    }

    if (result.toolCalls.length === 0) break;

    for (const call of result.toolCalls) {
      const fc = functionCallItem(call);
      newItems.push(fc);
      workingInput.push(fc);

      const output = await executeTool(params.tools, call.name, call.arguments, params.ctx);

      const fo = functionOutputItem(call.callId, output);
      newItems.push(fo);
      workingInput.push(fo);
    }

    if (round === params.maxRounds - 1) {
      log.warn(`Agent hit maxRounds (${params.maxRounds}); stopping tool loop.`);
    }
  }

  return { text: finalText, newItems };
}

async function executeTool(tools: Tool[], name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `ERROR: unknown tool "${name}".`;
  let args: any = {};
  if (rawArgs && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return `ERROR: could not parse arguments for ${name}: ${rawArgs.slice(0, 200)}`;
    }
  }
  try {
    log.debug(`tool ${name}`, rawArgs.slice(0, 300));
    return await tool.execute(args, ctx);
  } catch (err) {
    return `ERROR in tool ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
