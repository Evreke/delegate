/**
 * pi-delegate — src/proof-paths.ts (MS-SYM-CONTRACT-1 §5, the system half).
 *
 * MODULE_CONTRACT: collect-time proof-path validation — the symmetric
 * contract's system obligation. After a report passes JSON/schema
 * validation, a status=pass report whose listed proof paths (artifacts +
 * evidence files) do not exist at collect time is rejected BEFORE
 * collectedAt is stamped. status=fail reports are NEVER blocked here: an
 * honest failure is never converted into a failure of a different kind.
 *
 * Leaf module: node:fs (existsSync) + node:path (isAbsolute/resolve) for
 * the probe and resolution; the ONE path-containment helper (isDirUnder)
 * is imported from ./expaths.ts (Law 9 — the boundary check has one
 * spelling; a raw startsWith(x + "/") containment is a layering pin
 * violation). The only project type reference is the type-only WorkerReport
 * import (erased at compile time — no runtime project dependency, so this
 * module does not drag the spawn/observe graph under itself).
 *
 * Path resolution rule (spec §5 — the ONE rule, there is no second): a
 * relative path resolves against the orchestrator project cwd (opts.cwd);
 * an absolute path is used as-is.
 *
 * Pseudo-path detector (spec §5.4, applied to evidence[].file ONLY —
 * artifacts are governed by the existence rule alone, so a bare directory
 * name like "dist" stays a valid artifact): a value is a pseudo-path when
 *   - it is a canonical placeholder marker — "TODO", "N/A", "TBD", "none"
 *     (exact match after trimming),
 *   - it is a command-output string (contains whitespace, e.g.
 *     "docker logs …"), or
 *   - it is a bare token with no path separator ("/" or "\\") and no "."
 *     anywhere (no file extension) — e.g. "TODO", "Makefile". A worker
 *     must cite such a file with an explicit path ("./Makefile",
 *     "docs/README").
 *
 * Ephemeral rule (spec §5 default policy): when every existing proof path
 * (artifacts ∪ evidence files, after resolution) lives under the exchange
 * root OR the OS temp dir — i.e. no durable copy survives the worker — the
 * pass is rejected. The config flag collect.ephemeralProof ("fail" default
 * | "warn") downgrades ONLY this rule to a warning (rollout only); rules
 * 1–3 stay hard-fail.
 *
 * Critical invariants: the validator never throws (returns
 * {ok:false,error} / {ok:true,warnings?}); error messages name the failing
 * path; no advisory path can fail a collect (Law 8).
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { WorkerReport } from "./host.ts";
import { isDirUnder } from "./expaths.ts";

/** Config input for the validator. The caller (spawn.ts) supplies the
 *  resolved roots so the module stays a pure leaf: exchangeRoot comes from
 *  exchange.ts (the one source), tempDir from node:os tmpdir(). */
export interface ProofPathOptions {
	/** Orchestrator project cwd — the base for relative paths. */
	cwd: string;
	/** Exchange root (ephemeral-root half of the ephemeral rule). */
	exchangeRoot: string;
	/** OS temp dir (ephemeral-root half of the ephemeral rule). */
	tempDir: string;
	/** collect.ephemeralProof — "fail" (default) | "warn" (rollout only). */
	ephemeralProof: "fail" | "warn";
}

export type ProofPathResult =
	| { ok: true; warnings?: string[] }
	| { ok: false; error: string };

/** Canonical placeholder markers (spec §5.4) — exact match, post-trim. */
const PSEUDO_MARKERS = new Set(["TODO", "N/A", "TBD", "none"]);

/** Trailing ":line" or ":start-end" reference on an evidence file
 *  (e.g. "src/a.ts:42", "src/a.ts:1-10"). Stripped before resolution. */
const LINE_SUFFIX_RE = /:(\d+)(?:-(\d+))?$/;

/**
 * Classify a raw evidence[].file value as a pseudo-path. Returns a
 * human-readable reason, or null when the value is a plausible path.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: raw — the evidence[].file value as written
 * Output: a reason string when the value is a pseudo-path, else null
 * Guarantees: pure — no filesystem access; never throws
 * Raises: never
 */
