/**
 * pi-delegate — test/skill/text-match.ts — the ONE text-matching mechanism
 * shared by the L0 pin engine (test/skill/l0/pins.ts) and the L2 anchor
 * projection (test/skill/quality/l2-text.ts).
 *
 * MODULE_CONTRACT — owns:
 *   - matchCandidates(text) — the matching universe: the text's BLOCKS
 *     (blank-line separated), each split into LIST ITEMS (a `-`/`*`/`+`/`N.`
 *     marker line starts a new item; indented continuation lines fold into
 *     the current item), each item whitespace-normalized into one line.
 *     Markdown hard-wraps phrases ("file:line\nevidence", "never\nre-call")
 *     and keeps a list item's logic on its wrapped lines while the NEIGHBOR
 *     item is an unrelated thought — so the item (not the physical line, not
 *     the whole block) is the unit a fire and its guard co-locate on.
 *   - firesOn(text, fire, guards) — TRUE iff some candidate matches a `fire`
 *     pattern while matching NO `guard` pattern (guards exempt the candidate
 *     — negation teaching such as "never verbatim" must not fire the pin).
 *     With no guards: TRUE iff some candidate matches a fire.
 *
 * Pure: zero IO, zero clock, zero randomness. Consumers own their pattern
 * tables; this module owns only the semantics.
 */

/** A list-item marker line (bullet or numbered) starts a new candidate. */
const LIST_ITEM_RE = /^\s*(?:[-*+] |\d+\. )/;

/**
 * All matching in the L0/L2 text layers is CASE-INSENSITIVE by construction:
 * every pattern is re-flagged with `i` here (one place, uniform semantics —
 * the same convention as the L1/L3 keyword matching). Pure; no other flag
 * of the source pattern is dropped.
 */
const ciCache = new WeakMap<RegExp, RegExp>();
function ci(re: RegExp): RegExp {
	let cached = ciCache.get(re);
	if (cached === undefined) {
		cached = re.flags.includes("i") ? re : new RegExp(re.source, `${re.flags}i`);
		ciCache.set(re, cached);
	}
	return cached;
}

/** The matching universe: one normalized candidate per paragraph/list item. */
export function matchCandidates(text: string): string[] {
	const out: string[] = [];
	for (const block of text.split(/\n\s*\n/)) {
		const items: string[][] = [];
		let current: string[] = [];
		for (const line of block.split("\n")) {
			if (LIST_ITEM_RE.test(line) && current.length > 0) {
				items.push(current);
				current = [line];
			} else {
				current.push(line);
			}
		}
		if (current.length > 0) items.push(current);
		for (const item of items) {
			const normalized = item.join(" ").replace(/\s+/g, " ").trim();
			if (normalized.length > 0) out.push(normalized);
		}
	}
	return out;
}

/** Fires iff a candidate matches a fire and no guard. Pure. */
export function firesOn(text: string, fire: RegExp[], guards?: RegExp[]): boolean {
	for (const candidate of matchCandidates(text)) {
		if (!fire.some((re) => ci(re).test(candidate))) continue;
		if (guards !== undefined && guards.some((re) => ci(re).test(candidate))) continue;
		return true;
	}
	return false;
}
