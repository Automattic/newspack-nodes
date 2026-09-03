/**
 * Draws one segment file of a partition or log as a three-region fill bar.
 *
 * The worker-status tree renders a row of these per partition, and any
 * consumer holding a segment list plus a reader cursor can do the same. The
 * three regions separate what the reader has consumed, what it still owes, and
 * what the writer appended after the reader's last probe.
 */

import { memo, useState, useEffect } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { formatBytes } from '@newspack-nodes/shared/utils/formatters';

/**
 * One segment of a partition or log, as the worker-status payload carries it.
 *
 * @typedef {Object} Segment
 * @property {number} id      Segment number — the `{file}.{N}` suffix.
 * @property {number} size    Bytes the segment holds.
 * @property {number} [mtime] Last-write time in seconds. `Workers_CI` stats it;
 *                            `Log_Sources` does not, because
 *                            `Partition_Node::get_segments()` collects id and
 *                            size only. This bar never reads it.
 */

/**
 * Props for the segment bar.
 *
 * The four cursor/end props arrive together and describe the reader position:
 * null (or undefined) on `cursorSegment` means no consumer reads this log, and
 * the bar paints entirely gray.
 *
 * @typedef {Object} SegmentBarProps
 * @property {Segment} segment       Segment this bar draws.
 * @property {number}  maxSize       Denominator for every width: the log's
 *                                   declared rotation size, or the fleet-wide
 *                                   default. Every bar in the row shares it.
 * @property {?number} cursorSegment Reader cursor segment id (null = no consumer).
 * @property {?number} cursorOffset  Reader cursor offset within `cursorSegment`.
 * @property {?number} endSegment    Segment id of the partition end the reader
 *                                   recorded at its last probe, which lags the
 *                                   live head (null = no consumer).
 * @property {?number} endSize       Offset of that recorded end within
 *                                   `endSegment`.
 * @property {number}  [index]       Position in the row; staggers the fill
 *                                   animation.
 * @property {boolean} [isNew]       Segment appeared since the prior snapshot.
 * @property {boolean} [isRemoving]  Segment is gone, and drawn until it
 *                                   finishes animating out.
 */

/**
 * One segment as three fills: read, backlog, and live beyond the recorded end.
 *
 * Widths divide by `maxSize` rather than by the segment's own size, so a full
 * segment fills its bar and the newest, part-written one stays short. Bars are
 * then comparable across the row.
 *
 * The backlog is ONE color, picked by how far behind the reader has fallen:
 * amber while the recorded end sits in the cursor's own segment, red once it
 * has crossed into a later one. A log nothing reads paints entirely gray,
 * because both leading regions collapse to zero width.
 *
 * The stylesheet hides `segment-label-h` and `segment-size-h` in this layout,
 * so the `title` attribute is what surfaces the id and the size.
 *
 * @type {import('react').NamedExoticComponent<SegmentBarProps>}
 */
export const SegmentBar = memo( function SegmentBar( {
	segment,
	maxSize,
	cursorSegment,
	cursorOffset,
	endSegment,
	endSize,
	index = 0,
	isNew,
	isRemoving,
} ) {
	const size = segment.size;
	// A CSS transition skips mount, so draw 0-width and flip next frame.
	const [ drawn, setDrawn ] = useState( ! isNew );
	useEffect( () => {
		if ( drawn ) {
			return undefined;
		}
		const id = window.requestAnimationFrame( () => setDrawn( true ) );
		return () => window.cancelAnimationFrame( id );
	}, [ drawn ] );
	/**
	 * Width of one region as a percentage of the row's shared scale. Returns 0
	 * before the first paint, which is what animates a new segment in, and when
	 * `maxSize` is 0, which would otherwise divide by zero.
	 *
	 * @param {number} bytes Bytes the region covers.
	 * @return {number} Percentage of `maxSize`.
	 */
	const pct = ( bytes ) =>
		drawn && maxSize > 0 ? ( bytes / maxSize ) * 100 : 0;
	// Cursor and end arrive together; both are null when nothing reads.
	const hasConsumer = cursorSegment !== undefined && cursorSegment !== null;

	/**
	 * Bytes of THIS segment lying before a `(segment, offset)` boundary: the
	 * whole segment when the boundary is in a later one, the offset itself when
	 * it falls inside this one, zero when it is in an earlier one.
	 *
	 * @param {number} boundarySeg    Segment id the boundary sits in.
	 * @param {number} boundaryOffset Byte offset within that segment.
	 * @return {number} Bytes of this segment before the boundary.
	 */
	const bytesUpTo = ( boundarySeg, boundaryOffset ) => {
		if ( segment.id < boundarySeg ) {
			return size;
		}
		if ( segment.id === boundarySeg ) {
			return Math.min( boundaryOffset, size );
		}
		return 0;
	};

	// The read region ends at the cursor, the backlog at the recorded end.
	const readEnd = hasConsumer ? bytesUpTo( cursorSegment, cursorOffset ) : 0;
	const recordedEnd = hasConsumer ? bytesUpTo( endSegment, endSize ) : 0;
	// A stale probe end trails the cursor; max() keeps the backlog >= 0.
	const recorded = Math.max( readEnd, recordedEnd );

	// Backlog is ONE color: yellow within-segment, red across a boundary.
	const backlogClass = endSegment > cursorSegment ? '' : 'pending';

	const classNames = [
		'worker-segment-h',
		isNew ? 'segment-slide-in' : '',
		isRemoving ? 'segment-slide-out' : '',
	]
		.filter( Boolean )
		.join( ' ' );

	// Stagger fills left-to-right: each bar waits 0.3s per index (matches CSS).
	const segDelay = /** @type {import('react').CSSProperties} */ ( {
		'--seg-delay': `${ index * 0.3 }s`,
	} );

	return (
		<div
			className={ classNames }
			style={ segDelay }
			title={ sprintf(
				// translators: 1: segment id, 2: formatted segment size.
				__( 'Segment %1$d: %2$s', 'newspack-nodes' ),
				segment.id,
				formatBytes( size )
			) }
		>
			<div className="segment-label-h">{ segment.id }</div>
			<div className="segment-bar-h">
				<div
					className="segment-fill-h processed"
					style={ { width: `${ pct( readEnd ) }%` } }
				/>
				<div
					className={ `segment-fill-h ${ backlogClass }` }
					style={ { width: `${ pct( recorded - readEnd ) }%` } }
				/>
				<div
					className="segment-fill-h beyond"
					style={ { width: `${ pct( size - recorded ) }%` } }
				/>
			</div>
			<div className="segment-size-h">{ formatBytes( size ) }</div>
		</div>
	);
} );
