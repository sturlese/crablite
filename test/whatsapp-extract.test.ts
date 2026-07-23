// Pure extraction logic from the WhatsApp channel (no socket involved).
import { describe, it, expect } from "vitest";
import { extractQuoted, extractText } from "../src/channels/whatsapp.js";

describe("extractQuoted", () => {
  it("returns the quoted text when replying to a text message", () => {
    const message = {
      extendedTextMessage: {
        text: "what do you think about this?",
        contextInfo: { quotedMessage: { conversation: "let's move the launch to Friday" } },
      },
    };
    expect(extractQuoted(message)).toBe("let's move the launch to Friday");
  });

  it("finds contextInfo on non-text nodes too (e.g. replying with an image)", () => {
    const message = {
      imageMessage: {
        caption: "like this one",
        contextInfo: { quotedMessage: { conversation: "send me an example" } },
      },
    };
    expect(extractQuoted(message)).toBe("send me an example");
  });

  it("renders media placeholders for non-text quotes", () => {
    const quoted = (quotedMessage: any) => ({
      extendedTextMessage: { text: "x", contextInfo: { quotedMessage } },
    });
    expect(extractQuoted(quoted({ audioMessage: {} }))).toBe("[voice note]");
    expect(extractQuoted(quoted({ imageMessage: {} }))).toBe("[image]");
    expect(extractQuoted(quoted({ documentMessage: { fileName: "factura.pdf" } }))).toBe(
      "[document: factura.pdf]",
    );
    expect(
      extractQuoted(
        quoted({
          documentWithCaptionMessage: {
            message: { documentMessage: { fileName: "a.pdf", caption: "the invoice" } },
          },
        }),
      ),
    ).toBe("the invoice");
    expect(extractQuoted(quoted({ somethingUnknown: {} }))).toBe("[message]");
  });

  it("truncates very long quoted text", () => {
    const long = "x".repeat(1000);
    const message = {
      extendedTextMessage: { text: "y", contextInfo: { quotedMessage: { conversation: long } } },
    };
    const out = extractQuoted(message)!;
    expect(out.length).toBeLessThan(420);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns undefined when nothing is quoted", () => {
    expect(extractQuoted({ conversation: "hi" })).toBeUndefined();
    expect(extractQuoted(undefined)).toBeUndefined();
  });

  it("peels an ephemeral wrapper to find the quoted message", () => {
    // A reply sent in a chat with disappearing messages arrives wrapped.
    const message = {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: "what about this?",
            contextInfo: { quotedMessage: { conversation: "move the launch to Friday" } },
          },
        },
      },
    };
    expect(extractQuoted(message)).toBe("move the launch to Friday");
  });
});

describe("extractText", () => {
  it("reads captions from documents with caption", () => {
    expect(
      extractText({
        documentWithCaptionMessage: { message: { documentMessage: { caption: "read this" } } },
      }),
    ).toBe("read this");
  });

  it("reads text from a disappearing (ephemeral) message", () => {
    expect(extractText({ ephemeralMessage: { message: { conversation: "hola equipo" } } })).toBe(
      "hola equipo",
    );
  });

  it("reads the caption from a view-once message", () => {
    expect(
      extractText({ viewOnceMessageV2: { message: { imageMessage: { caption: "secret pic" } } } }),
    ).toBe("secret pic");
  });

  it("peels nested wrappers (ephemeral around a captioned document)", () => {
    expect(
      extractText({
        ephemeralMessage: {
          message: {
            documentWithCaptionMessage: {
              message: { documentMessage: { caption: "the invoice" } },
            },
          },
        },
      }),
    ).toBe("the invoice");
  });
});
