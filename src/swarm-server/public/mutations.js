/**
 * mutations.js — the dashboard's steering/answer pipeline (issue #54).
 *
 * The optimistic-with-confirmation half of the app, lifted out of app.js so
 * the shell stays a shell. A POST creates a pending marker; it becomes
 * `confirmed` ONLY when the matching journal `steer`/`answer` row arrives
 * (`fold(events)` — the journal is the truth; #62 makes HTTP mutations journal
 * in every storage mode, so there is no files-mode special case) and `failed`
 * on a structured error. A rejected operator token re-prompts at most
 * MAX_AUTH_RETRIES times and NEVER stacks a second marker.
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
		}
		return res;
	};

	const send = async (kind, worker, text) => {
		if (typeof text !== "string" || text.trim().length === 0) return null;
		const token = ensureToken();
		if (!token) return null;
		return submit(kind, worker, text, token);
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
