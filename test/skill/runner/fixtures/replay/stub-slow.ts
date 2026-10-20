/**
 * Fixture stub session driver for test/skill-runner-replay-check.ts —
 * the deadline path: never settles; the replay must refuse at the
 * deadline instead of hanging. Zero model calls, zero network.
 */
import type { SessionDriver } from "../../replay.ts";

export const sessionDriver: SessionDriver = async () => {
	// A promise that never settles — the deadline race must win.
	return new Promise<SessionDriverResult>(() => {});
};
