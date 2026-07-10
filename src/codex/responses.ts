// Codex Responses API client — the model transport.
//
// Talks to the ChatGPT-subscription-backed Codex endpoint (same as the OpenAI
// Codex CLI): https://chatgpt.com/backend-api/codex/responses, using the OpenAI
// Responses API request/stream shape. Streaming is Server-Sent Events.
//
// If OpenAI changes the private contract, this is the ONLY file to adjust; every
// header/field is here and overridable via env for troubleshooting.

import crypto from "node:crypto";
import { getAccessToken, USER_AGENT, ORIGINATOR } from "./auth.js";
import { log } from "../logger.js";

export const CODEX_BASE_URL =
  process.env.CRABLITE_CODEX_BASE_URL?.trim() || "https://chatgpt.com/backend-api/codex";

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
};

export type ToolCall = { callId: string; name: string; arguments: string };

export type ModelResult = {
  text: string;
  toolCalls: ToolCall[];
};

// --- Responses API input-item builders --------------------------------------

export function userItem(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/** A user message with mixed content parts (text + input_image). */
export function userItemWithParts(parts: any[]) {
  return { type: "message", role: "user", content: parts };
}

/** An input_image content part from raw bytes (base64 data URI). */
export function imagePart(data: Buffer, mimetype: string) {
  return { type: "input_image", image_url: `data:${mimetype || "image/jpeg"};base64,${data.toString("base64")}` };
}

export function assistantItem(text: string) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

export function functionCallItem(call: ToolCall) {
  return { type: "function_call", name: call.name, arguments: call.arguments, call_id: call.callId };
}

export function functionOutputItem(callId: string, output: string) {
  return { type: "function_call_output", call_id: callId, output };
}

// --- The call ---------------------------------------------------------------

export async function callModel(params: {
  model: string;
  instructions: string;
  input: any[];
  tools: ToolSchema[];
  onTextDelta?: (delta: string) => void;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ModelResult> {
  const { access, accountId } = await getAccessToken();

  const body = {
    model: params.model,
    instructions: params.instructions,
    input: params.input,
    tools: params.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    })),
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: ORIGINATOR,
    "User-Agent": USER_AGENT,
    "OpenAI-Beta": "responses=experimental",
    session_id: crypto.randomUUID(),
  };
  if (accountId) requestHeaders["ChatGPT-Account-Id"] = accountId;

  // Idle-timeout: abort if the stream stalls with no token for too long.
  const idleMs = params.idleTimeoutMs ?? 120_000;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort);
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error("model idle timeout")), idleMs);
  };

  let res: Response;
  try {
    armIdle();
    res = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    throw wrapNetworkError(err);
  }

  if (!res.ok || !res.body) {
    const text = await safeText(res);
    cleanup();
    throw new Error(`Codex model request failed: HTTP ${res.status} ${res.statusText} ${text}`.trim());
  }

  const toolCalls: ToolCall[] = [];
  let text = "";

  try {
    for await (const evt of sseEvents(res.body)) {
      armIdle(); // got activity; reset the idle timer
      switch (evt.event) {
        case "response.output_text.delta": {
          const delta = evt.data?.delta;
          if (typeof delta === "string" && delta.length) {
            text += delta;
            params.onTextDelta?.(delta);
          }
          break;
        }
        case "response.output_item.done": {
          const item = evt.data?.item;
          if (item?.type === "function_call") {
            toolCalls.push({
              callId: String(item.call_id ?? item.id ?? crypto.randomUUID()),
              name: String(item.name ?? ""),
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
            });
          }
          break;
        }
        case "response.failed":
        case "error": {
          const message = evt.data?.error?.message ?? evt.data?.message ?? "unknown model error";
          throw new Error(`Codex model error: ${message}`);
        }
        case "response.completed":
          break;
        default:
          break;
      }
    }
  } catch (err) {
    cleanup();
    if (controller.signal.aborted) throw new Error("Model turn aborted (idle timeout or cancellation).");
    throw err;
  }

  cleanup();
  return { text: text.trim(), toolCalls };

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

// --- SSE parsing ------------------------------------------------------------

type SSEEvent = { event: string; data: any };

async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    // SSE events are separated by a blank line.
    while ((sep = indexOfDoubleNewline(buffer)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const evt = parseBlock(block);
      if (evt) yield evt;
    }
  }
}

function indexOfDoubleNewline(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseBlock(block: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { event: "response.completed", data: {} };
  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return { event, data: dataText };
  }
}

function wrapNetworkError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  log.debug("Codex network error", msg);
  return new Error(`Could not reach the Codex model endpoint: ${msg}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "";
  }
}
