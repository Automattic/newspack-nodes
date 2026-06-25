/**
 * TimeTravelPanel — read-and-drive view over a Consumer's offsetlog keyframes.
 * Reads `frames` ([{id,size}], oldest→newest by id) straight from the inspected
 * node's dump_metadata; no fetch, no request.
 *
 * Position is a CLIENT-SIDE model with three pieces of state:
 *   - `paused`           — PAUSE gates the whole transport. While !paused the only
 *                          live button is ⏸ Pause; the consumer is following the
 *                          head and you can only stop it.
 *   - `parkedFrameId`    — id | null. null ⇒ live / following the head (the cursor
 *                          sits past the newest keyframe). A concrete id ⇒ the user
 *                          parked here via rewind/fast-forward. A parked id that
 *                          ages out of the retained window clamps back to null.
 *   - `steppedSincePark` — true once STEP has advanced the cursor PAST the parked
 *                          keyframe; the cursor is now between keyframes, so the
 *                          next rewind SNAPS BACK to the keyframe rather than the
 *                          one before it.
 *
 * Selection is NEVER derived from the live source `cursor` — a frame id is its
 * OFFSETLOG segment id (monotonic, climbs forever), an independent number space
 * from `cursor.seg` (the SOURCE partition segment), so matching them only
 * coincides near zero. The live `cursor` ({seg,off}) is DISPLAYED as the source
 * read position, nothing more.
 *
 * The transport bar drives the consumer's `:config` verbs through the inspector's
 * invoke path via onTransport( verb, positional ): PAUSE / PLAY / STEP send the
 * bare verb; rewind / fast-forward send SEEK_FRAME <segment_id> for the snapped
 * keyframe (a paused keyframe scrub among the retained frames — there is no
 * fast-forward into the unknown).
 */

import { useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

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

function Ruler( { frames, selectedFrameId, stepped } ) {
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
			{ frames.map( ( f, i ) => {
				const isCurrent = f.id === selectedFrameId;
				const cls = [
					'topology-tt__marker',
					isCurrent && 'topology-tt__marker--current',
					isCurrent && stepped && 'topology-tt__marker--stepped',
				]
					.filter( Boolean )
					.join( ' ' );
				return (
					<span
						key={ f.id }
						data-frame-id={ f.id }
						className={ cls }
						style={ { left: `${ i * step }%` } }
						title={ `frame seg ${ f.id } · ${ f.size } B` }
					/>
				);
			} ) }
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

// Where the cursor sits, in words. `selectedFrameId`/`nextId` are the parked
// keyframe and the one after it; nextId is null when parked on (or past) the
// newest.
function positionLabel( { live, stepped, selectedFrameId, newestId, nextId } ) {
	if ( live ) {
		return stepped
			? sprintf(
					// translators: %d is an offsetlog frame id.
					__( 'stepped past frame %d', 'newspack-nodes' ),
					newestId
			  )
			: sprintf(
					// translators: %d is an offsetlog frame id.
					__( 'live — after frame %d', 'newspack-nodes' ),
					newestId
			  );
	}
	if ( ! stepped ) {
		return sprintf(
			// translators: %d is an offsetlog frame id.
			__( 'on frame %d', 'newspack-nodes' ),
			selectedFrameId
		);
	}
	if ( null === nextId ) {
		return sprintf(
			// translators: %d is an offsetlog frame id.
			__( 'after frame %d', 'newspack-nodes' ),
			selectedFrameId
		);
	}
	return sprintf(
		// translators: %1$d and %2$d are adjacent offsetlog frame ids.
		__( 'between frame %1$d and %2$d', 'newspack-nodes' ),
		selectedFrameId,
		nextId
	);
}

export default function TimeTravelPanel( {
	frames = [],
	cursor = null,
	onTransport,
} ) {
	const [ paused, setPaused ] = useState( false );
	const [ parkedFrameId, setParkedFrameId ] = useState( null );
	const [ steppedSincePark, setSteppedSincePark ] = useState( false );

	const newestId = frames.length ? frames[ frames.length - 1 ].id : null;
	// A parked id that has aged out of the retained window is treated as live.
	const live =
		null === parkedFrameId ||
		! frames.some( ( f ) => f.id === parkedFrameId );
	const selectedFrameId = live ? newestId : parkedFrameId;

	const currentIdx = frames.findIndex( ( f ) => f.id === selectedFrameId );
	const nextId =
		currentIdx >= 0 && currentIdx < frames.length - 1
			? frames[ currentIdx + 1 ].id
			: null;

	// Enable/disable: PAUSE gates everything. While !paused only Pause is live.
	const canPause = ! paused;
	const canPlay = paused;
	const canStep = paused;
	// Rewind: disabled when live-paused on an empty ruler, or when sitting on the
	// oldest keyframe with nothing stepped past it (no earlier keyframe to land on).
	const onOldest = ! live && currentIdx <= 0;
	const canRewind =
		paused && frames.length > 0 && ! ( onOldest && ! steppedSincePark );
	// Fast-forward only walks the retained keyframes ahead of the parked one —
	// never live (nothing ahead of the head) and never on the newest.
	const canForward = paused && ! live && null !== nextId;

	const seekTo = ( id ) => {
		setParkedFrameId( id );
		setSteppedSincePark( false );
		if ( onTransport ) {
			onTransport( 'SEEK_FRAME', String( id ) );
		}
	};

	const rewind = () => {
		if ( ! canRewind ) {
			return;
		}
		if ( live ) {
			seekTo( newestId ); // first rewind from live lands on the newest
		} else if ( steppedSincePark ) {
			seekTo( parkedFrameId ); // snap back to the current keyframe
		} else {
			seekTo( frames[ currentIdx - 1 ].id ); // previous keyframe
		}
	};

	const forward = () => {
		if ( ! canForward ) {
			return;
		}
		seekTo( nextId );
	};

	const step = () => {
		if ( ! canStep ) {
			return;
		}
		setSteppedSincePark( true );
		if ( onTransport ) {
			onTransport( 'STEP', '' );
		}
	};

	const pause = () => {
		if ( ! canPause ) {
			return;
		}
		setPaused( true ); // leave parkedFrameId untouched: live-but-paused
		if ( onTransport ) {
			onTransport( 'PAUSE', '' );
		}
	};

	const play = () => {
		if ( ! canPlay ) {
			return;
		}
		setPaused( false );
		setParkedFrameId( null ); // resume following the head
		setSteppedSincePark( false );
		if ( onTransport ) {
			onTransport( 'PLAY', '' );
		}
	};

	return (
		<div className="topology-tt">
			<Cursor cursor={ cursor } />
			<Ruler
				frames={ frames }
				selectedFrameId={ selectedFrameId }
				stepped={ steppedSincePark }
			/>
			{ frames.length > 0 && (
				<div className="topology-tt__position">
					{ positionLabel( {
						live,
						stepped: steppedSincePark,
						selectedFrameId,
						newestId,
						nextId,
					} ) }
				</div>
			) }
			<div className="topology-tt__transport">
				<TransportButton
					label={ __( 'Rewind to previous frame', 'newspack-nodes' ) }
					glyph="⏮"
					disabled={ ! canRewind }
					onClick={ rewind }
				/>
				<TransportButton
					label={ __( 'Pause', 'newspack-nodes' ) }
					glyph="⏸"
					disabled={ ! canPause }
					onClick={ pause }
				/>
				<TransportButton
					label={ __( 'Step one message', 'newspack-nodes' ) }
					glyph="▌▶"
					disabled={ ! canStep }
					onClick={ step }
				/>
				<TransportButton
					label={ __( 'Play', 'newspack-nodes' ) }
					glyph="▶"
					disabled={ ! canPlay }
					onClick={ play }
				/>
				<TransportButton
					label={ __(
						'Fast-forward to next frame',
						'newspack-nodes'
					) }
					glyph="⏭"
					disabled={ ! canForward }
					onClick={ forward }
				/>
			</div>
		</div>
	);
}
