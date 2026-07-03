/**
 * SegmentBar — single segment bar visualization (horizontal bar layout).
 *
 * Shared by the worker-status tree (`TreeEntity`) and any consumer rendering a
 * partition/log's segment list. Extracted from WorkerStatus.js so the tree and
 * the Topology Manager don't depend on that module.
 */

import { memo, useState, useEffect } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { formatBytes } from './formatters';

/**
 * Single segment bar visualization (horizontal bar layout).
 *
 * @param {Object}  props               Component props.
 * @param {Object}  props.segment       Segment data { id, size, mtime }.
 * @param {number}  props.maxSize       Max segment size for scaling.
 * @param {number}  props.cursorSegment Reader cursor segment ID (null = no consumer).
 * @param {number}  props.cursorOffset  Reader cursor offset within cursorSegment.
 * @param {number}  props.endSegment    Recorded probe-end segment ID (null = no consumer).
 * @param {number}  props.endSize       Recorded probe-end offset within endSegment.
 * @param {number}  props.index         Position in the row; staggers the fill animation.
 * @param {boolean} props.isNew         Whether this segment is newly appeared.
 * @param {boolean} props.isRemoving    Whether this segment is being removed.
 * @return {import('react').ReactElement} Rendered component.
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
	// A new segment mounts with empty fills, then flips to real widths next frame
	// so the staggered width transition animates them in (transitions don't fire
	// on mount). Existing segments draw at full width immediately.
	const [ drawn, setDrawn ] = useState( ! isNew );
	useEffect( () => {
		if ( drawn ) {
			return undefined;
		}
		const id = window.requestAnimationFrame( () => setDrawn( true ) );
		return () => window.cancelAnimationFrame( id );
	}, [ drawn ] );
	const pct = ( bytes ) =>
		drawn && maxSize > 0 ? ( bytes / maxSize ) * 100 : 0;
	// cursor + end arrive together; a tree with no consumer of this log has both null.
	const hasConsumer = cursorSegment !== undefined && cursorSegment !== null;

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
	const readEnd = hasConsumer ? bytesUpTo( cursorSegment, cursorOffset ) : 0;
	const recordedEnd = hasConsumer ? bytesUpTo( endSegment, endSize ) : 0;
	const recorded = Math.max( readEnd, recordedEnd );

	// The whole backlog is ONE color: yellow when the lag stays within the segment
	// the cursor is in, red when it spans a segment boundary (a bigger fall-behind).
	const backlogClass = endSegment > cursorSegment ? '' : 'pending';

	const classNames = [
		'worker-segment-h',
		isNew ? 'segment-slide-in' : '',
		isRemoving ? 'segment-slide-out' : '',
	]
		.filter( Boolean )
		.join( ' ' );

	// Stagger the fill/offset transition left-to-right: each bar waits one bar's
	// duration (0.3s, matching the .segment-fill-h transition) per index, so it
	// starts as the previous bar finishes. The slide-left keyframe is unaffected.
	const segDelay = { '--seg-delay': `${ index * 0.3 }s` };

	return (
		<div
			className={ classNames }
			style={ segDelay }
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
