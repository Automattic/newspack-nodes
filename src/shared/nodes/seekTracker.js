/**
 * The node-side seek and position tracking behind every log-stream view node.
 *
 * A view node streaming a segmented log owes its UI two feedback signals as
 * records arrive: which segment the last record came FROM, which the rail
 * highlights, and whether a replay has caught up to the live tail, which flips
 * the view from Replay back to Live. Both derive from each record's
 * `segment:offset:length` ID breadcrumb, and this module owns that derivation so
 * the Log Viewer and the ELN Request / Error Log view nodes share ONE implementation instead of three.
 *
 * `SeekTracker` is deliberately not a React hook. It is plain node-side state,
 * and the view node keeps ownership of publishing: `track()` reports whether
 * anything the view publishes changed, so the view publishes on change instead
 * of once per record.
 */

import { parseCrumb } from '../../runtime/log-position';

/** The mode value for a view tailing the live head. */
export const LIVE = 'live';

/**
 * The mode value for a view replaying history, held until a record reaches the
 * boundary `browse()` captured.
 */
export const REPLAY = 'replay';

/**
 * Derive the whole `browse` control for a source, in the shape
 * `LogStreamViewNode._control()` accepts: the source's footprint, from which
 * `SeekTracker.browse()` reads the boundary — the newest segment, its byte
 * size, and every segment id listed, which a replayed record must leave or
 * reach the end of to count as caught up. A file source lists itself as one
 * segment, its inode at the file's size, which is the slot a Tail over the
 * file stamps its breadcrumbs with.
 *
 * This builder is where a footprint is validated, because the view applies
 * the control from `fill()`, where nothing would catch a throw.
 *
 * @param {Object}                           source            The source row.
 * @param {Array<{id?:number,size?:number}>} [source.segments] Segment list.
 * @return {{action:string,segments:Array<{id?:number,size?:number}>}|{action:string}}
 *   A `browse` control, or `follow` when no segment carries a numeric id, so
 *   there is no boundary to catch up to.
 * @throws {TypeError} When the newest segment carries no numeric size: the
 *   boundary offset IS the catch-up test, so a guessed 0 would flip the replay
 *   to live on its first record.
 */
export function browseControl( { segments = [] } ) {
	const boundary = endPosition( segments );
	if ( null === boundary ) {
		return { action: 'follow' };
	}
	if ( 'number' !== typeof boundary.offset ) {
		throw new TypeError(
			`segment ${ boundary.segment } carries no numeric size`
		);
	}
	return { action: 'browse', segments };
}

/**
 * The live boundary a replay must reach to be "caught up": the newest segment's
 * id and its byte size, from a segment list (`dump_log.segments`). Null when
 * no segment carries a numeric id.
 *
 * Module-private: `browseControl()` validates through it, and
 * `SeekTracker.browse()` reads the boundary of the control it built.
 *
 * @param {Array<{id?:number,size?:number}>} segments The `{id, size}` segments.
 * @return {{segment:number,offset:(number|undefined)}|null} The boundary, or
 *   null; the offset is the newest segment's size as listed.
 */
function endPosition( segments ) {
	let newest = null;
	for ( const s of segments ) {
		if (
			'number' === typeof s?.id &&
			( null === newest || s.id > newest.id )
		) {
			newest = s;
		}
	}
	return null === newest ? null : { segment: newest.id, offset: newest.size };
}

/**
 * The seek state one log-stream view node keeps: the segment the last record
 * arrived from, and whether a replay has caught up to the live tail.
 *
 * A view node composes one (`this.seek = new SeekTracker()`) and drives
 * `track()` from `fill()`. `mode` holds `LIVE` or `REPLAY`; `browse()`,
 * `follow()` and `select()` move between them, and `track()` leaves replay on
 * its own once a record reaches the captured boundary.
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
	 * Record where one arriving record sits, from its `segment:offset:length` ID
	 * breadcrumb, and leave replay once that position reaches the boundary
	 * `browse()` captured. An ID in any other shape carries no position and
	 * changes nothing.
	 *
	 * @param {*} id The record's Message ID; a non-breadcrumb ID is ignored.
	 * @return {boolean} True when the received segment changed or the mode
	 *   flipped, which is the caller's publish-on-change gate.
	 */
	track( id ) {
		const crumb = parseCrumb( id );
		if ( ! crumb ) {
			return false;
		}
		const segment = crumb.segment;
		const offsetEnd = crumb.offset + crumb.length;
		const segmentChanged = segment !== this.lastReceivedSegment;
		this.lastReceivedSegment = segment;
		// At or past the seek boundary, the record is live tail: go live.
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
	 * This method is the ONE cleared shape: `select()` is this plus forgetting
	 * the breadcrumb, the constructor is `select()`, and `track()`'s flip out of
	 * replay calls it. Four hand-maintained copies would leave a new field out of
	 * three of them.
	 */
	follow() {
		this.mode = LIVE;
		this.endSegment = null;
		this.endOffset = 0;
		this.knownSegments = new Set();
	}

	/**
	 * Whether a replayed record has reached the boundary captured at `browse()`:
	 * it comes from a segment the footprint did not list, which is a newer one
	 * or a file's next generation, since ids do not order a file's inodes; or
	 * it reaches the end segment's captured size.
	 *
	 * @param {number} segment   The record's segment id (a file source's inode).
	 * @param {number} offsetEnd The record's end byte, `offset + length`.
	 * @return {boolean} True once the record is at or past the live boundary.
	 */
	_caughtUp( segment, offsetEnd ) {
		return (
			null !== this.endSegment &&
			( ! this.knownSegments.has( segment ) ||
				( segment === this.endSegment && offsetEnd >= this.endOffset ) )
		);
	}

	/**
	 * Enter replay, capturing the boundary a replayed record must reach to count
	 * as caught up, read once from the footprint: every segment id it lists, the
	 * newest of which is the end segment, and that segment's byte size — for a
	 * file source its inode and its size. A footprint naming no segment enters a
	 * replay that never auto-flips, leaving the flip to the caller.
	 *
	 * @param {Array<{id?:number,size?:number}>} [segments] The validated footprint.
	 */
	browse( segments = [] ) {
		const boundary = endPosition( segments );
		this.mode = REPLAY;
		// Pre-seek breadcrumb is stale: highlight falls to the clicked item.
		this.lastReceivedSegment = null;
		this.endSegment = boundary?.segment ?? null;
		this.endOffset = boundary?.offset ?? 0;
		this.knownSegments = new Set(
			segments
				.map( ( s ) => s?.id )
				.filter( ( id ) => 'number' === typeof id )
		);
	}
}
