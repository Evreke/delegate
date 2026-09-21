/**
 * pi-delegate — src/swarm/args.ts — the swarm CLI argument parser.
 *
 * MODULE_CONTRACT — a tiny, dependency-free argv parser for the five worker
 * verbs. Shape: `swarm <verb> [--flag value | --flag=value] [positionals]`.
 * Value-taking flags are enumerated (VALUE_FLAGS); every other `--name` token
 * is a boolean flag. `--option` is repeatable and accumulates into an array
 * (the `ask` verb's multiple-choice surface); `--options a,b,c` is the
 * comma-separated twin. `--` ends flag parsing.
 *
 * Dependencies: ./result.ts (SwarmError ONLY — the parser reports malformed
 * invocations through the ONE result envelope).
 *
 * Critical invariants:
 *   - a value flag with no value is an E_SWARM_USAGE failure, never a silent
 *     `true`;
 *   - the first non-flag token is the verb; later non-flag tokens are
 *     positionals (the `read-brief <briefPath>` shorthand);
 *   - pure — no filesystem, no environment reads.
 */

import { SwarmError } from "./result.ts";

/** Flags that consume the next token (or `--flag=value`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
	"task",
	"worker",
	"brief",
	"question",
	"context",
	"option",
	"options",
	"phase",
	"pct",
	"note",
	"wait",
	"interval",
	"file",
	"schema-dir",
]);

export interface ParsedArgs {
	/** First non-flag token (the verb), or null when absent. */
	verb: string | null;
	/** Remaining non-flag tokens (e.g. a positional brief path). */
	positionals: string[];
	/** Value flags: string, or string[] for the repeatable `--option`. */
	flags: Record<string, string | string[]>;
	/** Boolean flags (e.g. `--help`). */
	bools: Set<string>;
}

/** Read one string value flag (last write wins). */
export function flagStr(parsed: ParsedArgs, key: string): string | undefined {
	const v = parsed.flags[key];
	return Array.isArray(v) ? v[v.length - 1] : v;
}

/** Read a repeatable flag as an array (never undefined). */
export function flagList(parsed: ParsedArgs, key: string): string[] {
	const v = parsed.flags[key];
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

/** Parse argv (WITHOUT the runtime + script prefix). Throws E_SWARM_USAGE on a
 *  malformed invocation. */
export function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string | string[]> = {};
	const bools = new Set<string>();
	let verb: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
			const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
			if (VALUE_FLAGS.has(key)) {
				let value = inlineValue;
				if (value === undefined) {
					const next = argv[i + 1];
					if (next !== undefined && !next.startsWith("--")) {
						value = next;
						i++;
					}
				}
				if (value === undefined) {
					throw new SwarmError("E_SWARM_USAGE", `flag --${key} requires a value`);
				}
				if (key === "option") {
					const prev = flags[key];
					flags[key] = Array.isArray(prev) ? [...prev, value] : prev !== undefined ? [prev, value] : [value];
				} else {
					flags[key] = value;
				}
			} else {
				bools.add(key);
			}
		} else if (verb === null) {
			verb = token;
		} else {
			positionals.push(token);
		}
	}

	return { verb, positionals, flags, bools };
}
