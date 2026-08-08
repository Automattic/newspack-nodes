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

/** Tailing the head. */
export const LIVE = 'live';

/** Browsing history until a replayed record reaches the captured boundary. */
export const REPLAY = 'replay';

/**
 * The `browse` control for a source, as `LogStreamViewNode._control()` accepts
 * it — the whole deliverable, not half of one.
 *
 * Both boundary shapes live here because they are one decision. A segmented
 * source catches up on `(newest id, its size)`. A file-mode source has no
 * orderable segment (a Tail over a raw file puts the opaque inode in the
 * segment slot), so it catches up on byte size alone and flips on inode
 * rotation. Splitting the two put half the rule in this module and half inline
 * in one consumer, which is why three call sites could never agree.
 *
 * @param {Object}                           source            The source row.
 * @param {Array<{id?:number,size?:number}>} [source.segments] Segment list.
 * @param {number}                           [source.bytes]    File-mode size.
 * @return {{action:string,endSegment:?number,endOffset:number}|{action:string}}
 *   A `browse` control, or `follow` when the source carries no boundary.
 * @throws {TypeError} When the boundary segment carries no numeric size.
 */
export function browseControl( { segments = [], bytes = 0 } ) {
	const boundary = endPosition( segments );
	if ( null !== boundary ) {
		return {
			action: 'browse',
			endSegment: boundary.segment,
			endOffset: boundary.offset,
		};
	}
	if ( bytes > 0 ) {
		return { action: 'browse', endSegment: null, endOffset: bytes };
	}
	// No boundary to catch up to — replay would never flip back to live.
	return { action: 'follow' };
}

/**
 * The live boundary a replay must reach to be "caught up": the newest segment's
 * id and its byte size, from a segment list (`log_status.segments` or `taillog
 * sources[].segments` — same shape). Null when no segment carries a numeric id,
 * which is the file-mode case `browseControl` answers with a byte boundary.
 *
 * Module-private: `browseControl()` is the whole deliverable and the only
 * surface consumers need. Exporting the half is what let three of them build
 * the other half three different ways.
 *
 * @param {Array<{id?:number,size?:number}>} segments The `{id, size}` segments.
 * @return {{segment:number,offset:number}|null} The boundary, or null.
 * @throws {TypeError} When the newest segment carries no numeric size.
 */
function endPosition( segments ) {
	let segment = null;
	let offset = 0;
	for ( const s of segments ) {
		if (
			'number' === typeof s?.id &&
			( null === segment || s.id > segment )
		) {
			segment = s.id;
			// endOffset IS the catch-up test; a 0 flips on record one.
			if ( 'number' !== typeof s.size ) {
				throw new TypeError(
					`segment ${ s.id } carries no numeric size`
				);
			}
			offset = s.size;
		}
	}
	return null === segment ? null : { segment, offset };
}

/**
 * Node-side seek state for a log-stream view node: the segment the last record
 * arrived from, and whether a replay has caught up to the live tail. A view node
 * composes one (`this.seek = new SeekTracker()`), drives `track()` from `fill()`,
 * and publishes only when `track()` reports a change. See the module docblock
 * above for the mode contract, including the null-segment file-mode case.
 */
export class SeekTracker {
	/**
	 * Start live at the head, with no received segment and no catch-up boundary.
	 */
	constructor() {
		this.select();
	}

	/**
	 * Reset for a fresh subscription: live from a clean slate. Unlike `follow()`,
	 * this also forgets the last received segment, so the rail highlight clears.
	 */
	select() {
		this.follow();
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
		// File-mode replay pins the first inode as the reference generation.
		if (
			this.fileMode &&
			REPLAY === this.mode &&
			null === this.referenceSegment
		) {
			this.referenceSegment = segment;
		}
		// Caught up to the seek boundary: past it is live tail → flip live.
		let modeChanged = false;
		if ( REPLAY === this.mode && this._caughtUp( segment, offsetEnd ) ) {
			this.follow();
			modeChanged = true;
		}
		return segmentChanged || modeChanged;
	}

	/**
	 * Return to the live tail, dropping the catch-up boundary. The last received
	 * segment survives, so the rail highlight stays where the records are.
	 *
	 * The ONE cleared shape: `select()` is this plus forgetting the breadcrumb,
	 * the constructor is `select()`, and the replay→live flip is this. Four
	 * hand-maintained copies meant a new field would reach three of them.
	 */
	follow() {
		this.mode = LIVE;
		this.endSegment = null;
		this.endOffset = 0;
		this.fileMode = false;
		this.referenceSegment = null;
	}

	/**
	 * Whether a replayed record has reached the boundary captured at `browse()`.
	 *
	 * @param {number} segment   The record's segment id (an inode in file mode).
	 * @param {number} offsetEnd The record's end byte, `offset + length`.
	 * @return {boolean} True once the record is at or past the live boundary.
	 */
	_caughtUp( segment, offsetEnd ) {
		if ( this.fileMode ) {
			// Opaque inode: caught up by size, or when a new inode rotates in.
			return (
				segment !== this.referenceSegment || offsetEnd >= this.endOffset
			);
		}
		// Segmented: ordered ids — past the end segment, or reached its size.
		return (
			null !== this.endSegment &&
			( segment > this.endSegment ||
				( segment === this.endSegment && offsetEnd >= this.endOffset ) )
		);
	}

	/**
	 * Enter replay, capturing the catch-up boundary. Segmented: (endSegment,
	 * size). File mode: null segment + a positive byte size (catch up by size,
	 * or on inode rotation). Null segment + 0/absent size → never auto-flips.
	 *
	 * @param {?number} endSegment The end segment id, or null for file mode.
	 * @param {number}  endOffset  The catch-up byte boundary.
	 */
	browse( endSegment = null, endOffset = 0 ) {
		this.mode = REPLAY;
		// Pre-seek breadcrumb is stale: highlight falls to the clicked item.
		this.lastReceivedSegment = null;
		this.endSegment = endSegment;
		this.endOffset = endOffset;
		this.fileMode = null === endSegment && endOffset > 0;
		this.referenceSegment = null;
	}
}
