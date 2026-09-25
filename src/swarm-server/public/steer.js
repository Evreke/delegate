/**
 * steer.js — the dashboard's steering + token client (issue #54).
 *
 * The mutation half of the dashboard: `postMutation` POSTs the two documented
 * routes (`/api/workers/:id/steer`, `/api/asks/:id/answer`) with an
 * `Authorization: Bearer` token. The token lives in `sessionStorage` ONLY
 * (the `TOKEN_KEY`), is read/written through the helpers here and is NEVER
 * placed in a URL, localStorage or a console line. A structured 401/403 sets
 * `authRequired` so the page re-prompts.
 *
 * Steering is OPTIMISTIC-WITH-CONFIRMATION: a successful POST creates a
 * pending marker (`newPending`). It becomes `confirmed` when the mutation
 * envelope carries `confirmation: "confirmed"` (journal mode — the row is
 * already durable) OR when the matching journal `steer`/`answer` event arrives
 * (`reducePending` — the journal is the truth; this path also serves
 * pre-#62 servers whose envelope has no `confirmation` field). In `files`
 * storage mode (§4.1.3) the envelope carries `confirmation: "unavailable"`:
 * no journal row will ever arrive, so the marker moves to the honest
 * `unconfirmed` state ("delivered — journal confirmation unavailable")
 * instead of spinning on `pending` forever (#62 item 1). A structured error
 * marks it `failed` (`failPending`). `pendingAsks`
 * folds the `ask`-without-`answer` event graph into the pending-question list
 * the answer form renders. `controlsView` states honestly why a card's
 * controls are disabled (foreign fleet, ended worker) instead of hiding them.
 *
 * No framework, plain ES module.
 */

/** sessionStorage key of the operator token (the ONLY token store). */
export const TOKEN_KEY = "swarm.dashboard.operatorToken";

/** Read the operator token (sessionStorage only; never throws). */
export function readToken(storage) {
	try {
		const raw = storage ? storage.getItem(TOKEN_KEY) : null;
		return typeof raw === "string" && raw.length > 0 ? raw : null;
	} catch {
		return null;
	}
}

/** Persist the operator token (sessionStorage only; best effort). */
export function writeToken(storage, token) {
	try {
		if (storage && typeof token === "string" && token.length > 0) storage.setItem(TOKEN_KEY, token);
	} catch {
		/* persistence is best effort */
	}
}

/** Drop the operator token (a 401 re-prompt starts clean). */
export function clearToken(storage) {
	try {
		if (storage) storage.removeItem(TOKEN_KEY);
	} catch {
		/* best effort */
	}
}

/** The route for a mutation kind. */
export function mutationPath(kind, id) {
	const enc = encodeURIComponent(id);
	return kind === "answer" ? `/api/asks/${enc}/answer` : `/api/workers/${enc}/steer`;
}

/**
 * POST one mutation.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: {fetch, token, kind, id, text}
 * Output: {ok, status, envelope, authRequired} — never a throw
 * Guarantees: the token travels ONLY in the Authorization header (never the
 *   URL); a 401/403 sets authRequired for a re-prompt; a network failure is a
 *   structured `{ok:false,status:0}`.
 * Raises: never
 */
export async function postMutation(opts) {
	const fetchImpl = opts.fetch || ((...args) => fetch(...args));
	const headers = { "content-type": "application/json" };
	if (typeof opts.token === "string" && opts.token.length > 0) headers.authorization = `Bearer ${opts.token}`;
	let status = 0;
	let envelope = null;
	try {
		const res = await fetchImpl(mutationPath(opts.kind, opts.id), {
			method: "POST",
			headers,
			body: JSON.stringify({ text: opts.text }),
		});
		status = typeof res.status === "number" ? res.status : 0;
		try {
			envelope = await res.json();
		} catch {
			envelope = null;
		}
	} catch {
		return { ok: false, status: 0, envelope: null, authRequired: false, error: "network" };
	}
	const ok = status === 200 && envelope !== null && envelope.ok === true;
	return { ok, status, envelope, authRequired: status === 401 || status === 403 };
}

/** Begin one optimistic mutation (pending until a journal event confirms). */
export function newPending(kind, worker, text, baseSeq) {
	return { kind, worker, text, baseSeq: typeof baseSeq === "number" ? baseSeq : 0, status: "pending", confirmedSeq: null, via: null, error: null };
}

