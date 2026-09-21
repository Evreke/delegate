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
 * Dependencies: node:fs, node:path, @earendil-works/pi-coding-agent
 * (CONFIG_DIR_NAME — the project schema-library dir, never a hardcoded ".pi"),
 * ../expaths.ts (reportPathFor — the ONE path builder), ../report-schema.ts,
 * ./context.ts, ./serialize.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - the report is validated BEFORE the final path exists/updates;
 *   - the published bytes are exactly serializeJsonFile(parsed);
 *   - schema resolution failure is fail-closed (E_SWARM_SCHEMA).
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
 *  the exact bytes atomically. */
export function runWriteReport(ctx: SwarmContext, parsed: ParsedArgs): void {
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
	// library first (<cwd>/.pi/delegate-schemas via pi's CONFIG_DIR_NAME), then
	// the user-level library. --schema-dir is the explicit test/ops override.
	const schemaDir = flagStr(parsed, "schema-dir");
	const projectSchemaDir = schemaDir ?? resolve(process.cwd(), CONFIG_DIR_NAME, "delegate-schemas");
	const resolved = resolveReportSchema(d.briefPath, projectSchemaDir);
	if (!resolved.ok) {
		throw new SwarmError("E_SWARM_SCHEMA", resolved.error);
	}

	const content = serializeJsonFile(parsedReport);
	const tmpPath = `${reportPath}.validate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		writeFileSync(tmpPath, content, "utf8");
		const verdict = validateReportAgainstSchema(tmpPath, ctx.worker, resolved.schema);
		if (!verdict.ok) {
			// Name the FINAL path in the failure (the validate temp is deleted and
			// must not leak into a worker-facing message) — collect-time messages
			// name the report path, and write-time must read identically.
			throw new SwarmError("E_REPORT_INVALID", verdict.error.replaceAll(tmpPath, reportPath));
		}
		renameSync(tmpPath, reportPath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		throw err;
	}

	emitSuccess("write-report", {
		path: reportPath,
		bytes: Buffer.byteLength(content, "utf8"),
		schemaProvenance: resolved.provenance,
	});
}
