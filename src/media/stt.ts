// Speech-to-text for inbound voice notes — via the CODEX credential, no extra
// key. Faithful to OpenClaw's `transcribeOpenAiCodexAudio`: POST the audio to
// `<codex-base>/audio/transcriptions` with the ChatGPT/Codex OAuth token and
// model `gpt-4o-transcribe`.

import { getAccessToken } from "../codex/auth.js";
import { USER_AGENT, ORIGINATOR } from "../version.js";
import { CODEX_BASE_URL } from "../codex/responses.js";
import { log } from "../logger.js";

const STT_MODEL = "gpt-4o-transcribe";

export async function transcribeAudio(data: Buffer, mimetype: string): Promise<string | null> {
  try {
    const { access, accountId } = await getAccessToken();
    const form = new FormData();
    form.append("file", new Blob([data], { type: mimetype || "audio/ogg" }), `audio.${ext(mimetype)}`);
    form.append("model", STT_MODEL);

    const res = await fetch(`${CODEX_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        originator: ORIGINATOR,
        "User-Agent": USER_AGENT,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
      body: form,
    });
    if (!res.ok) {
      log.warn(`STT failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const json: any = await res.json();
    const text = typeof json?.text === "string" ? json.text.trim() : null;
    return text || null;
  } catch (err) {
    log.warn("STT error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function ext(mimetype: string): string {
  if (mimetype.includes("ogg")) return "ogg";
  if (mimetype.includes("m4a") || mimetype.includes("mp4")) return "m4a";
  if (mimetype.includes("wav")) return "wav";
  if (mimetype.includes("mpeg") || mimetype.includes("mp3")) return "mp3";
  return "ogg";
}
