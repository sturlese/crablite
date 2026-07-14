// WhatsApp channel via Baileys (multi-device, QR "Linked Devices" login) — the
// same library and flow OpenClaw uses, reduced to its essentials.

import * as Baileys from "baileys";
import qrcode from "qrcode-terminal";
import { paths, ensureDir } from "../paths.js";
import { makeBaileysLogger, log } from "../logger.js";
import { CRABLITE_VERSION } from "../version.js";
import { MAX_FILE_BYTES } from "../media/files.js";
import type { Channel, InboundMessage, InboundMedia, OutboundFile } from "./types.js";

// Robust interop across Baileys' CJS/ESM builds.
const makeWASocket: any = (Baileys as any).default ?? (Baileys as any).makeWASocket;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadMediaMessage } =
  Baileys as any;

const MEDIA_MAX_BYTES = MAX_FILE_BYTES; // don't download attachments larger than this

export class WhatsAppChannel implements Channel {
  id = "whatsapp";
  private sock: any;
  private onInbound?: (m: InboundMessage) => Promise<void>;
  private stopped = false;
  private reconnectDelay = 2_000;

  async start(onInbound: (m: InboundMessage) => Promise<void>): Promise<void> {
    this.onInbound = onInbound;
    ensureDir(paths.whatsappAuthDir());
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
  }

  /** Proactively send a message (used by the heartbeat / reminders). */
  async send(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp is not connected.");
    await this.sock.sendMessage(chatId, { text });
  }

  /** Send a file, typed by mimetype (image/audio/video render natively). */
  async sendFile(chatId: string, file: OutboundFile): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp is not connected.");
    const payload = file.mimetype.startsWith("image/")
      ? { image: file.data, caption: file.caption }
      : file.mimetype.startsWith("audio/")
        ? { audio: file.data, mimetype: file.mimetype }
        : file.mimetype.startsWith("video/")
          ? { video: file.data, caption: file.caption }
          : {
              document: file.data,
              mimetype: file.mimetype,
              fileName: file.filename,
              caption: file.caption,
            };
    await this.sock.sendMessage(chatId, payload);
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(paths.whatsappAuthDir());
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      auth: state,
      version,
      browser: ["crablite", "cli", CRABLITE_VERSION],
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: makeBaileysLogger(),
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (u: any) => this.onConnectionUpdate(u));
    this.sock.ev.on("messages.upsert", (ev: any) => this.onMessages(ev));
  }

  private onConnectionUpdate(u: any): void {
    if (u.qr) {
      log.info("Scan this QR in WhatsApp → Settings → Linked Devices → Link a device:");
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === "open") {
      log.info("WhatsApp connected. Listening for messages.");
      this.reconnectDelay = 2_000;
    }
    if (u.connection === "close") {
      const statusCode = u.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason?.loggedOut;
      if (loggedOut) {
        log.error(
          "WhatsApp session logged out. Delete auth/whatsapp and re-link (crablite login is separate).",
        );
        return;
      }
      if (this.stopped) return;
      log.warn(
        `WhatsApp connection closed (code ${statusCode}); reconnecting in ${this.reconnectDelay}ms…`,
      );
      setTimeout(() => {
        this.connect().catch((e) => log.error("Reconnect failed:", String(e)));
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.8, 30_000);
    }
  }

  private onMessages(ev: any): void {
    if (ev.type !== "notify") return;
    for (const m of ev.messages ?? []) {
      this.handleOne(m).catch((e) => log.error("inbound handler error:", String(e)));
    }
  }

  private async handleOne(m: any): Promise<void> {
    if (!m.message || m.key?.fromMe) return;
    const remoteJid: string = m.key.remoteJid ?? "";
    if (!remoteJid || remoteJid === "status@broadcast") return;

    const text = extractText(m.message);
    const media = await this.extractMedia(m);
    if (!text && (!media || media.length === 0)) return;

    const chatType = remoteJid.endsWith("@g.us") ? "group" : "direct";
    const msg: InboundMessage = {
      id: String(m.key.id ?? ""),
      chatId: remoteJid,
      senderId: String(m.key.participant ?? remoteJid),
      chatType,
      text,
      media,
      reply: async (t: string) => {
        const sent = await this.sock.sendMessage(remoteJid, { text: t });
        return { messageId: String(sent?.key?.id ?? "") };
      },
      sendFile: (file: OutboundFile) => this.sendFile(remoteJid, file),
    };
    await this.onInbound?.(msg);
  }

  /** Download inbound images, voice notes and documents (the kinds we use). */
  private async extractMedia(m: any): Promise<InboundMedia[] | undefined> {
    let message = m.message ?? {};
    // Documents sent WITH a caption arrive wrapped one level deeper.
    if (message.documentWithCaptionMessage?.message?.documentMessage) {
      message = message.documentWithCaptionMessage.message;
    }
    const kind = message.imageMessage
      ? "image"
      : message.audioMessage
        ? "audio"
        : message.documentMessage
          ? "document"
          : undefined;
    if (!kind) return undefined;
    const node = message[`${kind}Message`];
    // Refuse oversized attachments before downloading (bounds a bandwidth/memory DoS).
    const declaredLen = Number(node?.fileLength ?? 0);
    if (declaredLen && declaredLen > MEDIA_MAX_BYTES) {
      log.warn(`Skipping ${kind} media: ${declaredLen} bytes exceeds cap.`);
      return undefined;
    }
    try {
      const buf: Buffer = await downloadMediaMessage(
        m,
        "buffer",
        {},
        { logger: makeBaileysLogger(), reuploadRequest: this.sock.updateMediaMessage },
      );
      if (buf.length > MEDIA_MAX_BYTES) {
        log.warn(`Discarding ${kind} media: downloaded ${buf.length} bytes exceeds cap.`);
        return undefined;
      }
      const mimetype =
        node?.mimetype ??
        (kind === "image"
          ? "image/jpeg"
          : kind === "audio"
            ? "audio/ogg"
            : "application/octet-stream");
      return [{ kind, data: buf, mimetype, filename: node?.fileName ?? undefined }];
    } catch (e) {
      log.warn("media download failed:", String(e));
      return undefined;
    }
  }
}

function extractText(message: any): string {
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    ""
  ).trim();
}
