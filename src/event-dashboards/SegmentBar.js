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
 * @param {number}  props.cursorSeg    Current cursor segment ID.
 * @param {number}  props.cursorOffset Current cursor offset.
 * @param {number}  props.newestSegId  ID of the newest segment.
 * @param {boolean} props.isNew        Whether this segment is newly appeared.
 * @param {boolean} props.isRemoving   Whether this segment is being removed.
 * @return {import('react').ReactElement} Rendered component.
 */
export const SegmentBar = memo( function SegmentBar( {
	segment,
	maxSize,
	cursorSeg,
	cursorOffset,
	newestSegId,
	isNew,
	isRemoving,
} ) {
	const fillPercent = maxSize > 0 ? ( segment.size / maxSize ) * 100 : 0;
	// No cursor (output-only log) → treat all segments as processed.
	const hasReader = cursorSeg !== undefined && cursorSeg !== null;
	const isCurrent = hasReader && segment.id === cursorSeg;
	const isProcessed = ! hasReader || segment.id < cursorSeg;
	const isNewest = segment.id === newestSegId;

	const processedPercent =
		isCurrent && segment.size > 0
			? ( cursorOffset / segment.size ) * fillPercent
			: 0;
	const pendingPercent = isCurrent ? fillPercent - processedPercent : 0;
	const pendingClass = isNewest ? 'pending' : ''; // Yellow only for newest, red otherwise.

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
				formatBytes( segment.size )
			) }
		>
			<div className="segment-label-h">{ segment.id }</div>
			<div className="segment-bar-h">
				{ isCurrent ? (
					<>
						<div
							className="segment-fill-h processed"
							style={ { width: `${ processedPercent }%` } }
						/>
						<div
							className={ `segment-fill-h ${ pendingClass }` }
							style={ { width: `${ pendingPercent }%` } }
						/>
					</>
				) : (
					<div
						className={ `segment-fill-h ${
							isProcessed ? 'processed' : ''
						}` }
						style={ { width: `${ fillPercent }%` } }
					/>
				) }
			</div>
			<div className="segment-size-h">
				{ formatBytes( segment.size ) }
			</div>
		</div>
	);
} );
