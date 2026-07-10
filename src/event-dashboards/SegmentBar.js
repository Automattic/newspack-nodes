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
	// New segment mounts empty, flips to real widths next frame to animate in.
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
	// cursor + end arrive together; no consumer of this log → both are null.
	const hasConsumer = cursorSegment !== undefined && cursorSegment !== null;

	// Bytes of THIS segment up to a (seg, offset) marker (0 if before it).
	const bytesUpTo = ( boundarySeg, boundaryOffset ) => {
		if ( segment.id < boundarySeg ) {
			return size;
		}
		if ( segment.id === boundarySeg ) {
			return Math.min( boundaryOffset, size );
		}
		return 0;
	};

	// Green: to read cursor; backlog: to recorded end; gray to head; none→gray.
	const readEnd = hasConsumer ? bytesUpTo( cursorSegment, cursorOffset ) : 0;
	const recordedEnd = hasConsumer ? bytesUpTo( endSegment, endSize ) : 0;
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
