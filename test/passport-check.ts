/**
 * passport-check — the per-run provenance stamps (the task "passport"):
 * the pre-run git snapshot at spawn, the post-run delta at collect, the
 * line caps, the tolerance contract, and the version single-sourcing.
 *
 * Run with: bun test/passport-check.ts   (from repo root; no live herdr).
 * The git fixtures are real local repos in mkdtemp dirs — git on PATH is
 * required (the repo's dev environment has it; CI has it).
 *
 * Exit 0 only if all checks pass.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_VERSION } from "../src/version.ts";
import {
	GIT_SNAPSHOT_MAX_LINES,
	readPostRunGitDelta,
	readPreRunGitSnapshot,
} from "../src/passport.ts";
import { readManifest, updateManifest } from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

// --- Fixture: a real git repo with one committed file -----------------------

const REPO = mkdtempSync(join(tmpdir(), `passport-repo-`));
git(REPO, ["init", "-b", "main"]);
git(REPO, ["config", "user.email", "passport@example.test"]);
git(REPO, ["config", "user.name", "passport"]);
writeFileSync(join(REPO, "committed.txt"), "one\n");
git(REPO, ["add", "."]);
git(REPO, ["commit", "-m", "init"]);

const HEAD = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

// --- Part 1 — readPreRunGitSnapshot ----------------------------------------

{
	// Clean tree: gitBase only, no gitStatus.
	const clean = readPreRunGitSnapshot(REPO);
	check(
		"P1.1 clean repo yields gitBase=HEAD and NO gitStatus",
		clean.gitBase === HEAD && clean.gitStatus === undefined,
		JSON.stringify(clean),
	);

	// Dirty tracked file: status lists it.
	writeFileSync(join(REPO, "committed.txt"), "one\ntwo\n");
	const dirty = readPreRunGitSnapshot(REPO);
	check(
		"P1.2 dirty repo yields gitBase=HEAD plus a gitStatus line for the modified file",
		dirty.gitBase === HEAD && (dirty.gitStatus ?? []).some((l) => l.includes("committed.txt") && l.startsWith(" M")),
		JSON.stringify(dirty),
	);
	git(REPO, ["checkout", "--", "committed.txt"]); // restore clean
}

{
	// Not a repo: tolerant empty, never throws.
	const NOTREPO = mkdtempSync(join(tmpdir(), `passport-notrepo-`));
	const snap = readPreRunGitSnapshot(NOTREPO);
	check("P1.3 non-git directory yields an EMPTY snapshot, never throws", JSON.stringify(snap) === "{}");
	rmSync(NOTREPO, { recursive: true, force: true });

	// Missing path: also tolerant empty.
	const snapMissing = readPreRunGitSnapshot(join(tmpdir(), `passport-gone-${process.pid}`));
	check("P1.4 missing checkout path yields an EMPTY snapshot, never throws", JSON.stringify(snapMissing) === "{}");
}

// --- Part 2 — line cap ------------------------------------------------------

{
	const MESSY = mkdtempSync(join(tmpdir(), `passport-messy-`));
	git(MESSY, ["init", "-b", "main"]);
	git(MESSY, ["config", "user.email", "passport@example.test"]);
	git(MESSY, ["config", "user.name", "passport"]);
	writeFileSync(join(MESSY, "seed.txt"), "seed\n");
	git(MESSY, ["add", "."]);
	git(MESSY, ["commit", "-m", "init"]); // HEAD must exist — rev-parse fails on a commit-less repo by design
	for (let i = 0; i < GIT_SNAPSHOT_MAX_LINES + 5; i++) writeFileSync(join(MESSY, `untracked-${i}.txt`), "x\n");
	const snap = readPreRunGitSnapshot(MESSY);
	const lines = snap.gitStatus ?? [];
	const tailCount = parseInt((lines[GIT_SNAPSHOT_MAX_LINES].match(/(\d+)\s+more/) ?? [])[1] ?? "NaN", 10);
	check(
		`P2 the status list is capped at GIT_SNAPSHOT_MAX_LINES (${GIT_SNAPSHOT_MAX_LINES}) with an explicit "more omitted" tail`,
		lines.length === GIT_SNAPSHOT_MAX_LINES + 1 &&
			lines[GIT_SNAPSHOT_MAX_LINES].includes("more omitted") &&
			tailCount === 5,
		`len=${lines.length} tail=${lines[GIT_SNAPSHOT_MAX_LINES] ?? "(none)"}`,
	);
	rmSync(MESSY, { recursive: true, force: true });
}

// --- Part 3 — readPostRunGitDelta ------------------------------------------

{
	// Modify the tracked file + add an untracked one.
	writeFileSync(join(REPO, "committed.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(REPO, "new-untracked.txt"), "fresh\n");
	const delta = readPostRunGitDelta(REPO);
	check(
		"P3.1 delta carries the diff --stat line AND the untracked file with a ?? prefix",
		!!delta &&
			delta.some((l) => l.includes("committed.txt")) &&
			delta.some((l) => l === "?? new-untracked.txt"),
		JSON.stringify(delta ?? null),
	);

	// Back to clean: diff --stat of an empty diff is an empty list, and
	// untracked removal makes the whole delta empty — still DEFINED (a repo).
	git(REPO, ["checkout", "--", "committed.txt"]);
	rmSync(join(REPO, "new-untracked.txt"));
	const cleanDelta = readPostRunGitDelta(REPO);
	check("P3.2 clean repo yields a DEFINED, empty delta (repo provenance intact)", cleanDelta !== undefined && cleanDelta.length === 0);

	// Not a repo: undefined.
	const NOTREPO = mkdtempSync(join(tmpdir(), `passport-notrepo2-`));
	check("P3.3 non-git directory yields UNDEFINED delta, never throws", readPostRunGitDelta(NOTREPO) === undefined);
	rmSync(NOTREPO, { recursive: true, force: true });
}

// --- Part 4 — manifest roundtrip (the stamps persist) -----------------------

{
	const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), `passport-exchange-`));
	process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
	const DIR = join(EXCHANGE_SANDBOX, `passport-${process.pid}`);
	mkdirSync(DIR, { recursive: true });
	const entry = {
		name: "passport-worker",
		placement: { kind: "worktree" as const, checkoutPath: REPO, branch: "passport-branch", placementRef: "fake:p1" },
		briefPath: join(DIR, "brief-passport-worker.md"),
		reportPath: join(DIR, "report-passport-worker.json"),
		provider: "p",
		model: "m",
		thinking: "t",
		startedAt: new Date().toISOString(),
		gitBase: HEAD,
		gitStatus: [" M committed.txt"],
		gitDelta: [" committed.txt | 1 +", "?? new-untracked.txt"],
	};
	await updateManifest(DIR, (m) => ({ ...m, workers: [...m.workers, entry] }));
	const read = readManifest(DIR);
	const w = read?.workers.find((x) => x.name === "passport-worker");
	check(
		"P4 the passport fields survive the manifest write/read roundtrip byte-identically",
		w?.gitBase === HEAD &&
			w.gitStatus?.[0] === " M committed.txt" &&
			w.gitDelta?.[1] === "?? new-untracked.txt",
		JSON.stringify(w ?? null),
	);
	rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });
}

// --- Part 5 — version single-sourcing (local mirror of the static pin) ------

{
	const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string };
	check(
		"P5.1 the running version constant byte-matches package.json",
		EXTENSION_VERSION === pkg.version,
		`version.ts=${EXTENSION_VERSION} package.json=${pkg.version ?? "(absent)"}`,
	);
	check("P5.2 the version is a dotted triple", /^\d+\.\d+\.\d+$/.test(EXTENSION_VERSION), EXTENSION_VERSION);
}

// --- Cleanup ----------------------------------------------------------------

rmSync(REPO, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} PASSPORT CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL PASSPORT CHECKS PASSED");
