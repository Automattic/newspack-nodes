/**
 * TimeTravelPanel — read-and-drive view over a Consumer's offsetlog keyframes.
 * Reads `frames` ([{id,size}], oldest→newest by id) straight from the inspected
 * node's dump_metadata; no fetch, no request. Frame selection is a CLIENT-SIDE
 * model: `selectedFrameId` defaults to the newest frame and is the cursor the
 * ruler highlights and that rewind/fast-forward walk. It is NOT derived from the
 * live source `cursor` — a frame id is its OFFSETLOG segment id (monotonic,
 * climbs forever), an independent number space from `cursor.seg` (the SOURCE
 * partition segment), so matching them only coincides near zero. The live
 * `cursor` ({seg,off}) is DISPLAYED as the source read position, nothing more.
 *
 * The transport bar drives the consumer's `:config` verbs through the
 * inspector's invoke path via onTransport( verb, positional ): PAUSE / PLAY /
 * STEP send the bare verb; rewind / fast-forward send SEEK_FRAME <segment_id>
 * for the frame adjacent to the current selection (a paused keyframe scrub among
 * the retained frames — there is no fast-forward into the unknown).
 */

import { useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

function Cursor( { cursor } ) {
	if ( ! cursor ) {
		return null;
	}
	const seg = cursor.seg ?? '—';
	const off = cursor.off ?? '—';
	return (
		<div className="topology-field-row">
			<span className="topology-field-row__key">
				{ __( 'cursor', 'newspack-nodes' ) }
			</span>
			<span className="topology-field-row__val topology-field-row__val--num">
				{ `${ seg }:${ off }` }
			</span>
		</div>
	);
}

function Ruler( { frames, selectedFrameId } ) {
	if ( ! frames.length ) {
		return (
			<div className="topology-tt__empty">
				{ __( 'No keyframes yet.', 'newspack-nodes' ) }
			</div>
		);
	}
	const step = frames.length > 1 ? 100 / ( frames.length - 1 ) : 0;
	return (
		<div className="topology-tt__ruler">
			{ frames.map( ( f, i ) => (
				<span
					key={ f.id }
					data-frame-id={ f.id }
					className={ `topology-tt__marker${
						f.id === selectedFrameId
							? ' topology-tt__marker--current'
							: ''
					}` }
					style={ { left: `${ i * step }%` } }
					title={ `frame seg ${ f.id } · ${ f.size } B` }
				/>
			) ) }
		</div>
	);
}

// One transport-bar button. Disabled buttons render but don't fire.
function TransportButton( { label, glyph, disabled, onClick } ) {
	return (
		<button
			type="button"
			className="topology-tt__transport-btn"
			aria-label={ label }
			title={ label }
			disabled={ disabled }
			onClick={ onClick }
		>
			{ glyph }
		</button>
	);
}

export default function TimeTravelPanel( {
	frames = [],
	cursor = null,
	onTransport,
} ) {
	const newestId = frames.length ? frames[ frames.length - 1 ].id : null;
	// Client-side selection: default to the newest frame. The live source cursor
	// does NOT drive this (offsetlog id ≠ source seg — two number spaces).
	const [ selectedFrameId, setSelectedFrameId ] = useState( newestId );

	// Clamp when node.frames changes (new frames after PLAY, or truncation): if
	// the selected id is gone, snap back to the newest.
	useEffect( () => {
		if ( ! frames.some( ( f ) => f.id === selectedFrameId ) ) {
			setSelectedFrameId( newestId );
		}
	}, [ frames, selectedFrameId, newestId ] );

	const currentIdx = frames.findIndex( ( f ) => f.id === selectedFrameId );
	const hasPrev = currentIdx > 0;
	const hasNext = currentIdx >= 0 && currentIdx < frames.length - 1;

	const seek = ( idx ) => {
		const id = frames[ idx ].id;
		setSelectedFrameId( id );
		if ( onTransport ) {
			onTransport( 'SEEK_FRAME', String( id ) );
		}
	};
	const fire = ( verb ) => onTransport && onTransport( verb, '' );

	return (
		<div className="topology-tt">
			<Cursor cursor={ cursor } />
			<Ruler frames={ frames } selectedFrameId={ selectedFrameId } />
			<div className="topology-tt__transport">
				<TransportButton
					label={ __( 'Rewind to previous frame', 'newspack-nodes' ) }
					glyph="⏮"
					disabled={ ! hasPrev }
					onClick={ () => seek( currentIdx - 1 ) }
				/>
				<TransportButton
					label={ __( 'Pause', 'newspack-nodes' ) }
					glyph="⏸"
					onClick={ () => fire( 'PAUSE' ) }
				/>
				<TransportButton
					label={ __( 'Step one message', 'newspack-nodes' ) }
					glyph="▌▶"
					onClick={ () => fire( 'STEP' ) }
				/>
				<TransportButton
					label={ __( 'Play', 'newspack-nodes' ) }
					glyph="▶"
					onClick={ () => fire( 'PLAY' ) }
				/>
				<TransportButton
					label={ __(
						'Fast-forward to next frame',
						'newspack-nodes'
					) }
					glyph="⏭"
					disabled={ ! hasNext }
					onClick={ () => seek( currentIdx + 1 ) }
				/>
			</div>
		</div>
	);
}
