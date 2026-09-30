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
 * Where a log's reader stands: its cursor, and the end it recorded at its last
 * probe, which lags the live head.
 *
 * @typedef {Object} ReaderPosition
 * @property {number} segment    Cursor segment id.
 * @property {number} offset     Cursor offset within `segment`.
 * @property {number} endSegment Segment id of the recorded end.
 * @property {number} endSize    Offset of that end within `endSegment`.
 */

/**
 * Props for the segment bar.
 *
 * The three region props come from `segmentRegions`, which the row computes
 * once per bar; with no consumer they are all zero and the bar paints gray.
 *
 * @typedef {Object} SegmentBarProps
 * @property {Segment}              segment      Segment this bar draws.
 * @property {number}               maxSize      Denominator for every width: the log's
 *                                               declared rotation size, or the fleet-wide
 *                                               default. Every bar in the row shares it.
 * @property {number}               read         Bytes of the segment the reader consumed.
 * @property {number}               recorded     Bytes up to the end the reader recorded at
 *                                               its last probe, never below `read`.
 * @property {boolean}              crossed      The recorded end lies in a later segment
 *                                               than the cursor, so the backlog is red.
 * @property {number}               [stagger]    Bars between this one and the row's
 *                                               first animated change; the stylesheet
 *                                               delays the fill that many steps.
 * @property {boolean}              [snap]       Draw the final widths with no fill
 *                                               transition, because the bar stopped being
 *                                               the live tail or arrived complete.
 * @property {boolean}              [isNew]      Segment arrived since the row last drew.
 *                                               It slides in, and its fills grow from 0
 *                                               unless `snap` draws them final.
 * @property {boolean}              [isRemoving] Segment is gone, and drawn until it
 *                                               finishes animating out.
 * @property {(id: number) => void} [onSlidOut]  Called with the segment id
 *                                               when a departing bar's slide-out ends.
 */

/**
 * Where the reader's two boundaries fall inside one segment, and whether the
 * backlog has crossed out of the cursor's segment.
 *
 * `LogRows` computes these once per bar, compares them across polls to find
 * which bars changed, and hands them to the bar that draws them.
 *
 * @param {Segment}        segment  The segment.
 * @param {ReaderPosition} [cursor] Where the reader stands; undefined when no
 *                                  consumer reads the log.
 * @return {{read: number, recorded: number, crossed: boolean}} Bytes read,
 *   bytes up to the recorded end (never below `read`), and whether that end
 *   lies past the cursor's segment; 0, 0 and false when nothing reads the log.
 */
export function segmentRegions( segment, cursor ) {
	if ( ! cursor ) {
		return { read: 0, recorded: 0, crossed: false };
	}
	/**
	 * Bytes of THIS segment lying before a `(segment, offset)` boundary: the
	 * whole segment when the boundary is in a later one, the offset itself
	 * when it falls inside this one, zero when it is in an earlier one.
	 *
	 * @param {number} boundarySeg    Segment id the boundary sits in.
	 * @param {number} boundaryOffset Byte offset within that segment.
	 * @return {number} Bytes of this segment before the boundary.
	 */
	const bytesUpTo = ( boundarySeg, boundaryOffset ) => {
		if ( segment.id < boundarySeg ) {
			return segment.size;
		}
		if ( segment.id === boundarySeg ) {
			return Math.min( boundaryOffset, segment.size );
		}
		return 0;
	};
	const read = bytesUpTo( cursor.segment, cursor.offset );
	// A stale probe end trails the cursor; max() keeps the backlog >= 0.
	return {
		read,
		recorded: Math.max(
			read,
			bytesUpTo( cursor.endSegment, cursor.endSize )
		),
		crossed: cursor.endSegment > cursor.segment,
	};
}

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
 * Fills transition their widths, delayed `stagger` steps so a change sweeping
 * several bars runs one bar at a time from the first bar it touched; the
 * stylesheet owns the step, and the bar hands it only the count. `snap`
 * turns the transition off for one render: only the live tail's growth is
 * worth watching, so a bar a newer segment now follows, or one that arrived
 * complete, shows its final content the moment it slides.
 *
 * A departing bar reports its own slide-out ending through `onSlidOut`, which
 * is what lets its row drop it: the animation, not a timer, says when.
 *
 * @type {import('react').NamedExoticComponent<SegmentBarProps>}
 */
export const SegmentBar = memo( function SegmentBar( {
	segment,
	maxSize,
	read,
	recorded,
	crossed,
	stagger = 0,
	snap,
	isNew,
	isRemoving,
	onSlidOut,
} ) {
	const size = segment.size;
	// A CSS transition skips mount, so draw 0-width and flip next frame.
	const [ drawn, setDrawn ] = useState( ! isNew || !! snap );
	useEffect( () => {
		if ( drawn ) {
			return undefined;
		}
		const id = window.requestAnimationFrame( () => setDrawn( true ) );
		return () => window.cancelAnimationFrame( id );
	}, [ drawn ] );
	/**
	 * Width of one region as a percentage of the row's shared scale. Returns 0
	 * before the first paint, which is what grows a new tail in, and when
	 * `maxSize` is 0, which would otherwise divide by zero.
	 *
	 * @param {number} bytes Bytes the region covers.
	 * @return {number} Percentage of `maxSize`.
	 */
	const pct = ( bytes ) =>
		drawn && maxSize > 0 ? ( bytes / maxSize ) * 100 : 0;

	// Backlog is ONE color: yellow within-segment, red across a boundary.
	const backlogClass = crossed ? '' : 'pending';

	const classNames = [
		'worker-segment-h',
		isNew ? 'segment-slide-in' : '',
		isRemoving ? 'segment-slide-out' : '',
		snap ? 'segment-snap' : '',
	]
		.filter( Boolean )
		.join( ' ' );

	const segStagger = /** @type {import('react').CSSProperties} */ ( {
		'--seg-stagger': stagger,
	} );

	/**
	 * Report the slide-out's end, the moment the departed bar may leave. The
	 * name test skips a fill's transition or any other animation ending here.
	 *
	 * @param {import('react').AnimationEvent} event The animationend event.
	 */
	const onAnimationEnd = ( event ) => {
		if ( isRemoving && 'segment-slide-out' === event.animationName ) {
			onSlidOut?.( segment.id );
		}
	};

	return (
		<div
			className={ classNames }
			style={ segStagger }
			onAnimationEnd={ onAnimationEnd }
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
					style={ { width: `${ pct( read ) }%` } }
				/>
				<div
					className={ `segment-fill-h ${ backlogClass }` }
					style={ { width: `${ pct( recorded - read ) }%` } }
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
