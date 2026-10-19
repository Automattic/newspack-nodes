/**
 * The node card, the one drawing of a node wherever the console shows one:
 * on the schematic canvas, in an owner's sidecar grid and as the palette's
 * drag ghost. The frame and the live readouts are separate components so the
 * canvas can layer them. Each surface defines the clips and blooms its cards
 * draw through under its own id prefix, so no id repeats on a page.
 */

import { memo, useId } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { formatGroupedCount } from '@newspack-nodes/shared/utils/formatters';
import { RATE_HISTORY_MAX } from '../hooks/useGraphRates';

/**
 * Card width in world (viewBox) units, which the canvas lays out by and every
 * card outside it is drawn at.
 */
export const NODE_W = 196;

/**
 * Card height in world units.
 */
export const NODE_H = 84;

/**
 * Offset of the card's drop shadow, which spills past the card's own box.
 */
export const NODE_SHADOW = 3;

/**
 * Radius of the IN and OUT port dots, in world units.
 */
export const PORT_R = 4.5;

/** Left edge of an owner's "…", within its card. */
const SIDECARS_X = NODE_W - 30;

/**
 * Bloom blur radius per skin, in SCREEN px. `bloomStdDev` divides by the
 * surface's scale, so the glow keeps one size on screen however far a canvas
 * is zoomed.
 */
const BLOOM_STDDEV_PX = { crt: 5, neo: 4 };

/** Room past a lone card's edge for its glow to spread into, in world units. */
const BLOOM_PAD = 16;

/** The filter region of a card drawn on its own, at one px per world unit. */
const CARD_REGION = {
	x: -BLOOM_PAD,
	y: -BLOOM_PAD,
	w: NODE_W + 2 * BLOOM_PAD,
	h: NODE_H + 2 * BLOOM_PAD,
};

/**
 * The filter's `stdDeviation` in world units, for a glow of constant screen
 * size.
 *
 * @param {number} px    Blur radius in screen px.
 * @param {number} scale Current px per world unit; Infinity until the canvas is measured.
 * @return {string|number} The world-unit deviation, or 0 while the scale is unusable — no blur beats a blur of unknown size.
 */
function bloomStdDev( px, scale ) {
	return Number.isFinite( scale ) && scale > 0
		? ( px / scale ).toFixed( 2 )
		: 0;
}

/**
 * The id prefix of one surface that draws cards — a canvas, a grid, a drag
 * ghost — so two surfaces on one page define no id twice.
 *
 * @return {string} The prefix every id `NodeCardDefs` defines starts with.
 */
export function useCardSurface() {
	return `topology-card-${ useId().replace( /[^\w-]/g, '' ) }`;
}

/**
 * The custom properties a surface's root carries, naming the bloom filters
 * the skins that glow apply through `var( --topology-bloom-<skin> )`.
 *
 * @param {string} surface The surface's id prefix.
 * @return {Object} The style properties.
 */
export function bloomVars( surface ) {
	return {
		'--topology-bloom-crt': `url(#${ surface }-bloom-crt)`,
		'--topology-bloom-neo': `url(#${ surface }-bloom-neo)`,
	};
}

/**
 * Everything a surface's cards draw through, for its `<defs>`: the card's
 * rounded clip, the id's clip short of a "…", and one bloom filter per
 * glowing skin, its region and blur in the surface's world units.
 *
 * @param {Object}                                props
 * @param {string}                                props.surface  The surface's id prefix.
 * @param {{x:number,y:number,w:number,h:number}} [props.region] The bloom region; a lone card's box by default.
 * @param {number}                                [props.scale]  Screen px per world unit; 1 by default.
 * @return {import('react').ReactElement} The clip paths and filters.
 */
