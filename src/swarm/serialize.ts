/**
 * pi-delegate — src/swarm/serialize.ts — the swarm CLI's byte-format writers.
 *
 * MODULE_CONTRACT — the ONE serialization source for every file the swarm
 * verbs write (Law 9, Law 7 wire formats frozen). Phase A output is
 * byte-identical to the extension's existing JSON file writers: a file is
 * `JSON.stringify(value, null, "\t") + "\n"` — the exact convention
 * `writeAnswer` / `writeRelease` (src/mailbox-store.ts) and
 * `updateManifest` (src/manifest-store.ts) already write, so a verb-written
 * file is byte-identical to an extension-written one. A progress ping is one
 * compact JSON object per line (`JSON.stringify(value) + "\n"`), the JSONL
 * shape `readLastProgress` (src/exchange.ts) scans.
 *
 * Dependencies: node builtins ONLY (a leaf — no src/ import).
 *
 * Critical invariants:
 *   - JSON_INDENT is a literal TAB (the repo's frozen file convention);
 *   - every file writer ends with exactly one "\n";
 *   - `undefined` object fields are dropped by JSON.stringify — callers omit
 *     optional fields rather than writing null.
 */

/** The repo's frozen JSON-file indentation (a literal tab). */
export const JSON_INDENT = "\t";

/** Serialize a JSON FILE value: tab-indented + exactly one trailing newline
 *  (byte-identical to writeAnswer/writeRelease/updateManifest output). */
export function serializeJsonFile(value: unknown): string {
	return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

/** Serialize one JSONL line: compact JSON + exactly one trailing newline
 *  (the progress-ping wire shape). */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
