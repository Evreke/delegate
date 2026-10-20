/**
 * Fixture stub session driver for test/skill-runner-replay-check.ts —
 * the TAG_RE enforcement path: records an invalid tag; the driver must
 * fail fast and refuse the trace. Zero model calls, zero network.
 */
import { writeFileSync } from "node:fs";
import type { SessionDriver } from "../../replay.ts";

export const sessionDriver: SessionDriver = async (ctx) => {
	writeFileSync(ctx.tagsFile, `${JSON.stringify(["tool:delegate", "Not A Valid Tag!"], null, "\t")}\n`);
	return { ok: true };
};