export function NodeCardDefs( { surface, region = CARD_REGION, scale = 1 } ) {
	return (
		<>
			{ /* rx/ry round the clip so title-band corners follow. */ }
			<clipPath id={ `${ surface }-clip` } clipPathUnits="userSpaceOnUse">
				<rect
					x={ 0 }
					y={ 0 }
					width={ NODE_W }
					height={ NODE_H }
					rx={ 7 }
					ry={ 7 }
				/>
			</clipPath>
			<clipPath
				id={ `${ surface }-id-clip` }
				clipPathUnits="userSpaceOnUse"
			>
				<rect
					x={ 0 }
					y={ 0 }
					width={ SIDECARS_X - 4 }
					height={ NODE_H }
				/>
			</clipPath>
			{ Object.entries( BLOOM_STDDEV_PX ).map( ( [ skin, px ] ) => (
				<filter
					key={ skin }
					id={ `${ surface }-bloom-${ skin }` }
					filterUnits="userSpaceOnUse"
					x={ region.x }
					y={ region.y }
					width={ region.w }
					height={ region.h }
					colorInterpolationFilters="sRGB"
				>
					<feGaussianBlur
						in="SourceGraphic"
						stdDeviation={ bloomStdDev( px, scale ) }
						result="bloom"
					/>
					<feBlend mode="screen" in="SourceGraphic" in2="bloom" />
				</filter>
			) ) }
		</>
	);
}

/**
 * Left inset of the card's sparkline, in world units from the card's edge.
 */
const SPARK_X = 11;

/**
 * Top of the sparkline band, in world units from the card's top edge.
 */
const SPARK_Y = 48;

/**
 * Sparkline width: the card less an equal inset each side.
 */
const SPARK_W = NODE_W - 2 * SPARK_X;

/**
 * Sparkline height, and so the plot's full-scale deflection.
 */
const SPARK_H = 16;

/**
 * The card's rate sparkline, scaled to the tallest sample it holds and
 * right-aligned across the full `RATE_HISTORY_MAX` window: the newest sample
 * sits at the right edge and a short history walks in from there. Stretching a
 * short history across the card would make a node with two samples read like a
 * node with a full minute of them.
 *
 * @param {?number[]} history Trailing msg/s samples, oldest first.
 * @return {?string} An SVG path `d`, or null under two samples — one point makes no line.
 */
export function sparklinePath( history ) {
	if ( ! history || history.length < 2 ) {
		return null;
	}
	const max = Math.max( ...history, 1e-9 );
	const step = SPARK_W / ( RATE_HISTORY_MAX - 1 );
	const startIdx = RATE_HISTORY_MAX - history.length;
	return history
		.map( ( v, i ) => {
			// Clamp negatives (counter reset) so they don't plot below the box.
			const safeV = v > 0 ? v : 0;
			const x = SPARK_X + ( startIdx + i ) * step;
			const y = SPARK_Y + SPARK_H - ( safeV / max ) * SPARK_H;
			return `${ i === 0 ? 'M' : 'L' } ${ x.toFixed( 2 ) },${ y.toFixed(
				2
			) }`;
		} )
		.join( ' ' );
}

/**
 * Messages per second below which a card shows no rate label rather than
 * `0.00 /s`.
 */
const RATE_LABEL_FLOOR = 0.05;

/**
 * The per-card rate label, at the precision the card has room for: whole
 * messages per second in the hundreds, one decimal in the tens, two below.
 *
 * @param {number} [rate] Messages per second for one node.
 * @return {?string} The label, or null below `RATE_LABEL_FLOOR`.
 */
export function formatNodeRate( rate ) {
	if ( ! rate || rate < RATE_LABEL_FLOOR ) {
		return null;
	}
	if ( rate >= 100 ) {
		return `${ Math.round( rate ) } /s`;
	}
	if ( rate >= 10 ) {
		return `${ rate.toFixed( 1 ) } /s`;
	}
	return `${ rate.toFixed( 2 ) } /s`;
}

/**
 * A keydown handler pressing an SVG control on Enter or Space, as a button
 * presses, since an SVG element has no button semantics of its own.
 *
 * @param {(ev: import('react').KeyboardEvent<SVGGElement>) => void} press What the press does, given the key.
 * @return {(ev: import('react').KeyboardEvent<SVGGElement>) => void} The handler.
 */