export function detectPseudoPath(raw: string): string | null {
	const v = raw.trim();
	if (v.length === 0) return "empty path";
	if (PSEUDO_MARKERS.has(v)) return `placeholder marker "${v}"`;
	if (/\s/.test(v)) return "contains whitespace (command output?)";
	const hasSep = v.includes("/") || v.includes("\\");
	const hasExt = v.includes(".");
	if (!hasSep && !hasExt) return "bare token with no path separator and no file extension";
	return null;
}

/**
 * Strip an optional trailing ":line" / ":start-end" reference.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — an evidence[].file value
 * Output: the value with a trailing :N / :N-M suffix removed (unchanged when
 *   absent)
 * Guarantees: pure; never throws; only a TRAILING digits/digits-digits
 *   suffix is removed (a Windows drive prefix is never touched)
 * Raises: never
 */
export function stripLineSuffix(path: string): string {
	return path.replace(LINE_SUFFIX_RE, "");
}

/**
 * The ONE path resolution rule: relative → resolve against cwd; absolute →
 * as-is. (spec §5 — documented here, no second rule exists.)
 */
function resolveProofPath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Ephemeral containment: a path is ephemeral when it lies under the exchange
 * root OR the OS temp dir (isDirUnder handles the separator boundary — Law 9
 * single source, never a raw prefix compare).
 */
function isEphemeral(path: string, exchangeRoot: string, tempDir: string): boolean {
	return isDirUnder(path, exchangeRoot) || isDirUnder(path, tempDir);
}

/**
 * Collect-time proof-path validation (spec §5) for a status=pass report.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - report: the schema-validated WorkerReport
 *   - opts: cwd (resolution base), exchangeRoot + tempDir (ephemeral
 *     roots), ephemeralProof (fail|warn)
 * Output: {ok:true} (optionally with warnings), or {ok:false,error} naming
 *   the failing path
 * Guarantees:
 *   - status=fail reports return {ok:true} immediately (never blocked,
 *     never converted into a failure)
 *   - status=pass enforces, in order: evidence.length >= 1; every
 *     artifacts[] entry resolves and exists (file OR directory); every
 *     evidence[].file that is NOT a pseudo-path (after stripping :line)
 *     exists; every evidence[].file that IS a pseudo-path rejects as such;
 *     the ephemeral rule (all existing proof paths under the exchange root
 *     OR temp dir → reject, unless ephemeralProof === "warn" which
 *     downgrades to a warning)
 * Raises: never
 */
export function validateProofPaths(report: WorkerReport, opts: ProofPathOptions): ProofPathResult {
	if (report.status !== "pass") return { ok: true };
	const warnings: string[] = [];

	if (report.evidence.length < 1) {
		return { ok: false, error: "status=pass report requires at least one evidence item (evidence.length >= 1)" };
	}

	const resolvedPaths: string[] = [];

	for (const artifact of report.artifacts) {
		const p = resolveProofPath(artifact, opts.cwd);
		if (!existsSync(p)) {
			return { ok: false, error: `artifact path does not exist: "${artifact}"` };
		}
		resolvedPaths.push(p);
	}

	for (const item of report.evidence) {
		const pseudo = detectPseudoPath(item.file);
		if (pseudo !== null) {
			return { ok: false, error: `evidence[].file is not a filesystem path (${pseudo}): "${item.file}"` };
		}
		const stripped = stripLineSuffix(item.file);
		const p = resolveProofPath(stripped, opts.cwd);
		if (!existsSync(p)) {
			return { ok: false, error: `evidence file does not exist: "${item.file}"` };
		}
		resolvedPaths.push(p);
	}

	// Ephemeral rule: every existing proof path under the exchange root OR the
	// temp dir → no durable copy. "warn" downgrades ONLY this rule (rollout).
	const allEphemeral = resolvedPaths.every((p) => isEphemeral(p, opts.exchangeRoot, opts.tempDir));
	if (allEphemeral) {
		const message =
			"all proof paths are ephemeral (under the exchange root or the OS temp dir) — no durable copy survives the worker";
		if (opts.ephemeralProof === "fail") {
			return { ok: false, error: message };
		}
		warnings.push(`${message} (warn mode)`);
	}

	return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}
