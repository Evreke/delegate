/**
 * pi-delegate — src/passport.ts: the per-run provenance stamps
 * (the task "passport").
 *
 * MODULE_CONTRACT: two read-only git probes over a worker's checkout —
 * readPreRunGitSnapshot (HEAD + dirty-file list at spawn) and
 * readPostRunGitDelta (diff --stat + untracked at collect) — plus the
 * line cap shared by both. The idea is borrowed from @maheidem/pi-delegate
 * (R6/R7: git checkpoints + version provenance — "what did the dead worker
 * change?" must be `git diff <gitBase>`, not archaeology).
 *
 * Dependencies: node:child_process ONLY (a leaf module). Nothing here
 * imports the exchange layer or the host seam — callers pass the absolute
 * checkout path in and receive plain data back.
 *
 * Critical invariants:
 *   - EVERY probe is tolerant by contract: not-a-repo, git missing, a
 *     deleted checkout, a timeout — all yield empty/undefined, NEVER a
 *     throw. Provenance is advisory (Law 8): it must be structurally
 *     incapable of failing a spawn or a collect;
 *   - probes are read-only (`git rev-parse` / `status` / `diff` /
 *     `ls-files`) — this module never mutates the repo it inspects;
 *   - every list is capped at GIT_SNAPSHOT_MAX_LINES with an explicit
 *     "N more" tail line (the Law 1 duty: a huge dirty tree must not
 *     flood the manifest);
 *   - probes are worktree-placement only by CALLER decision (spawn.ts) —
 *     a tab worker shares the orchestrator's checkout and gets no stamps
 *     (a snapshot of the shared checkout would falsely attribute other
 *     workers' changes to this run).
 */

import { execFileSync } from "node:child_process";

/** Cap for every passport line list (gitStatus / gitDelta). */
export const GIT_SNAPSHOT_MAX_LINES = 100;

/** git-probe timeout (ms) — a local git call is milliseconds; a hanging
 *  filesystem must not stall the spawn/collect path. */
const GIT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The pre-run provenance stamp for ONE worktree placement.
 * All fields optional-by-absence: a non-git checkout yields `{}`.
 */
export interface GitPreRunSnapshot {
	/** `git rev-parse HEAD` — the commit the worker started from. */
	gitBase?: string;
	/** `git status --porcelain` lines at spawn (the pre-run dirty list,
	 *  capped). Absent when the probe found nothing dirty. */
	gitStatus?: string[];
}

/**
 * Run one read-only git command, returning stdout as non-empty lines.
 * NULL (never a throw) for: git missing, non-repo, unreadable path, timeout.
 */
function gitLines(args: string[], cwd: string): string[] | null {
	try {
		const out = execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_PROBE_TIMEOUT_MS,
		});
		return out.split("\n").filter((l) => l.length > 0);
	} catch {
		return null;
	}
}

/** Cap a line list at GIT_SNAPSHOT_MAX_LINES with an explicit "N more" tail. */
function capLines(lines: string[]): string[] {
	const capped = lines.slice(0, GIT_SNAPSHOT_MAX_LINES);
	if (lines.length > capped.length) capped.push(`… ${lines.length - capped.length} more omitted`);
	return capped;
}

/**
 * Pre-run snapshot of a worktree checkout.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: checkoutPath — absolute path to the worker's checkout
 * Output: GitPreRunSnapshot — `{}` when the path is not a git repo / git is
 *   missing / the path is unreadable; `{ gitBase }` when clean, plus
 *   `gitStatus` when dirty
 * Guarantees: pure read-only; tolerant (never throws, never rejects);
 *   total wall time bounded by 2 × GIT_PROBE_TIMEOUT_MS
 * Raises: never
 */
export function readPreRunGitSnapshot(checkoutPath: string): GitPreRunSnapshot {
	const base = gitLines(["rev-parse", "HEAD"], checkoutPath);
	if (!base || base.length === 0) return {};
	const status = gitLines(["status", "--porcelain"], checkoutPath);
	return {
		gitBase: base[0],
		...(status && status.length > 0 ? { gitStatus: capLines(status) } : {}),
	};
}

/**
 * Post-run delta of a worktree checkout — what THIS run changed.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: checkoutPath — absolute path to the worker's checkout
 * Output: string[] — `git diff --stat HEAD` lines followed by `?? <file>`
 *   untracked lines, capped; UNDEFINED when the path is not a git repo /
 *   git is missing (indistinguishable from "no provenance possible" —
 *   the caller then simply omits the stamp)
 * Guarantees: pure read-only; tolerant (never throws); bounded by
 *   2 × GIT_PROBE_TIMEOUT_MS
 * Raises: never
 */
export function readPostRunGitDelta(checkoutPath: string): string[] | undefined {
	const stat = gitLines(["diff", "--stat", "HEAD"], checkoutPath);
	if (!stat) return undefined;
	const untracked = gitLines(["ls-files", "--others", "--exclude-standard"], checkoutPath) ?? [];
	return capLines([...stat, ...untracked.map((u) => `?? ${u}`)]);
}
