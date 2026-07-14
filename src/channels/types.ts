// One channel interface. WhatsApp and the dev CLI both implement it, so they
// hit the identical agent path (OpenClaw collapses ChannelPlugin to this).

export type ChatType = "direct" | "group";

export type InboundMedia = {
  kind: "image" | "audio" | "video" | "document";
  data: Buffer;
  mimetype: string;
  filename?: string;
};

/** A file the agent sends to a chat (image, audio, or generic document). */
export type OutboundFile = {
  data: Buffer;
  mimetype: string;
  filename: string;
  caption?: string;
};

export type InboundMessage = {
  id: string;
  chatId: string;
  senderId: string;
  chatType: ChatType;
  text: string;
  /** Attached media (images to see, voice notes to transcribe, documents to save). */
  media?: InboundMedia[];
  /** Send a reply back to this chat. */
  reply(text: string): Promise<{ messageId: string }>;
  /** Send a file back to this chat (channels that can't, omit it). */
  sendFile?(file: OutboundFile): Promise<void>;
};

export interface Channel {
  id: string;
  /** Connect, subscribe to inbound messages, and call `onInbound` for each. */
  start(onInbound: (m: InboundMessage) => Promise<void>): Promise<void>;
  /** Proactively send a message to a chat (used by the heartbeat). */
  send(chatId: string, text: string): Promise<void>;
  /** Proactively send a file to a chat (used by routines delivering reports). */
  sendFile(chatId: string, file: OutboundFile): Promise<void>;
  stop(): Promise<void>;
}
