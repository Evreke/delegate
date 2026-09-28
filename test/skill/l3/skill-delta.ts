/**
 * BM-5 (#114) — L3 skill baseline snapshot + before/after regression delta.
 *
 * Run with: bun test/skill/l3/skill-delta.ts <verb> …   (from repo root)
 *   snapshot --out <file.json> [--dir skills/delegate]
 *   delta    --before <snapA.json> --after <snapB.json> --contract <fixture.json>
 *
 * MODULE_CONTRACT (output shapes are frozen for downstream consumers —
 * BM-2 #111 scores the same fixture shape, BM-6 #115 normalizes L3 into
 * composite Q; do not rename fields):
 *   snapshotDir(dir) → Snapshot — walks every .md file under dir (recursive
 *     glob, star-star-slash-star pattern), sorted by
 *     posix relative path; per file { path, sha256, bytes, lines }. Content
 *     is deterministic; capturedAt/gitRev are provenance only (explicitly
 *     NOT inputs to scoring).
 *   loadSnapshot(file) / loadContract(file) — parse + shape-validate; throw
 *     UsageError on bad version/shape (CLI maps every throw to exit 2).
 *   computeDelta(before, after, contract) → DeltaResult — file-level diff vs
 *     before per path: unchanged | changed | added | removed (sha256
 *     comparison; changed rows carry bytes/lines deltas). Blocker
 *     non-regression: every contract claim with severity "blocker" has its
 *     keywords re-checked (case-insensitive substring) against the AFTER
 *     files' TEXTS — read from disk relative to the AFTER snapshot's `dir`
 *     field, because a snapshot pins identity (hashes) while the delta
 *     verifies liveness (text). A claim is satisfied iff EVERY keyword occurs
 *     somewhere in the union of after texts (any file may supply any
 *     keyword). Unsatisfied blocker → regressions[] entry; unsatisfied
 *     non-blocker → warnings[] entry (same shape). A file listed in the after
 *     snapshot but missing on disk contributes empty text (its absence is
 *     already visible in the file-level diff); a wholly unreadable after dir
 *     is an IO error (exit 2), not a regression.
 *   main(argv) → exit code.
 * Exit codes (delta): 0 = no blocker regression · 1 = blocker regression
 * present · 2 = usage/parse/IO errors.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export class UsageError extends Error {}

export interface SnapshotFileEntry {
	path: string;
	sha256: string;
	bytes: number;
	lines: number;
}

export interface Snapshot {
	version: 1;
	capturedAt: string;
	gitRev: string;
	dir: string;
	files: SnapshotFileEntry[];
}

export type ClaimSeverity = "blocker" | "major" | "minor";

export interface Claim {
	id: string;
	claim: string;
	severity: ClaimSeverity;
	weight: number;
	source: string;
	keywords: string[];
}

export interface ToolContract {
	version: 1;
	claims: Claim[];
}

export interface RegressionEntry {
	id: string;
	claim: string;
	missingKeywords: string[];
}

export type DetailStatus = "unchanged" | "changed" | "added" | "removed";

export interface DeltaDetailRow {
	path: string;
	status: DetailStatus;
	deltaBytes?: number;
	deltaLines?: number;
}

export interface DeltaResult {
	version: 1;
	blockerRegression: boolean;
	regressions: RegressionEntry[];
	warnings: RegressionEntry[];
	files: { changed: number; added: number; removed: number; unchanged: number };
	detail: DeltaDetailRow[];
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Line count: newline-terminated files do not count a phantom last line. */
export function countLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function walkMarkdown(root: string, out: string[] = []): string[] {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) {
			if (!lstatSync(full).isSymbolicLink()) walkMarkdown(full, out);
		} else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

function gitRev(): string {
	try {
		const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
		if (r.status === 0 && r.stdout) return r.stdout.trim();
	} catch {
		// fall through to unversioned
	}
	return "unversioned";
}

export function snapshotDir(dir: string): Snapshot {
	const root = resolve(dir);
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		throw new UsageError(`snapshot --dir: not a readable directory: ${dir}`);
	}
	const files: SnapshotFileEntry[] = walkMarkdown(root)
		.map((full) => {
			const rel = relative(root, full).split(sep).join("/");
			const text = readFileSync(full, "utf8");
			return {
				path: rel,
				sha256: sha256Hex(text),
				bytes: statSync(full).size,
				lines: countLines(text),
			};
		})
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		version: 1,
		capturedAt: new Date().toISOString(),
		gitRev: gitRev(),
		dir,
		files,
	};
}

function asSnapshot(value: unknown, what: string): Snapshot {
	if (typeof value !== "object" || value === null) {
		throw new UsageError(`${what}: not a JSON object`);
	}
	const s = value as Record<string, unknown>;
	if (s.version !== 1) throw new UsageError(`${what}: version must be 1`);
	if (typeof s.capturedAt !== "string" || typeof s.gitRev !== "string" ||
		typeof s.dir !== "string" || !Array.isArray(s.files)) {
		throw new UsageError(`${what}: missing provenance/dir/files fields`);
	}
	for (const f of s.files) {
		if (typeof f !== "object" || f === null) {
			throw new UsageError(`${what}: files[] entry not an object`);
		}
		const e = f as Record<string, unknown>;
		if (typeof e.path !== "string" || typeof e.sha256 !== "string" ||
			typeof e.bytes !== "number" || typeof e.lines !== "number") {
			throw new UsageError(`${what}: bad file entry ${JSON.stringify(f)}`);
		}
	}
	return s as unknown as Snapshot;
}

export function loadSnapshot(file: string): Snapshot {
	return asSnapshot(JSON.parse(readFileSync(file, "utf8")), `snapshot ${file}`);
}