export function pressOnKey( press ) {
	return ( ev ) => {
		if ( 'Enter' === ev.key || ' ' === ev.key ) {
			ev.preventDefault();
			press( ev );
		}
	};
}

/**
 * The DOM id of the card the keys act on, unique to the surface drawing it.
 * The name is URI-encoded, because a node's name may hold whitespace, which
 * no id may.
 *
 * @param {string} surface The id prefix of the surface's defs.
 * @param {string} name    The node the card draws.
 * @return {string} The id.
 */
export function cardDomId( surface, name ) {
	return `${ surface }-card-${ encodeURIComponent( name ) }`;
}

/**
 * A card-sized ring around the card the keys act on, drawn outside every
 * layer that dims a card and shown only while the canvas has keyboard focus.
 *
 * @param {Object} props
 * @param {Object} props.box The card as drawn: `{ x, y, w, h }` in world units.
 * @return {import('react').ReactElement} The ring's `<g>`.
 */
export function FocusRing( { box } ) {
	return (
		<g className="topology-focus">
			<rect
				className="topology-node-focus"
				x={ box.x }
				y={ box.y }
				width={ box.w }
				height={ box.h }
			/>
		</g>
	);
}

/**
 * The "…" on an owner's card, a button opening the sidecars the canvas never
 * draws. It sits at the same spot of every card that draws one, the canvas's
 * and the grid's, in the card's own coordinates. It is not a Tab stop: Enter on
 * its card opens the same grid.
 *
 * @param {Object}                                                    props
 * @param {string}                                                    props.id       The owner.
 * @param {(ev: import('react').SyntheticEvent<SVGGElement>) => void} props.onOpen   A click, or Enter or Space.
 * @param {(ev: import('react').SyntheticEvent<SVGGElement>) => void} [props.onHold] A press on it, kept from what it sits on.
 * @return {import('react').ReactElement} The "…"'s `<g>`.
 */
export function SidecarsTrigger( { id, onOpen, onHold } ) {
	return (
		<g
			className="topology-node__sidecars"
			data-owner={ id }
			role="button"
			tabIndex={ -1 }
			aria-haspopup="dialog"
			aria-label={ sprintf(
				// translators: %s: the node that owns them.
				__( 'Owned nodes of %s', 'newspack-nodes' ),
				id
			) }
			transform={ `translate(${ SIDECARS_X },31)` }
			onClick={ onOpen }
			onKeyDown={ pressOnKey( onOpen ) }
			onPointerDown={ onHold }
			onMouseDown={ onHold }
		>
			<rect width={ 22 } height={ 16 } rx={ 3 } />
			<text x={ 11 } y={ 12 } textAnchor="middle">
				…
			</text>
		</g>
	);
}

