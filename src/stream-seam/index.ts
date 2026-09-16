/**
 * pi-delegate — src/stream-seam module entry point (see fidelity-store.ts for
 * the full module contract; types.ts for the store-level surface contracts).
 * The wire envelope (ConsoleEvent/ConsoleEventKind) and the Transport seam
 * method live in src/host.ts.
 */
export { FidelityStore, DEFAULT_RING_CAP, APPROX_BYTES_PER_EVENT_OVERHEAD } from "./fidelity-store.ts";
export type { FidelityStoreOptions } from "./fidelity-store.ts";
export type { ConsoleStream, Subscription, SubscriptionOptions, ConsoleEvent, ConsoleEventKind } from "./types.ts";
