// Files flowing through the chat. Inbound documents are saved under the
// workspace `inbox/` (dated, sanitized, collision-safe) so the agent's normal
// tools — read, exec, skills, send_file — can act on them; outbound files are
// read from the workspace and sent by the channel with a mimetype guessed
// from the extension. OpenClaw ships pdfjs-based document extraction and a
// file-transfer plugin; crablite keeps files on plain disk and lets skills
// (e.g. the bundled pdf skill) do extraction with real binaries.

import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import { todayStamp } from "../memory/workspace.js";
import type { InboundMedia } from "../channels/types.js";

/** One cap for chat file transfer, both directions. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function guessMimetype(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Flatten to a safe base name (no separators/controls), keeping the extension. */
export function sanitizeName(name: string): string {
  const base = path.basename(name.trim() || "document");
  const cleaned = base
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, ""); // no dotfiles / traversal remnants
  return cleaned || "document";
}

/**
 * Save an inbound document under the workspace `inbox/`, dated and
 * collision-suffixed. Returns the workspace-relative path (posix separators)
 * that the agent's tools accept.
 */
export function saveInboundDocument(media: InboundMedia): string {
  const dir = path.join(paths.workspace(), "inbox");
  fs.mkdirSync(dir, { recursive: true });

  const name = `${todayStamp()}-${sanitizeName(media.filename ?? "document")}`;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;

  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) {
    candidate = `${stem}-${i}${ext}`;
  }
  fs.writeFileSync(path.join(dir, candidate), media.data);
  return `inbox/${candidate}`;
}