export const NodeCard = memo(
	/**
	 * One node card's frame: everything that holds still from poll to poll. It is
	 * memoized on its structural props alone, so a poll that moves only counters
	 * re-renders no card, and the bloom-filtered layer it sits in is left alone.
	 * Every handler comes through `events`, one object for the canvas's lifetime;
	 * a card drawn without it answers no gesture. Every flag defaults off, and
	 * the geometry to one detailed card at the origin. A card drawn with
	 * `events` takes no focus: the canvas holds it and names the active card.
	 *
	 * @param {Object}  props
	 * @param {string}  props.surface        The id prefix of the surface's defs.
	 * @param {string}  props.id             Node id.
	 * @param {string}  props.cls            Node class, shown in the title band.
	 * @param {number}  [props.x]            Card left, in world units.
	 * @param {number}  [props.y]            Card top, in world units.
	 * @param {number}  [props.w]            Rendered width, floored for a tiny scale.
	 * @param {number}  [props.h]            Rendered height, floored likewise.
	 * @param {boolean} [props.showDetail]   Draw labels and ports, not a bare rect.
	 * @param {boolean} [props.isSelected]   The selected node.
	 * @param {boolean} [props.isActive]     The card the canvas's keys act on, carrying the id its `aria-activedescendant` names.
	 * @param {boolean} [props.isHovered]    The hovered node.
	 * @param {boolean} [props.isFaded]      Faded behind a hover or a focused hull.
	 * @param {boolean} [props.isDragging]   Being dragged.
	 * @param {boolean} [props.isIdle]       Live, unselected, and its counter held still since the last poll.
	 * @param {boolean} [props.isDrift]      Runtime drift: off the .tsl, or console-made.
	 * @param {boolean} [props.isBorrowed]   Borrowed via `include`, so locked.
	 * @param {boolean} [props.isPaused]     A Consumer holding its cursor.
	 * @param {boolean} [props.hasIn]        Draws an IN port: it accepts fill.
	 * @param {boolean} [props.isSnapTarget] The IN port a dragged wire would land on.
	 * @param {boolean} [props.hasOut]       Draws an OUT port: it carries a target.
	 * @param {boolean} [props.isEdit]       Edit mode, which paints the OUT port.
	 * @param {boolean} [props.isWireSource] A wire drag may start at the OUT port.
	 * @param {boolean} [props.hasSidecars]  Its row lists sidecars, so its id clips short of a "…", drawn here with `events`.
	 * @param {Object}  [props.events]       The canvas's stable card handlers.
	 * @return {import('react').ReactElement} The card's `<g>`.
	 */
	function NodeCard( {
		surface,
		id,
		cls,
		x = 0,
		y = 0,
		w = NODE_W,
		h = NODE_H,
		showDetail = true,
		isSelected = false,
		isActive = false,
		isHovered = false,
		isFaded = false,
		isDragging = false,
		isIdle = false,
		isDrift = false,
		isBorrowed = false,
		isPaused = false,
		hasIn = false,
		isSnapTarget = false,
		hasOut = false,
		isEdit = false,
		isWireSource = false,
		hasSidecars = false,
		events,
	} ) {
		const gestures = events && {
			onClick: ( ev ) => events.select( ev, id ),
			onPointerDown: ( ev ) => events.down( ev, id ),
			onMouseDown: ( ev ) => events.down( ev, id ),
			onPointerMove: events.move,
			onPointerUp: events.up,
			onPointerCancel: events.up,
			onMouseEnter: () => events.hover( id ),
			onMouseLeave: () => events.hover( null ),
		};
		return (
			<g
				className={ `topology-node${
					isSelected ? ' is-selected' : ''
				}${ isHovered ? ' is-hovered' : '' }${
					isFaded ? ' is-faded' : ''
				}${ isDragging ? ' is-dragging' : '' }${
					showDetail ? '' : ' is-static'
				}${ isIdle ? ' is-idle' : '' }${ isDrift ? ' is-drift' : '' }${
					isBorrowed ? ' is-borrowed' : ''
				}` }
				transform={ `translate(${ x },${ y })` }
				data-node={ id }
				id={ isActive ? cardDomId( surface, id ) : undefined }
				{ ...gestures }
				{ ...( events && {
					role: 'group',
					'aria-label': sprintf(
						// translators: 1: a node's name, 2: its class.
						__( '%1$s (%2$s)', 'newspack-nodes' ),
						id,
						cls
					),
					'aria-current': isSelected || undefined,
				} ) }
			>
				<rect
					className="topology-node__shadow"
					x={ NODE_SHADOW }
					y={ NODE_SHADOW }
					width={ NODE_W }
					height={ NODE_H }
				/>
				<rect className="topology-node__bg" width={ w } height={ h } />
				{ /* Labels and ports only when zoomed in. */ }
				{ showDetail && (
					<>
						{ /* Labels clipped to the card; ports sit outside. */ }
						<g clipPath={ `url(#${ surface }-clip)` }>
							{ /* Title band behind type/id; per-skin fill. */ }
							<rect
								className="topology-node__header"
								width={ NODE_W }
								height={ 22 }
							/>
							<line
								className="topology-node__divider"
								x1={ 0 }
								y1={ 22 }
								x2={ NODE_W }
								y2={ 22 }
							/>
							<text
								className="topology-node__type"
								x={ 11 }
								y={ 15 }
							>
								{ cls }
							</text>
							<circle
								className="topology-node__led"
								cx={ NODE_W - 12 }
								cy={ 13 }
								r={ 3.5 }
							/>
							{ /* ⏸ badge when a Consumer holds the cursor. */ }
							{ isPaused && (
								<text
									className="topology-node__paused"
									x={ NODE_W - 24 }
									y={ 17 }
									textAnchor="end"
								>
									⏸
								</text>
							) }
							{ isBorrowed && (
								<text
									className="topology-node__lock"
									x={ NODE_W - 32 }
									y={ 15 }
								>
									🔒
								</text>
							) }
							<g
								clipPath={
									hasSidecars
										? `url(#${ surface }-id-clip)`
										: undefined
								}
							>
								<text
									className="topology-node__id"
									x={ 11 }
									y={ 44 }
								>
									{ id }
								</text>
							</g>
						</g>
						{ hasIn && (
							<circle
								className={ `topology-port topology-port--in${
									isSnapTarget ? ' is-snap-target' : ''
								}` }
								cx={ 0 }
								cy={ NODE_H / 2 }
								r={ PORT_R }
							/>
						) }
						{ hasSidecars && events && (
							<SidecarsTrigger
								id={ id }
								onOpen={ ( ev ) => events.sidecars( ev, id ) }
								onHold={ events.hold }
							/>
						) }
						{ hasOut && (
							<circle
								className={ `topology-port topology-port--out${
									isEdit ? ' is-edit' : ''
								}${ isWireSource ? ' is-wire-source' : '' }` }
								cx={ NODE_W }
								cy={ NODE_H / 2 }
								r={ PORT_R }
								onPointerDown={ ( ev ) =>
									isWireSource && events.port( ev, id )
								}
								onMouseDown={ ( ev ) =>
									isWireSource && events.port( ev, id )
								}
							/>
						) }
					</>
				) }
			</g>
		);
	}
);

