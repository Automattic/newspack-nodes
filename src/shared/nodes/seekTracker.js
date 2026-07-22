/**
 * SeekTracker — the node-side seek/position tracker for log-stream view nodes.
 *
 * A view node that streams a segmented log wants two Kafka-UI feedback signals as
 * records arrive: which segment the last record came FROM (the rail highlight),
 * and whether a replay has CAUGHT UP to the live tail (Replay→Live flip). Both
 * derive from each record's `segment:offset:length` ID breadcrumb; this class owns
 * that derivation so the Partition Viewer, the Log Viewer, and the ELN Request /
 * Error Log view nodes share ONE implementation instead of three copies.
 *
 * It is deliberately NOT a React hook — it is plain node-side state a view node
 * composes (`this.seek = new SeekTracker()`) and drives from `fill()`. The view
 * node owns publishing; `track()` returns whether anything the view publishes
 * changed (segment or mode), so the view publishes on change only (no per-record
 * setState storm).
 *
 * Modes:
 * - `browse(endSegment, endOffset)` — enter replay, capturing the live boundary a
 *   replayed record must reach to be "caught up". A NULL `endSegment` enters
 *   replay with NO auto-flip: this is the file-mode opaque-inode contract (a Tail
 *   over a raw file puts the file's inode — unorderable — in the segment slot, so
 *   there is no meaningful numeric end to catch up to; the caller flips manually).
 * - `follow()` — return to the live tail, dropping the boundary.
 * - `select()` — a fresh subscription: live from a clean slate (also forgets the
 *   last-received segment so the rail highlight resets).
 */

// A record's Message ID position breadcrumb: `segment:offset:length`.
const ID_POSITION_RE = /^(\d+):(\d+):(\d+)$/;

/**
 * The live boundary a replay must reach to be "caught up": the newest segment's
 * id and its byte size, from a `log_status` segment list. Null when no segment
 * carries a numeric id (e.g. file-mode sources) — pass to `SeekTracker.browse`
 * as a null end so it enters replay with no auto-flip.
 *
 * @param {Array<{id?:number,size?:number}>} segments The `log_status` segments.
 * @return {{segment:number,offset:number}|null} The boundary, or null.
 */
export function endPosition( segments ) {
	let segment = null;
	let offset = 0;
	for ( const s of segments ) {
		if (
			'number' === typeof s?.id &&
			( null === segment || s.id > segment )
		) {
			segment = s.id;
			offset = s.size ?? 0;
		}
	}
	return null === segment ? null : { segment, offset };
}

export class SeekTracker {
	constructor() {
		// 'live' tails the head; 'replay' browses until caught up.
		this.mode = 'live';
		this.lastReceivedSegment = null;
		// Live boundary captured at seek; replay catches up on reaching it.
		this.endSegment = null;
		this.endOffset = 0;
	}

	// Enter replay, capturing the live boundary (null end → no auto-flip).
	browse( endSegment = null, endOffset = 0 ) {
		this.mode = 'replay';
		this.endSegment = endSegment;
		this.endOffset = endOffset;
	}

	// Return to the live tail; drop the catch-up boundary.
	follow() {
		this.mode = 'live';
		this.endSegment = null;
	}

	// Fresh subscription: live from a clean slate (drops the highlight too).
	select() {
		this.mode = 'live';
		this.endSegment = null;
		this.lastReceivedSegment = null;
	}

	/**
	 * Track a record's `segment:offset:length` ID breadcrumb.
	 *
	 * @param {*} id The record's Message ID (a breadcrumb string, else ignored).
	 * @return {boolean} True when the received segment changed or the mode
	 *   flipped — the caller's publish-on-change gate.
	 */
	track( id ) {
		const match = ID_POSITION_RE.exec( 'string' === typeof id ? id : '' );
		if ( ! match ) {
			return false;
		}
		const segment = Number( match[ 1 ] );
		const offsetEnd = Number( match[ 2 ] ) + Number( match[ 3 ] );
		const segmentChanged = segment !== this.lastReceivedSegment;
		this.lastReceivedSegment = segment;
		// Caught up to the seek boundary: past it is live tail → flip live.
		let modeChanged = false;
		if (
			'replay' === this.mode &&
			null !== this.endSegment &&
			( segment > this.endSegment ||
				( segment === this.endSegment && offsetEnd >= this.endOffset ) )
		) {
			this.mode = 'live';
			this.endSegment = null;
			modeChanged = true;
		}
		return segmentChanged || modeChanged;
	}
}
