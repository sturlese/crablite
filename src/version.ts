// Client identity constants — the single source of truth for the version
// (keep in sync with package.json) and how crablite identifies itself to the
// Codex endpoints (User-Agent/originator) and to WhatsApp (browser string).

export const CRABLITE_VERSION = "0.1.0";
export const USER_AGENT = `crablite/${CRABLITE_VERSION}`;
export const ORIGINATOR = "crablite";
