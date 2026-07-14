import { describe, it, expect } from "vitest";
import {
  userItem,
  assistantItem,
  functionCallItem,
  functionOutputItem,
  userItemWithParts,
  imagePart,
  CODEX_BASE_URL,
} from "../src/codex/responses.js";

describe("responses item builders", () => {
  it("userItem uses input_text", () => {
    expect(userItem("hi")).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  it("assistantItem uses output_text", () => {
    expect(assistantItem("yo").content[0]!.type).toBe("output_text");
  });

  it("function call/output items", () => {
    expect(functionCallItem({ callId: "c", name: "n", arguments: "{}" })).toEqual({
      type: "function_call",
      name: "n",
      arguments: "{}",
      call_id: "c",
    });
    expect(functionOutputItem("c", "out")).toEqual({
      type: "function_call_output",
      call_id: "c",
      output: "out",
    });
  });

  it("imagePart makes a base64 data URI; userItemWithParts wraps parts", () => {
    const ip = imagePart(Buffer.from("abc"), "image/png");
    expect(ip.type).toBe("input_image");
    expect(ip.image_url).toMatch(/^data:image\/png;base64,/);
    expect(userItemWithParts([ip]).content[0]).toBe(ip);
  });

  it("targets the Codex backend by default", () => {
    expect(CODEX_BASE_URL).toContain("chatgpt.com/backend-api/codex");
  });
});