export function loadContract(file: string): ToolContract {
	const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	if (value.version !== 1) throw new UsageError(`contract ${file}: version must be 1`);
	if (!Array.isArray(value.claims) || value.claims.length === 0) {
		throw new UsageError(`contract ${file}: claims[] must be non-empty`);
	}
	for (const c of value.claims) {
		if (typeof c !== "object" || c === null) {
			throw new UsageError(`contract ${file}: claim entry not an object`);
		}
		const claim = c as Record<string, unknown>;
		if (typeof claim.id !== "string" || typeof claim.claim !== "string" ||
			typeof claim.severity !== "string" || !Array.isArray(claim.keywords) ||
			claim.keywords.some((k) => typeof k !== "string")) {
			throw new UsageError(`contract ${file}: bad claim ${JSON.stringify(claim)}`);
		}
		if (!["blocker", "major", "minor"].includes(claim.severity as string)) {
			throw new UsageError(`contract ${file}: bad severity on ${claim.id}`);
		}
	}
	return value as unknown as ToolContract;
}

export function computeDelta(
	before: Snapshot,
	after: Snapshot,
	contract: ToolContract,
): DeltaResult {
	asSnapshot(before, "before snapshot");
	asSnapshot(after, "after snapshot");
	if (contract.version !== 1 || !Array.isArray(contract.claims)) {
		throw new UsageError("contract: version must be 1 with a claims[] array");
	}

	// Liveness: re-read the AFTER files' texts from disk relative to the AFTER
	// snapshot's dir field (snapshots pin identity; the delta verifies text).
	const afterRoot = resolve(after.dir);
	if (!existsSync(afterRoot) || !statSync(afterRoot).isDirectory()) {
		throw new UsageError(`after snapshot dir not readable on disk: ${after.dir}`);
	}
	const afterTexts: string[] = [];
	for (const f of after.files) {
		try {
			afterTexts.push(readFileSync(join(afterRoot, ...f.path.split("/")), "utf8").toLowerCase());
		} catch {
			afterTexts.push(""); // missing after file supplies no keywords
		}
	}
	const keywordSatisfied = (keyword: string): boolean => {
		const needle = keyword.toLowerCase();
		return afterTexts.some((text) => text.includes(needle));
	};

	const beforeByPath = new Map(before.files.map((f) => [f.path, f]));
	const afterByPath = new Map(after.files.map((f) => [f.path, f]));
	const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
	const detail: DeltaDetailRow[] = [];
	const counts = { changed: 0, added: 0, removed: 0, unchanged: 0 };
	for (const path of paths) {
		const b = beforeByPath.get(path);
		const a = afterByPath.get(path);
		if (b && a) {
			if (b.sha256 === a.sha256) {
				counts.unchanged++;
				detail.push({ path, status: "unchanged" });
			} else {
				counts.changed++;
				detail.push({
					path,
					status: "changed",
					deltaBytes: a.bytes - b.bytes,
					deltaLines: a.lines - b.lines,
				});
			}
		} else if (a) {
			counts.added++;
			detail.push({ path, status: "added" });
		} else {
			counts.removed++;
			detail.push({ path, status: "removed" });
		}
	}

	const regressions: RegressionEntry[] = [];
	const warnings: RegressionEntry[] = [];
	for (const claim of contract.claims) {
		const missingKeywords = claim.keywords.filter((k) => !keywordSatisfied(k));
		if (missingKeywords.length === 0) continue;
		const entry = { id: claim.id, claim: claim.claim, missingKeywords };
		if (claim.severity === "blocker") regressions.push(entry);
		else warnings.push(entry);
	}

	return {
		version: 1,
		blockerRegression: regressions.length > 0,
		regressions,
		warnings,
		files: counts,
		detail,
	};
}

function parseFlags(args: string[]): Map<string, string> {
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) throw new UsageError(`unexpected argument: ${arg}`);
		const key = arg.slice(2);
		if (!key || flags.has(key)) throw new UsageError(`duplicate or empty flag: ${arg}`);
		if (i + 1 >= args.length) throw new UsageError(`flag ${arg} needs a value`);
		flags.set(key, args[++i]);
	}
	return flags;
}

function requireFlag(flags: Map<string, string>, key: string): string {
	const value = flags.get(key);
	if (value === undefined) throw new UsageError(`missing required flag --${key}`);
	return value;
}

function runSnapshot(args: string[]): number {
	const flags = parseFlags(args);
	const out = requireFlag(flags, "out");
	const dir = flags.get("dir") ?? "skills/delegate";
	const snapshot = snapshotDir(dir);
	const target = resolve(out);
	const parent = dirname(target);
	if (parent && !existsSync(parent)) {
		throw new UsageError(`--out parent directory does not exist: ${parent}`);
	}
	writeFileSync(target, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
	return 0;
}

function runDelta(args: string[]): number {
	const flags = parseFlags(args);
	const before = loadSnapshot(requireFlag(flags, "before"));
	const after = loadSnapshot(requireFlag(flags, "after"));
	const contract = loadContract(requireFlag(flags, "contract"));
	const result = computeDelta(before, after, contract);
	console.log(JSON.stringify(result, null, "\t"));
	return result.blockerRegression ? 1 : 0;
}

export function main(argv: string[]): number {
	const [verb, ...rest] = argv;
	try {
		if (verb === "snapshot") return runSnapshot(rest);
		if (verb === "delta") return runDelta(rest);
		throw new UsageError(`unknown verb: ${verb ?? "(none)"} — expected snapshot | delta`);
	} catch (error) {
		console.error(`skill-delta: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
