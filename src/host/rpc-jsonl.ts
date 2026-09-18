/**
 * pi-delegate — src/host/rpc-jsonl.ts: strict byte-buffer JSONL parser for
 * the rpc adapter's stdout pump (issue #13).
 *
 * LEAF MODULE: node builtins only, zero imports from src/ — the adapter
 * imports THIS, never the other way (mirrors the adapter isolation rule in
 * rpc.ts's contract).
 *
 * Protocol (rpc.ts's verified framing notes — generic line readers are
 * non-compliant per pi docs/rpc.md):
 *   - records split on LF (\n) ONLY — U+2028/U+2029 inside JSON strings are
 *     data, never delimiters (their UTF-8 bytes are 0xE2 0x80 0xA8/0xA9 and
 *     never collide with the 0x0A scan);
 *   - ONE trailing CR stripped per record (CRLF-tolerant framing);
 *   - accumulation is raw BYTES end to end — a multi-byte UTF-8 character
 *     split across two fed chunks decodes exactly once, at record boundary,
 *     so the round-trip is byte-exact (the defect this module replaces:
 *     per-chunk `chunk.toString("utf8")` mangled such splits into U+FFFD);
 *   - an incomplete final record is retained until the next chunk or close();
 *   - malformed records are CLASSIFIED diagnostics (malformed flag + counted),
 *     never silently dropped.
 */

/** One complete JSONL record: the exact raw bytes before the delimiter (CR
 *  already stripped), the parsed JSON value (null when malformed), and the
 *  malformed classification flag. */
export interface RpcJsonlRecord {
	raw: Buffer;
	parsed: unknown;
	malformed: boolean;
	/** True when the record exceeded maxRecordBytes (parsed stays null). */
	oversized: boolean;
}

export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024; // 8 MiB
export const DEFAULT_MALFORMED_THRESHOLD = 10;

export class RpcJsonlParser {
	private buffer: Buffer = Buffer.alloc(0);
	private malformedCount = 0;
	private recordIndex = 0;
	private readonly maxRecordBytes: number;
	private readonly onOversized?: (size: number) => void;
	private readonly onMalformed?: (raw: Buffer, index: number) => void;
	private readonly malformedThreshold: number;
	/** True once an oversized record was observed (fatal by contract — a
	 *  runaway child would otherwise grow the buffer unbounded). */
	oversized = false;

	constructor(
		options: {
			/** Per-record size cap in bytes (default DEFAULT_MAX_RECORD_BYTES). */
			maxRecordBytes?: number;
			/** Called with the size of each rejected oversized record. */
			onOversized?: (size: number) => void;
			/** Called with each malformed record's raw bytes and its record index. */
			onMalformed?: (raw: Buffer, index: number) => void;
			/** Malformed-record budget; exceeding it escalates to a protocol
			 *  failure (exceededMalformedThreshold — the pump's escalation
			 *  signal). Default DEFAULT_MALFORMED_THRESHOLD. */
			malformedThreshold?: number;
		} = {},
	) {
		this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
		this.onOversized = options.onOversized;
		this.onMalformed = options.onMalformed;
		this.malformedThreshold = options.malformedThreshold ?? DEFAULT_MALFORMED_THRESHOLD;
	}

	/** Total malformed records observed so far (classified diagnostics). */
	get malformedRecords(): number {
		return this.malformedCount;
	}

	/** Protocol-failure signal: strictly MORE malformed records than the
	 *  bounded threshold allows. */
	get exceededMalformedThreshold(): boolean {
		return this.malformedCount > this.malformedThreshold;
	}

	/** Feed one stdout chunk (bytes or already-decoded string); returns every
	 *  COMPLETE record it terminates — zero or more, in order. */
	feed(chunk: Buffer | string): RpcJsonlRecord[] {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
		const out: RpcJsonlRecord[] = [];
		for (;;) {
			const lf = this.buffer.indexOf(0x0a); // LF only
			if (lf === -1) break;
			let recordBytes = this.buffer.subarray(0, lf);
			// Strip ONE trailing CR (CRLF tolerance). U+2028/U+2029 are 0xE2
			// 0x80 0xA8/0xA9 in UTF-8 and never 0x0D — the strip stays safe.
			if (recordBytes.length > 0 && recordBytes[recordBytes.length - 1] === 0x0d) {
				recordBytes = recordBytes.subarray(0, recordBytes.length - 1);
			}
			this.buffer = this.buffer.subarray(lf + 1);
			out.push(this.acceptRecord(recordBytes));
		}
		return out;
	}

	/** Flush an incomplete final record (stdout close / process exit). */
	close(): RpcJsonlRecord[] {
		if (this.buffer.length === 0) return [];
		const recordBytes = this.buffer;
		this.buffer = Buffer.alloc(0);
		return [this.acceptRecord(recordBytes)];
	}

	private acceptRecord(raw: Buffer): RpcJsonlRecord {
		const index = this.recordIndex++;
		if (raw.length > this.maxRecordBytes) {
			this.oversized = true;
			this.onOversized?.(raw.length);
			return { raw, parsed: null, malformed: true, oversized: true };
		}
		let parsed: unknown = null;
		let malformed = false;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch {
			parsed = null;
			malformed = true;
			this.malformedCount += 1;
			this.onMalformed?.(raw, index);
		}
		return { raw, parsed, malformed, oversized: false };
	}
}
