/**
 * SegmentBar — single segment bar visualization (horizontal bar layout).
 *
 * Shared by the worker-status tree (`TreeEntity`) and any consumer rendering a
 * partition/log's segment list. Extracted from WorkerStatus.js so the tree and
 * the Topology Manager don't depend on that module.
 */

import { memo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { formatBytes } from './formatters';

/**
 * Single segment bar visualization (horizontal bar layout).
 *
 * @param {Object}  props              Component props.
 * @param {Object}  props.segment      Segment data { id, size, mtime }.
 * @param {number}  props.maxSize      Max segment size for scaling.
 * @param {number}  props.cursorSeg    Reader cursor segment ID (null = no consumer).
 * @param {number}  props.cursorOffset Reader cursor offset within cursorSeg.
 * @param {number}  props.endSeg       Recorded probe-end segment ID (null = no consumer).
 * @param {number}  props.endSize      Recorded probe-end offset within endSeg.
 * @param {boolean} props.isNew        Whether this segment is newly appeared.
 * @param {boolean} props.isRemoving   Whether this segment is being removed.
 * @return {import('react').ReactElement} Rendered component.
 */
export const SegmentBar = memo( function SegmentBar( {
	segment,
	maxSize,
	cursorSeg,
	cursorOffset,
	endSeg,
	endSize,
	isNew,
	isRemoving,
} ) {
	const size = segment.size;
	const pct = ( bytes ) => ( maxSize > 0 ? ( bytes / maxSize ) * 100 : 0 );
	// cursor + end arrive together; a tree with no consumer of this log has both null.
	const hasConsumer = cursorSeg !== undefined && cursorSeg !== null;

	// Bytes of THIS segment up to a (boundarySeg, boundaryOffset) marker: whole
	// segment if the marker is past it, the offset if the marker is inside it,
	// 0 if the marker is before it.
	const bytesUpTo = ( boundarySeg, boundaryOffset ) => {
		if ( segment.id < boundarySeg ) {
			return size;
		}
		if ( segment.id === boundarySeg ) {
			return Math.min( boundaryOffset, size );
		}
		return 0;
	};

	// Green stops at the read cursor; red/yellow backlog stops at the recorded
	// probe end; gray fills past it to the live head. No consumer → all gray.
	const readEnd = hasConsumer ? bytesUpTo( cursorSeg, cursorOffset ) : 0;
	const recordedEnd = hasConsumer ? bytesUpTo( endSeg, endSize ) : 0;
	const recorded = Math.max( readEnd, recordedEnd );

	// The whole backlog is ONE color: yellow when the lag stays within the segment
	// the cursor is in, red when it spans a segment boundary (a bigger fall-behind).
	const backlogClass = endSeg > cursorSeg ? '' : 'pending';

	const classNames = [
		'worker-segment-h',
		isNew ? 'segment-slide-in' : '',
		isRemoving ? 'segment-slide-out' : '',
	]
		.filter( Boolean )
		.join( ' ' );

	return (
		<div
			className={ classNames }
			title={ sprintf(
				// translators: 1: segment id, 2: formatted segment size.
				__( 'Segment %1$s: %2$s', 'newspack-nodes' ),
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
