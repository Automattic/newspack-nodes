/**
 * SidecarsPopover — the grid an owner's "…" opens, drawn on the canvas so it
 * pans and zooms with it: below the owner's card, a notch on its top edge
 * pointing up at the card, each sidecar the owned node the canvas never
 * draws, as the card the canvas would draw for it, live off the sidecar
 * poller's rows and its own rate map. Picking a card shows that sidecar's
 * Inspector; a card owning sidecars in turn draws a "…", and the grid that
 * opens hangs inside this one, below that card. Focus stays on the canvas,
 * which names this grid's active card; while it holds that card the canvas's
 * keys are its own. An arrow picks the nearest card that way, the view
 * following, Enter or Space picks the active card, and Enter on one owning
 * sidecars opens their grid too.
 *
 * Everything is SVG laid out in world units, the canvas's own, so a grid card
 * is the size of a canvas card at every zoom, and it draws through the
 * canvas's clips and bloom: one bloomed layer of frames, the readouts over it.
 * Its host closes it.
 */

import { useEffect, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { ARROWS, nearestInDirection } from '../utils/keyboardNav';
import {
	FocusRing,
	NODE_SHADOW,
	NodeCard,
	NodeReadout,
	SidecarsTrigger,
	cardDomId,
	formatNodeRate,
	sparklinePath,
} from './NodeCard';

/** @typedef {import('../../runtime/metadata-node').MetadataGraphNode} MetadataGraphNode */
/** @typedef {import('../hooks/useGraphRates').RateEntry} RateEntry */
/** @typedef {{x: number, y: number, w: number, h: number}} Box */

/** Space between two cards. */
const GAP = 12;

/** Space between the frame and the cards inside it. */
const PAD = 14;

/** The notch's height, and half its base. */
const NOTCH = 10;

/** The frame's corner radius. */
const RADIUS = 6;

/**
 * Where a grid of `count` cards sits below the card drawn at `anchor`:
 * centred on it, the notch's tip at its bottom edge, as near square as whole
 * rows allow, each card drawn at the owner card's size, as the canvas draws
 * every card at one size.
 *
 * @param {Box}    anchor The owner card as drawn.
 * @param {number} count  How many cards the grid holds.
 * @return {{cols: number, w: number, h: number, pitchX: number, pitchY: number, tipX: number, tipY: number, gridX: number, gridY: number, gridW: number, gridH: number}} The layout.
 */
function layout( anchor, count ) {
	const cols = Math.max( Math.ceil( Math.sqrt( count ) ), 1 );
	const rows = Math.max( Math.ceil( count / cols ), 1 );
	const cardW = anchor.w + NODE_SHADOW;
	const cardH = anchor.h + NODE_SHADOW;
	const gridW = cols * cardW + ( cols - 1 ) * GAP;
	const tipX = anchor.x + anchor.w / 2;
	const tipY = anchor.y + cardH;
	return {
		cols,
		w: anchor.w,
		h: anchor.h,
		pitchX: cardW + GAP,
		pitchY: cardH + GAP,
		tipX,
		tipY,
		gridX: tipX - gridW / 2,
		gridY: tipY + NOTCH + PAD,
		gridW,
		gridH: rows * cardH + ( rows - 1 ) * GAP,
	};
}

/**
 * One card's box in a grid.
 *
 * @param {ReturnType<typeof layout>} at The grid's layout.
 * @param {number}                    i  The card's place in it.
 * @return {Box} The card as drawn, in world units.
 */
function cardAt( at, i ) {
	return {
		x: at.gridX + ( i % at.cols ) * at.pitchX,
		y: at.gridY + Math.floor( i / at.cols ) * at.pitchY,
		w: at.w,
		h: at.h,
	};
}

/**
 * A card's box alone, as the canvas reveals it.
 *
 * @param {Box} card The card, with whatever else it carries.
 * @return {Box} Its box.
 */
function boxOf( { x, y, w, h } ) {
	return { x, y, w, h };
}

/**
 * The frame's outline: one path, so the notch and the body share one fill and
 * one stroke with no seam between them.
 *
 * @param {ReturnType<typeof layout>} at The grid's layout.
 * @return {string} The path's `d`.
 */
function framePath( { tipX, tipY, gridX, gridY, gridW, gridH } ) {
	const left = gridX - PAD;
	const right = gridX + gridW + PAD;
	const top = tipY + NOTCH;
	const bottom = gridY + gridH + PAD;
	const arc = `A ${ RADIUS } ${ RADIUS } 0 0 1`;
	return [
		`M ${ left + RADIUS },${ top }`,
		`H ${ tipX - NOTCH }`,
		`L ${ tipX },${ tipY }`,
		`L ${ tipX + NOTCH },${ top }`,
		`H ${ right - RADIUS }`,
		`${ arc } ${ right },${ top + RADIUS }`,
		`V ${ bottom - RADIUS }`,
		`${ arc } ${ right - RADIUS },${ bottom }`,
		`H ${ left + RADIUS }`,
		`${ arc } ${ left },${ bottom - RADIUS }`,
		`V ${ top + RADIUS }`,
		`${ arc } ${ left + RADIUS },${ top }`,
		'Z',
	].join( ' ' );
}

/**
 * @param {Object}                                props
 * @param {string[]}                              props.owners     The owners of the open grids, outermost first.
 * @param {number}                                props.depth      Which of them this is.
 * @param {Box}                                   props.anchor     The owner card as the canvas draws it, in world units.
 * @param {Array<{name: string, class: string}>}  props.sidecars   Its sidecars, in the row's order.
 * @param {Map<string, MetadataGraphNode>}        props.rows       The polled rows by name; a card with none yet draws no count and no "…".
 * @param {Map<string, RateEntry>}                props.rates      The sidecar poller's rate map, keyed by node name.
 * @param {string}                                props.surface    The canvas's id prefix, whose clips and bloom the cards draw through.
 * @param {boolean}                               props.showDetail The canvas draws detail, so its cards do too, and bloom.
 * @param {?string}                               props.shown      The sidecar the Inspector shows; its card wears the selection.
 * @param {?string}                               props.active     The card the canvas's keys act on, in whichever open grid holds it.
 * @param {?string}                               props.entered    The owner whose grid the keys opened; that grid shows its first card as it opens.
 * @param {(name: string) => void}                props.onPick     Shows the chosen sidecar.
 * @param {(depth: number, name: string) => void} props.onOpen     A card's "…" was pressed: open its grid at that depth, or close it.
 * @param {(depth: number, name: string) => void} props.onEnter    Enter on a card owning sidecars: open its grid at that depth, never close it.
 * @param {(box: Box) => void}                    props.onReveal   Pans the canvas just far enough to show a card.
 * @return {import('react').ReactElement} The popover's `<g>`.
 */
export default function SidecarsPopover( {
	owners,
	depth,
	anchor,
	sidecars,
	rows,
	rates,
	surface,
	showDetail,
	shown,
	active,
	entered,
	onPick,
	onOpen,
	onEnter,
	onReveal,
} ) {
	const at = layout( anchor, sidecars.length );
	const cards = sidecars.map( ( sidecar, i ) => {
		const row = rows.get( sidecar.name );
		const rate = rates.get( sidecar.name );
		const isShown = sidecar.name === shown;
		return {
			...cardAt( at, i ),
			sidecar,
			row,
			rate,
			isShown,
			isIdle: ! isShown && ! ( rate?.rate > 0 ),
			owns: row?.sidecars?.length > 0,
		};
	} );
	const nested = cards.find(
		( c ) => c.sidecar.name === owners[ depth + 1 ]
	);
	const activeCard = cards.find( ( c ) => c.sidecar.name === active );
	const frameRef = useRef( null );
	// What the canvas's keys read when they fire.
	const keysRef = useRef( null );
	keysRef.current = { cards, activeCard, depth, onPick, onEnter, onReveal };
	useEffect( () => {
		const svg = frameRef.current?.ownerSVGElement;
		/**
		 * A key on the canvas, which holds focus: this grid's while it holds
		 * the active card, and before the canvas's own handler hears it.
		 *
		 * @param {KeyboardEvent} e The key.
		 */
		const onKey = ( e ) => {
			const keys = keysRef.current;
			const from = keys.activeCard;
			const dir = ARROWS[ e.key ];
			if (
				! from ||
				( ! dir && 'Enter' !== e.key && ' ' !== e.key ) ||
				e.defaultPrevented ||
				e.altKey ||
				e.ctrlKey ||
				e.metaKey
			) {
				return;
			}
			e.preventDefault();
			if ( dir ) {
				const next = nearestInDirection( keys.cards, from, dir );
				if ( next ) {
					keys.onPick( next.sidecar.name );
					keys.onReveal( boxOf( next ) );
				}
				return;
			}
			keys.onPick( from.sidecar.name );
			if ( 'Enter' === e.key && from.owns ) {
				keys.onEnter( keys.depth + 1, from.sidecar.name );
			}
		};
		svg?.addEventListener( 'keydown', onKey );
		return () => svg?.removeEventListener( 'keydown', onKey );
	}, [] );
	// Opened from the keys, so the card they act on first is on screen.
	useEffect( () => {
		if ( entered === owners[ depth ] && cards[ 0 ] ) {
			onReveal( boxOf( cards[ 0 ] ) );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );
	return (
		<g
			role="dialog"
			aria-label={ sprintf(
				// translators: %s: the node that owns the listed nodes.
				__( 'Owned by %s', 'newspack-nodes' ),
				owners[ depth ]
			) }
			ref={ frameRef }
			className="topology-sidecars"
			// The popover owns a press here, not the canvas's pan or drag.
			onPointerDown={ ( ev ) => ev.stopPropagation() }
		>
			<path className="topology-sidecars__frame" d={ framePath( at ) } />
			<g
				className={ `topology-nodes${
					showDetail ? ' topology-nodes--bloom' : ''
				}` }
			>
				{ cards.map( ( c ) => (
					<g
						key={ c.sidecar.name }
						id={
							c === activeCard
								? cardDomId( surface, c.sidecar.name )
								: undefined
						}
						className="topology-sidecars__card"
						role="button"
						aria-label={ sprintf(
							// translators: 1: a node's name, 2: its class.
							__( '%1$s (%2$s)', 'newspack-nodes' ),
							c.sidecar.name,
							c.sidecar.class
						) }
						aria-current={ c.isShown || undefined }
						onClick={ () => onPick( c.sidecar.name ) }
					>
						<NodeCard
							surface={ surface }
							id={ c.sidecar.name }
							cls={ c.sidecar.class }
							x={ c.x }
							y={ c.y }
							w={ c.w }
							h={ c.h }
							showDetail={ showDetail }
							isSelected={ c.isShown }
							isIdle={ c.isIdle }
							isPaused={ 'PAUSED' === c.row?.polling }
							hasSidecars={ c.owns }
						/>
					</g>
				) ) }
			</g>
			{ showDetail && (
				<>
					<g className="topology-readouts">
						{ cards.map( ( c ) => (
							<NodeReadout
								key={ c.sidecar.name }
								surface={ surface }
								x={ c.x }
								y={ c.y }
								isIdle={ c.isIdle }
								sparkPath={ sparklinePath( c.rate?.history ) }
								rateText={ formatNodeRate( c.rate?.rate ) }
								count={ c.row?.count }
							/>
						) ) }
					</g>
					<g className="topology-sidecars__more">
						{ cards
							.filter( ( c ) => c.owns )
							.map( ( c ) => (
								<g
									key={ c.sidecar.name }
									transform={ `translate(${ c.x },${ c.y })` }
								>
									<SidecarsTrigger
										id={ c.sidecar.name }
										onOpen={ () =>
											onOpen( depth + 1, c.sidecar.name )
										}
									/>
								</g>
							) ) }
					</g>
				</>
			) }
			{ activeCard && <FocusRing box={ activeCard } /> }
			{ nested && (
				<SidecarsPopover
					key={ nested.sidecar.name }
					owners={ owners }
					depth={ depth + 1 }
					anchor={ nested }
					sidecars={ nested.row?.sidecars ?? [] }
					rows={ rows }
					rates={ rates }
					surface={ surface }
					showDetail={ showDetail }
					shown={ shown }
					active={ active }
					entered={ entered }
					onPick={ onPick }
					onOpen={ onOpen }
					onEnter={ onEnter }
					onReveal={ onReveal }
				/>
			) }
		</g>
	);
}