/** Does one journal event confirm this pending mutation? */
export function matchesPending(pending, event) {
	return Boolean(
		pending &&
			event &&
			event.kind === pending.kind &&
			event.worker === pending.worker &&
			typeof event.seq === "number" &&
			event.seq > pending.baseSeq &&
			event.payload &&
			event.payload.text === pending.text,
	);
}

/** Fold journal events into the pending list (confirmed is terminal). */
export function reducePending(list, events) {
	const rows = Array.isArray(events) ? events : [];
	return (Array.isArray(list) ? list : []).map((p) => {
		if (p.status !== "pending") return p;
		const match = rows.find((e) => matchesPending(p, e));
		if (!match) return p;
		return { ...p, status: "confirmed", confirmedSeq: match.seq, via: match.payload && typeof match.payload.via === "string" ? match.payload.via : null };
	});
}

/** Mark a pending mutation failed (a structured error, never a silent drop). */
export function failPending(pending, error) {
	if (pending.status === "confirmed") return pending;
	return { ...pending, status: "failed", error: String(error) };
}

/** The pending mutation's honest display view. */
export function pendingView(pending) {
	if (!pending) return null;
	if (pending.status === "confirmed") {
		const via = pending.via === null || pending.via === undefined ? "" : ` via:"${pending.via}"`;
		return { status: "confirmed", label: "confirmed", detail: `confirmed by journal #${pending.confirmedSeq}${via}`, via: pending.via };
	}
	if (pending.status === "failed") return { status: "failed", label: "failed", detail: pending.error || "failed", via: null };
	if (pending.status === "unconfirmed") return { status: "unconfirmed", label: "delivered", detail: "delivered — journal confirmation unavailable", via: null };
	return { status: "pending", label: "pending", detail: "awaiting journal confirmation…", via: null };
}

/**
 * Fold the journal event graph into the open questions: the latest `ask` per
 * worker with no later `answer`.
 * <p>
 * FUNCTION_CONTRACT: Input — journal events ({seq, kind, worker, payload}).
 * Output — the open questions [{worker, question, context, options, seq}],
 * ordered by worker. Total and pure; never throws.
 */
export function pendingAsks(events) {
	const open = new Map();
	for (const e of Array.isArray(events) ? events : []) {
		if (!e || typeof e.worker !== "string") continue;
		if (e.kind === "ask") {
			const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
			open.set(e.worker, {
				worker: e.worker,
				question: typeof payload.question === "string" ? payload.question : "",
				context: typeof payload.context === "string" ? payload.context : null,
				options: Array.isArray(payload.options) ? payload.options : [],
				seq: e.seq,
			});
		} else if (e.kind === "answer") {
			open.delete(e.worker);
		}
	}
	return [...open.values()].sort((a, b) => (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : 0));
}

/**
 * The per-card control state: enabled or DISABLED-WITH-REASON (never hidden).
 * Foreign/unowned and ended workers are disabled; an `unavailable` console
 * (a backend without capture) still steers — the mutation surface is
 * independent of console capture. A worker with no session id can never have a
 * console state, so `hasSession:false` gets the honest terminal reason (NOT a
 * forever-pending "checking ownership…").
 */
export function controlsView(opts) {
	const consoleStatus = opts.consoleStatus;
	const pendingAsk = opts.pendingAsk && typeof opts.pendingAsk === "object" ? opts.pendingAsk : null;
	if (consoleStatus === "refused") return { disabled: true, reasonCode: "foreign", reason: "disabled: worker is not owned by this session (foreign fleet)", pendingAsk };
	if (consoleStatus === "ended" || consoleStatus === "ended-with-retained-backlog") return { disabled: true, reasonCode: "ended", reason: "disabled: worker ended", pendingAsk };
	if (opts.hasSession === false && (consoleStatus === undefined || consoleStatus === null || consoleStatus === "loading")) return { disabled: true, reasonCode: "no-session", reason: "disabled: no session id — cannot steer", pendingAsk };
	if (consoleStatus === undefined || consoleStatus === null || consoleStatus === "loading") return { disabled: true, reasonCode: "checking", reason: "disabled: checking ownership…", pendingAsk };
	return { disabled: false, reasonCode: null, reason: "", pendingAsk };
}
