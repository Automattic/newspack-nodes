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

/**
 * Matches a record's Message ID position breadcrumb, `segment:offset:length`.
 * An ID in any other shape — a command reply, an opaque hash — carries no
 * position, so `track()` ignores it.
 */
const ID_POSITION_RE = /^(\d+):(\d+):(\d+)$/;

/** The mode value for a view tailing the live head. */
export const LIVE = 'live';

/**
 * The mode value for a view replaying history, held until a record reaches the
 * boundary `browse()` captured.
 */
export const REPLAY = 'replay';

/**
 * Derive the whole `browse` control for a source, in the shape
 * `LogStreamViewNode._control()` accepts: the newest segment id, that
 * segment's byte size, and every segment id the footprint lists, which a
 * replayed record must leave or reach the end of to count as caught up. A
 * file source lists itself as one segment, its inode at the file's size,
 * which is the slot a Tail over the file stamps its breadcrumbs with.
 * Returning half the control leaves every consumer to invent the other half,
 * and three of them invent three.
 *
 * @param {Object}                           source            The source row.
 * @param {Array<{id?:number,size?:number}>} [source.segments] Segment list.
 * @return {{action:string,endSegment:number,endOffset:number,knownSegments:number[]}|{action:string}}
 *   A `browse` control, or `follow` when the source carries no boundary.
 * @throws {TypeError} When a segment newer than every segment before it carries
 *   no numeric size.
 */
export function browseControl( { segments = [] } ) {
	const boundary = endPosition( segments );
	if ( null === boundary ) {
		// No boundary to catch up to — replay would never flip back to live.
		return { action: 'follow' };
	}
	return {
		action: 'browse',
		endSegment: boundary.segment,
		endOffset: boundary.offset,
		knownSegments: segments
			.map( ( s ) => s?.id )
			.filter( ( id ) => 'number' === typeof id ),
	};
}

/**
 * The live boundary a replay must reach to be "caught up": the newest segment's
 * id and its byte size, from a segment list (`dump_log.segments`). Null when
 * no segment carries a numeric id.
 *
 * Module-private, because `browseControl()` is the whole control and the only
 * surface a consumer needs; an exported half is a half every consumer completes
 * its own way.
 *
 * @param {Array<{id?:number,size?:number}>} segments The `{id, size}` segments.
 * @return {{segment:number,offset:number}|null} The boundary, or null.
 * @throws {TypeError} When a segment newer than every segment before it carries
 *   no numeric size.
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
		const match = ID_POSITION_RE.exec( 'string' === typeof id ? id : '' );
		if ( ! match ) {
			return false;
		}
		const segment = Number( match[ 1 ] );
		const offsetEnd = Number( match[ 2 ] ) + Number( match[ 3 ] );
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
	 * as caught up: the newest segment id, that segment's byte size, and every
	 * segment id the footprint listed, which for a file source are its inode
	 * and its size. A null segment enters a replay that never auto-flips,
	 * leaving the flip to the caller.
	 *
	 * @param {?number}  endSegment      The end segment id, or null for no boundary.
	 * @param {number}   endOffset       The catch-up byte boundary.
	 * @param {number[]} [knownSegments] Every segment id the footprint listed;
	 *                                   required with an end segment.
	 * @throws {TypeError} When an end segment comes without its footprint's
	 *   ids, which would flip to Live on the first record.
	 */
	browse( endSegment = null, endOffset = 0, knownSegments ) {
		if ( null !== endSegment && ! Array.isArray( knownSegments ) ) {
			throw new TypeError(
				`browse to segment ${ endSegment } names no knownSegments`
			);
		}
		this.mode = REPLAY;
		// Pre-seek breadcrumb is stale: highlight falls to the clicked item.
		this.lastReceivedSegment = null;
		this.endSegment = endSegment;
		this.endOffset = endOffset;
		this.knownSegments = new Set( knownSegments );
	}
}