export const NodeReadout = memo(
	/**
	 * One card's live readouts — sparkline, rate and counter — drawn over the card
	 * in a layer of their own, outside the bloom filter, so a poll that moves a
	 * counter re-renders this alone and repaints none of the filtered layer.
	 *
	 * @param {Object}  props
	 * @param {string}  props.surface      The id prefix of the surface's defs.
	 * @param {number}  [props.x]          Card left, in world units.
	 * @param {number}  [props.y]          Card top, in world units.
	 * @param {boolean} [props.isFaded]    Faded with its card.
	 * @param {boolean} [props.isDragging] Being dragged with its card.
	 * @param {boolean} [props.isIdle]     Dimmed with its card.
	 * @param {boolean} [props.rated]      Live mode, so a rate and sparkline exist.
	 * @param {?string} props.sparkPath    Sparkline `d`, or null under two samples.
	 * @param {?string} props.rateText     Rate label, or null below the label floor.
	 * @param {number}  [props.count]      Cumulative message count.
	 * @return {import('react').ReactElement} The readouts' `<g>`.
	 */
	function NodeReadout( {
		surface,
		x = 0,
		y = 0,
		isFaded = false,
		isDragging = false,
		isIdle = false,
		rated = true,
		sparkPath,
		rateText,
		count,
	} ) {
		return (
			<g
				className={ `topology-node-readout${
					isFaded ? ' is-faded' : ''
				}${ isDragging ? ' is-dragging' : '' }${
					isIdle ? ' is-idle' : ''
				}` }
				transform={ `translate(${ x },${ y })` }
			>
				<g clipPath={ `url(#${ surface }-clip)` }>
					{ sparkPath && (
						<path
							className="topology-node__spark"
							d={ sparkPath }
						/>
					) }
					{ /* Rate, bottom-left; quiet nodes show none. */ }
					{ rated && (
						<text className="topology-node__rate" x={ 11 } y={ 76 }>
							{ rateText }
						</text>
					) }
					<text
						className="topology-node__counter"
						x={ NODE_W - 11 }
						y={ 76 }
						textAnchor="end"
					>
						{ formatGroupedCount( count ) }
					</text>
				</g>
			</g>
		);
	}
);
