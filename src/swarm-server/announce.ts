/**
 * pi-delegate — src/swarm-server/announce.ts — the swarm-server
 * announcement seam (the startup-noise round).
 *
 * MODULE_CONTRACT — ONE sink for every operator-facing swarm-server event
 * (dashboard link, operator token, mount advisories). The mount emits
 * STRUCTURED events; the sink decides the presentation:
 *
 *   - UI session (`createAnnounceSink(ui, true)`): pi's `ctx.ui.notify` —
 *     persistent, tidy transcript rows. The `operator-token` and
 *     `secondary-mount` events produce NO row (the token rides the
 *     dashboard link's `#t=` fragment; being secondary is normal D1
 *     operation — the role hint rides the dashboard row). Every other warn
 *     event becomes one warning row. NOTHING touches process.stderr — its
 *     raw bytes were landing as JSON garbage under the [Extensions] header.
 *
 *   - headless (`hasUI` false, or the `stderrAnnounceSink` default): the
 *     historical machine-readable shape — one JSON line per event on
 *     stderr (`{level, component:"swarm-server", event, ...fields}`) —
 *     byte-compatible with the pre-seam emitter so machines and the
 *     existing checks keep parsing it.
 *
 * Lives on a leaf so `./mount.ts` stays under the Law 5 size threshold.
 * Dependencies: none above node (a leaf). No herdr import (Law 4).
 *
 * Critical invariants:
 *   - UI mode writes ZERO bytes to stderr (pinned by swarm-announce-check);
 *   - headless mode calls notify ZERO times;
 *   - both paths are total (a throwing ui.notify or stderr never propagates
 *     — announcements are advisory by contract, Law 8).
 */

/** One structured swarm-server event (the historical stderr line's shape). */
export type SwarmServerEvent = { level: "info" | "warn"; event: string } & Record<string, unknown>;

/** The mount's announcement port. */
export type AnnounceSink = (e: SwarmServerEvent) => void;

/** The minimal UI surface the sink needs (pi's ExtensionUIContext.notify). */
export interface AnnounceUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** The legacy emitter: one structured JSON line on stderr. Total; a stderr
 *  failure is advisory (never propagates). */
export function stderrAnnounceSink(e: SwarmServerEvent): void {
	try {
		const { level, event, ...fields } = e;
		process.stderr.write(`${JSON.stringify({ level, component: "swarm-server", event, ...fields })}\n`);
	} catch {
		// stderr itself is advisory
	}
}

/** The dashboard row text for a role (Law 9 — ONE spelling). The link's
 *  `#t=` fragment carries the token; a secondary names the serving session. */
function dashboardText(link: string, role: string | undefined): string {
	if (role === "secondary") return `Fleet dashboard: ${link} — served by the primary session`;
	return `Fleet dashboard: ${link}`;
}

/** The warning row text: event name + the machine fields, losslessly. */
function warnText(e: SwarmServerEvent): string {
	const { level, event, ...fields } = e;
	return `swarm-server ${event}: ${JSON.stringify(fields)}`;
}

/**
 * The UI-aware sink: human rows when a UI exists, the legacy stderr JSON
 * when not.
 * <p>
 * FUNCTION_CONTRACT: Input — the notify surface and whether a UI exists.
 * Output — an AnnounceSink. Guarantees: UI mode — zero stderr bytes, no
 * row for operator-token/secondary-mount, exactly one info row per
 * dashboard event, one warning row per other warn event; headless mode —
 * the exact stderrAnnounceSink behavior, notify untouched; total on both
 * paths (a throwing notify is swallowed — advisory, Law 8). Raises: never.
 */
export function createAnnounceSink(ui: AnnounceUi, hasUI: boolean): AnnounceSink {
	if (!hasUI) return stderrAnnounceSink;
	return (e: SwarmServerEvent): void => {
		try {
			if (e.event === "dashboard" && typeof e.link === "string") {
				ui.notify(dashboardText(e.link, typeof e.role === "string" ? e.role : undefined), "info");
				return;
			}
			if (e.event === "operator-token") return; // the token rides the dashboard link
			if (e.event === "secondary-mount") return; // normal D1 operation; the dashboard row carries the role hint
			if (e.level === "warn") ui.notify(warnText(e), "warning");
			// info events other than dashboard/operator-token have no row spelling yet — stay silent rather than invent UI noise
		} catch {
			// a broken UI surface is advisory — never propagate past an announcement
		}
	};
}
