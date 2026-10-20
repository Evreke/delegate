/**
 * Fixture stub session driver for test/skill-runner-replay-check.ts —
 * the happy path: records the canned tags, settles immediately.
 * Zero model calls, zero network.
 */
import { writeFileSync } from "node:fs";
import type { SessionDriver } from "../../replay.ts";

export const sessionDriver: SessionDriver = async (ctx) => {
	writeFileSync(
		ctx.tagsFile,
		`${JSON.stringify(["tool:delegate", "topology:single-direct"], null, "\t")}\n`,
	);
	return { ok: true };
};
