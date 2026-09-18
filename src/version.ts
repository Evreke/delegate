/**
 * pi-delegate — src/version.ts: the single runtime version source.
 *
 * MODULE_CONTRACT: one exported constant — the extension version the RUNNING
 * process executes, stamped into tool results so a stale copy is
 * self-evident instead of indistinguishable from a regression (the R7
 * idea borrowed from @maheidem/pi-delegate: "the executing version in every
 * result header"). This file is the ONE runtime source of the version
 * (Law 9 — one artifact, one source of truth): package.json stays the
 * packaging authority, and test/static-check.ts pins the two equal
 * mechanically (drift fails CI, never a review).
 *
 * Dependencies: none (a leaf by construction). Zero I/O, zero imports —
 * safe to read from any module, including the seam's neighbors.
 *
 * Critical invariants:
 *   - bump this constant IN THE SAME commit that bumps package.json
 *     (the static pin fails the build otherwise);
 *   - never read the version from package.json at runtime (the extension
 *     ships src/ and package.json together, but a jiti-loaded extension
 *     must not depend on JSON import-attribute support).
 */

/** The executing extension version. Sync-pin: test/static-check.ts. */
export const EXTENSION_VERSION = "1.17.1";
