/**
 * TimeTravelPanel — read-and-drive view over a Consumer's offsetlog keyframes.
 * Reads `frames` ([{id,size}], oldest→newest by id) straight from the inspected
 * node's dump_metadata; no fetch, no request.
 *
 * Position is a CLIENT-SIDE model, but each piece is SEEDED from and RECONCILED to
 * a consumer-reported signal (dump_metadata) so the panel reflects the real
 * consumer and survives a remount — transport clicks drive it optimistically for
 * instant feedback, and the next poll's signal reconciles. Three pieces of state:
 *   - `paused`   — PAUSE gates the whole transport. While !paused the only live
 *                  button is ⏸ Pause; the consumer is following the head and you can
 *                  only stop it. The metadata `paused` signal is the source of truth;
 *                  an `optimistic` override (null = defer to the signal) gives the
 *                  click instant feedback until the next signal reconciles it.
 *   - `atFrame`  — id | null. The keyframe the cursor is at-or-just-past — its
 *                  current checkpoint. While live it tracks the newest frame (the
 *                  cursor reads forward from its last checkpoint); seeked, it's the
 *                  keyframe scrubbed to. null only when there are no frames yet.
 *                  Seeded from / reconciled to `atFrameSignal`. An atFrame that ages
 *                  out of the retained window clamps to the newest frame.
 *   - `onFrame`  — the cursor sits EXACTLY on atFrame's committed position vs has
 *                  advanced past it. !onFrame ⇒ between keyframes, so the next rewind
 *                  SNAPS onto atFrame rather than the one before it. Seeded from /
 *                  reconciled to `onFrameSignal`. A quiet live consumer is onFrame
 *                  (reads "on frame N"); an actively-reading one is off it.
 *
 * Selection is NEVER derived from the live source `cursor` — a frame id is its
 * OFFSETLOG segment id (monotonic, climbs forever), an independent number space
 * from `cursor.segment` (the SOURCE partition segment), so matching them only
 * coincides near zero. The live `cursor` ({segment,offset}) is DISPLAYED as the source
 * read position, nothing more.
 *
 * The transport bar drives the consumer's `:config` verbs through the inspector's
 * invoke path via onTransport( verb, positional ): PAUSE / PLAY / STEP send the
 * bare verb; rewind / fast-forward send SEEK_FRAME <segment> for the snapped
 * keyframe (a paused keyframe scrub among the retained frames — there is no
 * fast-forward into the unknown).
 */

import { useEffect, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

function Cursor( { cursor } ) {
	if ( ! cursor ) {
		return null;
	}
	const segment = cursor.segment ?? '—';
	const offset = cursor.offset ?? '—';
	return (
		<div className="topology-field-row">
			<span className="topology-field-row__key">
				{ __( 'cursor', 'newspack-nodes' ) }
			</span>
			<span className="topology-field-row__val topology-field-row__val--num">
				{ `${ segment }:${ offset }` }
			</span>
		</div>
	);
}

function Ruler( { frames, selectedFrameId, offFrame } ) {
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
					isCurrent && offFrame && 'topology-tt__marker--stepped',
				]
					.filter( Boolean )
					.join( ' ' );
				return (
					<span
						key={ f.id }
						data-frame-id={ f.id }
						className={ cls }
						style={ { left: `${ i * step }%` } }
						title={ `frame segment ${ f.id } · ${ f.size } B` }
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

// Cursor position, in words. atFrame/nextId bracket the retained window.
function positionLabel( { onFrame, paused, selectedFrameId, nextId } ) {
	if ( onFrame ) {
		return sprintf(
			// translators: %d is an offsetlog frame id.
			__( 'on frame %d', 'newspack-nodes' ),
			selectedFrameId
		);
	}
	// Off-frame: paused reads "between X and Y", live reads "after X".
	if ( paused && null !== nextId ) {
		return sprintf(
			// translators: %1$d and %2$d are adjacent offsetlog frame ids.
			__( 'between frame %1$d and %2$d', 'newspack-nodes' ),
			selectedFrameId,
			nextId
		);
	}
	return sprintf(
		// translators: %d is an offsetlog frame id.
		__( 'after frame %d', 'newspack-nodes' ),
		selectedFrameId
	);
}

export default function TimeTravelPanel( {
	frames = [],
	cursor = null,
	paused: pausedSignal = false,
	atFrameSignal = null,
	onFrameSignal = false,
	onTransport,
} ) {
	// Optimistic override: null defers to metadata; a bool gives instant feedback.
	const [ optimistic, setOptimistic ] = useState( null );
	useEffect( () => setOptimistic( null ), [ pausedSignal ] );
	const paused = null !== optimistic ? optimistic : !! pausedSignal;
	// Seed from consumer signals; clicks drive optimistically, polls reconcile.
	const [ atFrame, setAtFrame ] = useState( atFrameSignal );
	const [ onFrame, setOnFrame ] = useState( onFrameSignal );
	useEffect( () => setAtFrame( atFrameSignal ), [ atFrameSignal ] );
	useEffect( () => setOnFrame( onFrameSignal ), [ onFrameSignal ] );

	const newestId = frames.length ? frames[ frames.length - 1 ].id : null;
	// An atFrame aged out of the retained window clamps to the newest frame.
	const selectedFrameId = frames.some( ( f ) => f.id === atFrame )
		? atFrame
		: newestId;

	const currentIdx = frames.findIndex( ( f ) => f.id === selectedFrameId );
	const nextId =
		currentIdx >= 0 && currentIdx < frames.length - 1
			? frames[ currentIdx + 1 ].id
			: null;
	const onOldest = currentIdx <= 0;
	const onNewest = null === nextId;

	// Enable/disable: PAUSE gates everything. While !paused only Pause is live.
	const canPause = ! paused;
	const canPlay = paused;
	const canStep = paused;
	// Rewind needs an earlier landing point; oldest on-frame has none.
	const canRewind = paused && frames.length > 0 && ! ( onFrame && onOldest );
	// Fast-forward walks retained keyframes ahead of atFrame — never the newest.
	const canForward = paused && ! onNewest;

	const seekTo = ( id ) => {
		setAtFrame( id );
		setOnFrame( true );
		if ( onTransport ) {
			onTransport( 'SEEK_FRAME', String( id ) );
		}
	};

	const rewind = () => {
		if ( ! canRewind ) {
			return;
		}
		if ( ! onFrame ) {
			seekTo( selectedFrameId ); // snap onto the current keyframe
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
		setOnFrame( false ); // optimistic: the cursor advances off the frame
		if ( onTransport ) {
			onTransport( 'STEP', '' );
		}
	};

	const pause = () => {
		if ( ! canPause ) {
			return;
		}
		setOptimistic( true ); // instant feedback; leave the position untouched
		if ( onTransport ) {
			onTransport( 'PAUSE', '' );
		}
	};

	const play = () => {
		if ( ! canPlay ) {
			return;
		}
		setOptimistic( false ); // resume following head; next signal reconciles
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
				offFrame={ ! onFrame }
			/>
			{ frames.length > 0 && (
				<div className="topology-tt__position">
					{ positionLabel( {
						onFrame,
						paused,
						selectedFrameId,
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
