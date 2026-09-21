/**
 * pi-delegate — src/swarm/write-report.ts — the `swarm write-report` verb.
 *
 * MODULE_CONTRACT — write the worker's report to report-<worker>.json, but
 * ONLY after it validates against the RESOLVED report schema (§4.1.1): the v1
 * base contract plus the brief-declared `reportSchema` fragment, resolved by
 * src/report-schema.ts exactly as collect time resolves it. Validation moves
 * from collect time to write time, so the worker learns immediately instead of
 * through a watcher wake-up; collect keeps its own fail-closed validation.
 *
 * Validation reads a FILE (the existing validator's contract), so the verb
 * writes the exact bytes it intends to publish to a sibling validate-temp file,
 * validates THAT, and only then renames it into place. The rename is atomic, so
 * a rejected report never lands and never clobbers an earlier good report; a
 * verb-written report that fails collect-time validation stays a bug class with
 * its own regression check (Law 10).
 *
 * Phase B (issue #23, §4.1.3): under `swarm.storage: "journal"` the verb
 * appends the journal event (kind `report` — the operator-approved 14th
 * kind; payload = the validated report JSON verbatim) AFTER a successful
 * atomic publish (the journal never announces an unpublished report); the
 * append is advisory (Law 8: swallowed + structured stderr note) and surfaces
 * in the success envelope's `journal` field.
 *
 * Schema-tier resolution ORDER (fix/cli-schema-tier, 2026-09-21): the brief's
 * `reportSchema` fragment is resolved against a PROJECT-tier library dir chosen
 * as `--schema-dir` flag > `SWARM_SCHEMA_DIR` env var > the cwd-derived
 * `<cwd>/.pi/delegate-schemas` fallback. The env tier exists because a WORKTREE
 * worker's cwd is not the orchestrator's session cwd — collect-time validation
 * (src/spawn-phases.ts) resolves from the ORCHESTRATOR's cwd, so the spawn flow
 * exports the orchestrator-resolved dir as SWARM_SCHEMA_DIR (#25 owns the
 * prompt/export side; the CLI owns this precedence). The user-level library
 * (`getAgentDir()/pi-delegate-schemas`) stays the second tier in every case.
 *
 * Dependencies: node:fs, node:path, @earendil-works/pi-coding-agent
 * (CONFIG_DIR_NAME — the project schema-library dir, never a hardcoded ".pi"),
 * ../expaths.ts (reportPathFor — the ONE path builder), ../report-schema.ts,
 * ./context.ts, ./serialize.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - the report is validated BEFORE the final path exists/updates;
 *   - the published bytes are exactly serializeJsonFile(parsed);
 *   - schema resolution failure is fail-closed (E_SWARM_SCHEMA);
 *   - the sibling validate-temp is removed on EVERY failure path (try/finally
 *     around the publish; the success path renames it away).
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { reportPathFor } from "../expaths.ts";
import { resolveReportSchema, validateReportAgainstSchema } from "../report-schema.ts";
import { flagStr, type ParsedArgs } from "./args.ts";
import { openExchangeDir, type SwarmContext } from "./context.ts";
import { emitSuccess, SwarmError } from "./result.ts";
import { serializeJsonFile } from "./serialize.ts";
import { appendSwarmEvent } from "./storage.ts";

/** Read the report JSON text from `--file <path>` or stdin (fd 0). */
function readReportInput(parsed: ParsedArgs): string {
	const file = flagStr(parsed, "file");
	try {
		return file !== undefined ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
	} catch (err) {
		throw new SwarmError("E_SWARM_IO", `report input not readable${file ? ` at ${file}` : " on stdin"}: ${(err as Error).message}`);
	}
}

/** Run `swarm write-report`: validate against the resolved schema, then publish
 *  the exact bytes atomically. `env` supplies the SWARM_SCHEMA_DIR project-tier
 *  override (see the MODULE_CONTRACT resolution order). */
export async function runWriteReport(ctx: SwarmContext, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
	const d = openExchangeDir(ctx.briefPath);
	const reportPath = reportPathFor(d.dir, ctx.worker);

	const raw = readReportInput(parsed);
	if (raw.trim().length === 0) {
		throw new SwarmError("E_REPORT_INVALID", "report input is empty");
	}
	let parsedReport: unknown;
	try {
		parsedReport = JSON.parse(raw);
	} catch (err) {
		throw new SwarmError("E_REPORT_INVALID", `report is not valid JSON: ${(err as Error).message}`);
	}

	// Resolve the brief-declared schema exactly as collect time does: project
	// library first, then the user-level library. Project-tier dir precedence:
	// --schema-dir > SWARM_SCHEMA_DIR > <cwd>/.pi/delegate-schemas (CONFIG_DIR_NAME).
	const schemaDir = flagStr(parsed, "schema-dir") ?? env.SWARM_SCHEMA_DIR;
	const projectSchemaDir = schemaDir ?? resolve(process.cwd(), CONFIG_DIR_NAME, "delegate-schemas");
	const resolved = resolveReportSchema(d.briefPath, projectSchemaDir);
	if (!resolved.ok) {
		throw new SwarmError("E_SWARM_SCHEMA", resolved.error);
	}

	const content = serializeJsonFile(parsedReport);
	const tmpPath = `${reportPath}.validate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	let journal: { seq: number } | { error: string } | null = null;
	try {
		writeFileSync(tmpPath, content, "utf8");
		const verdict = validateReportAgainstSchema(tmpPath, ctx.worker, resolved.schema);
		if (!verdict.ok) {
			// Name the FINAL path in the failure (the validate temp is deleted and
			// must not leak into a worker-facing message) — collect-time messages
			// name the report path, and write-time must read identically.
			throw new SwarmError("E_REPORT_INVALID", verdict.error.replaceAll(tmpPath, reportPath));
		}
		// Phase B ordering (§4.1.3, brief CONTEXT): the reporter is the terminal
		// artifact the watcher reacts to, so it is journaled (kind `report`,
		// payload = the validated report JSON verbatim) AFTER the atomic publish —
		// the journal never announces a report that did not reach its path. A
		// journal failure is advisory (Law 8: swallowed + a structured stderr
		// note) and never fails the write. A REJECTED report is journaled nowhere.
		renameSync(tmpPath, reportPath);
		journal = await appendSwarmEvent({ task: d.task, worker: ctx.worker, dir: d.dir }, "report", parsedReport, env);
	} finally {
		// Success renamed the temp away; every failure path unlinks it here so a
		// rejected report can never leave an orphan beside the real report.
		rmSync(tmpPath, { force: true });
	}

	emitSuccess("write-report", {
		path: reportPath,
		bytes: Buffer.byteLength(content, "utf8"),
		schemaProvenance: resolved.provenance,
		...(journal ? { journal } : {}),
	});
}
