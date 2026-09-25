/**
 * mutations.js — the dashboard's steering/answer pipeline (issue #54).
 *
 * The optimistic-with-confirmation half of the app, lifted out of app.js so
 * the shell stays a shell. A POST creates a pending marker; the success branch
 * settles it from the server envelope's additive `confirmation` field (#69
 * operator ruling): `"confirmed"` when the journal row is durably appended,
 * `"unavailable"` in files storage mode (no row will exist — the honest
 * `unconfirmed`/"delivered" state) or on an advisory append failure. A marker
 * settles `failed` on a structured error. A marker whose pre-#62 server
 * envelope has no `confirmation` field keeps the old wait-for-journal
 * behavior (`fold`/`reducePending` — the journal is the truth there). A
 * rejected operator token re-prompts at most MAX_AUTH_RETRIES times and NEVER
 * stacks a second marker.
 *
 * Browser seams (fetch/storage/prompt) and render callbacks are injected. No
 * DOM.
 */

import { clearToken, failPending, newPending, pendingView, postMutation, readToken, reducePending, writeToken } from "./steer.js";

/** Re-prompt cap for a rejected operator token (no infinite 401 recursion). */
export const MAX_AUTH_RETRIES = 3;

/**
 * Create the mutation pipeline.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — { fetch, storage, prompt, currentSeq(), onTokenState(state),
 *   onChange(), onError(err) }
 * Output: { get pending(), get tokenState(), fold(events), sendSteer(w,t),
 *   sendAnswer(w,t) }
 * Guarantees: never throws out of sendSteer/sendAnswer; the token stays in
 *   sessionStorage only; a cap reached is an honest terminal `rejected`.
 *   sendSteer/sendAnswer return a STRUCTURED outcome ({ sent, reason }) — a
 *   dismissed/empty token prompt emits an `aborted` marker ("no token —
 *   nothing sent"), never a silent no-op (#93).
 */
export function createMutations(opts) {
	const fetchImpl = opts.fetch;
	const storage = opts.storage;
	const promptImpl = opts.prompt;
	const currentSeq = opts.currentSeq || (() => 0);
	const onTokenState = opts.onTokenState || (() => {});
	const onChange = opts.onChange || (() => {});
	let pendingList = [];

	const ensureToken = (reason) => {
		const existing = readToken(storage);
		if (existing) {
			onTokenState("set");
			return existing;
		}
		if (!promptImpl) return null;
		const answer = promptImpl(reason || "operator token (printed on the session's stderr at mount):");
		if (typeof answer !== "string" || answer.trim().length === 0) return null;
		writeToken(storage, answer.trim());
		onTokenState("set");
		return answer.trim();
	};

	const errorText = (res) => (res && res.envelope && res.envelope.error ? `${res.envelope.error.code}: ${res.envelope.error.message}` : "mutation failed");

	const submit = async (kind, worker, text, token, attempt = 0) => {
		// Dedup: an auth re-prompt recurses with the SAME text — reuse the one
		// outstanding marker instead of stacking a second pending row.
		let pending = pendingList.find((p) => p.status === "pending" && p.kind === kind && p.worker === worker && p.text === text);
		if (!pending) {
			pending = newPending(kind, worker, text, currentSeq());
			pendingList = [...pendingList, pending];
			onChange();
		}
		const res = await postMutation({ fetch: fetchImpl, token, kind, id: worker, text });
		if (!res.ok) {
			if (res.authRequired) {
				clearToken(storage);
				if (attempt < MAX_AUTH_RETRIES) {
					onTokenState("re-prompt");
					const fresh = ensureToken("operator token rejected — re-enter it:");
					if (fresh) return submit(kind, worker, text, fresh, attempt + 1);
				}
				// Cap reached: an honest terminal state, never an infinite prompt loop.
				onTokenState("rejected");
			}
			pendingList = pendingList.map((p) => (p === pending ? failPending(p, errorText(res)) : p));
			onChange();
		} else {
			// #69 operator ruling — settle the marker from the envelope's
			// `confirmation` state instead of always waiting for a journal event:
			//   "confirmed" (journal mode): the row is already durable — take the
			//     seq/via straight from the envelope;
			//   "unavailable" (files mode, §4.1.3): no journal row will ever
			//     arrive — show the honest "delivered" state (steer.js
			//     pendingView), never a forever-pending spinner;
			//   absent (a pre-#62 server): keep waiting for the journal event
			//     (fold/reducePending) — old servers stay fully supported.
			const confirmation = res.envelope && res.envelope.confirmation;
			if (confirmation === "confirmed" || confirmation === "unavailable") {
				pendingList = pendingList.map((p) => {
					if (p !== pending) return p;
					if (confirmation === "unavailable") return { ...p, status: "unconfirmed" };
					const seq = res.envelope.journal && typeof res.envelope.journal.seq === "number" ? res.envelope.journal.seq : null;
					return { ...p, status: "confirmed", confirmedSeq: seq, via: typeof res.envelope.via === "string" ? res.envelope.via : null };
				});
				onChange();
			}
		}
		return res;
	};

	// #93: the prompt was cancelled/empty — record the honest terminal marker so
	// the panel shows "no token — nothing sent" instead of a silent no-op.
	const abort = (kind, worker, text) => {
		pendingList = [...pendingList, { ...newPending(kind, worker, text, currentSeq()), status: "aborted", error: "no token \u2014 nothing sent" }];
		onChange();
	};

	const send = async (kind, worker, text) => {
		if (typeof text !== "string" || text.trim().length === 0) return { sent: false, reason: "empty" };
		const token = ensureToken();
		if (!token) {
			abort(kind, worker, text);
			return { sent: false, reason: "no-token" };
		}
		const res = await submit(kind, worker, text, token);
		return { sent: res.ok, reason: res.ok ? "sent" : "rejected", status: res.status, authRequired: res.authRequired };
	};

	return {
		get pending() {
			return pendingList.map(pendingView);
		},
		get tokenState() {
			return readToken(storage) ? "set" : "absent";
		},
		fold(events) {
			pendingList = reducePending(pendingList, events);
		},
		/** The latest pending view for one worker+kind (the detail panel's line). */
		latestPending(worker, kind) {
			const p = [...pendingList].reverse().find((x) => x.worker === worker && x.kind === kind);
			return p ? pendingView(p) : null;
		},
		sendSteer: (worker, text) => send("steer", worker, text),
		sendAnswer: (worker, text) => send("answer", worker, text),
	};
}
