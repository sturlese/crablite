// Client identity constants — how crablite identifies itself to the Codex
// endpoints (User-Agent/originator) and to WhatsApp (browser string).
// The version is read from package.json so there is a single source of truth.

import pkg from "../package.json" with { type: "json" };

export const CRABLITE_VERSION: string = pkg.version;
export const USER_AGENT = `crablite/${CRABLITE_VERSION}`;
export const ORIGINATOR = "crablite";
