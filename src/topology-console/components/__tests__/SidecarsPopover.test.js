/**
 * SidecarsPopover — the grid an owner's "…" opens, drawn on the canvas below
 * the owner's card in world units, a notch on its top edge pointing at the
 * card: each sidecar as the card the canvas draws, live off the poll's rows
 * and rates, through the canvas's own clips and bloom; a pick showing its
 * Inspector; a "…" on any card owning sidecars in turn, whose own grid hangs
 * inside this one, below that card.
 */

import { render, fireEvent } from '@testing-library/react';
import SidecarsPopover from '../SidecarsPopover';
import {
	NODE_H,
	NODE_SHADOW,
	NODE_W,
	NodeCardDefs,
	bloomVars,
} from '../NodeCard';

const SIDECARS = [
	{ name: 'crawl-4471:curl', class: 'Curl' },
	{ name: 'crawl-4471:seen', class: 'Table' },
];

/** The poll's sidecar rows: the Table has a row and a rate, the Curl none. */
const ROWS = [ { id: 'crawl-4471:seen', count: 9083, polling: 'PAUSED' } ];
const RATES = new Map( [
	[ 'crawl-4471:seen', { rate: 37.5, history: [ 12, 37.5 ] } ],
] );

/** A card's whole box at the default size, its drop shadow included. */
const CARD_W = NODE_W + NODE_SHADOW;
const CARD_H = NODE_H + NODE_SHADOW;

/** The owner card's box as the canvas draws it, in world units. */
const ANCHOR = { x: 410, y: 270, w: NODE_W, h: NODE_H };

/** The canvas surface whose defs the cards draw through. */
const SURFACE = 'topology-card-canvas-fixture';

/** `n1:seen` owning a Log, with rows for both. */
const OWNING = [
	{
		id: 'crawl-4471:seen',
		count: 9083,
		sidecars: [ { name: 'crawl-4471:seen:log', class: 'Log' } ],
	},
	{ id: 'crawl-4471:seen:log', count: 512 },
];

/**
 * The popover inside an `<svg>` carrying the canvas's defs, the way the
 * canvas draws it.
 *
 * @param {Object}   props                Overrides; `rows` as a list.
 * @param {Function} [props.onCanvasDown] The svg's own pointerdown.
 * @param {Object[]} [props.rows]         The polled rows.
 * @return {import('react').ReactElement} The canvas stand-in.
 */
function canvas( { onCanvasDown = () => {}, rows = ROWS, ...props } = {} ) {
	return (
		<svg style={ bloomVars( SURFACE ) } onPointerDown={ onCanvasDown }>
			<defs>
				<NodeCardDefs surface={ SURFACE } />
			</defs>
			<SidecarsPopover
				owners={ [ 'crawl-4471' ] }
				depth={ 0 }
				anchor={ ANCHOR }
				sidecars={ SIDECARS }
				rows={ new Map( rows.map( ( row ) => [ row.id, row ] ) ) }
				rates={ RATES }
				surface={ SURFACE }
				showDetail
				shown={ null }
				onPick={ () => {} }
				onOpen={ () => {} }
				{ ...props }
			/>
		</svg>
	);
}

/**
 * Render the popover as the canvas draws it.
 *
 * @param {Object} props Overrides, as `canvas()` takes them.
 * @return {Element[]} The outer grid's cards, in order.
 */
function open( props ) {
	render( canvas( props ) );
	return cardsOf( dialog() );
}

const dialog = () => document.body.querySelector( '[role="dialog"]' );

/**
 * A grid's own cards, not those of a grid nested in it.
 *
 * @param {Element} grid The popover.
 * @return {Element[]} Its pick controls, in order.
 */
const cardsOf = ( grid ) => [
	...grid.querySelectorAll(
		':scope > .topology-nodes > .topology-sidecars__card'
	),
];

/**
 * A grid's own readouts, in card order.
 *
 * @param {Element} grid The popover.
 * @return {Element[]} The readouts.
 */
const readoutsOf = ( grid ) => [
	...grid.querySelectorAll(
		':scope > .topology-readouts > .topology-node-readout'
	),
];

/**
 * Where a card's frame sits, in world units.
 *
 * @param {Element} card A pick control.
 * @return {{x: number, y: number}} Its top-left.
 */
const at = ( card ) => {
	const [ , x, y ] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(
		card.querySelector( '.topology-node' ).getAttribute( 'transform' )
	);
	return { x: Number( x ), y: Number( y ) };
};

describe( 'SidecarsPopover', () => {
	it( 'draws each sidecar as a canvas card, in the owner-named dialog', () => {
		const cards = open();
		expect( dialog().getAttribute( 'aria-label' ) ).toBe(
			'Owned by crawl-4471'
		);
		expect( dialog().hasAttribute( 'aria-modal' ) ).toBe( false );
		expect( cards ).toHaveLength( 2 );
		const [ , seen ] = cards;
		const [ , readout ] = readoutsOf( dialog() );
		expect( seen.querySelector( '.topology-node__type' ).textContent ).toBe(
			'Table'
		);
		expect( seen.querySelector( '.topology-node__id' ).textContent ).toBe(
			'crawl-4471:seen'
		);
		expect(
			readout.querySelector( '.topology-node__counter' ).textContent
		).toBe( '9,083' );
		expect(
			readout.querySelector( '.topology-node__rate' ).textContent
		).toBe( '37.5 /s' );
		expect(
			readout.querySelector( '.topology-node__spark' ).getAttribute( 'd' )
		).toMatch( /^M .* L / );
		expect( seen.querySelector( '.topology-node__paused' ) ).not.toBeNull();
		expect( seen.querySelector( '.topology-node.is-idle' ) ).toBeNull();
	} );

	it( 'draws a sidecar the poll has not reached yet idle, with no count', () => {
		const [ curl ] = open();
		const [ readout ] = readoutsOf( dialog() );
		expect( curl.querySelector( '.topology-node__type' ).textContent ).toBe(
			'Curl'
		);
		expect(
			readout.querySelector( '.topology-node__counter' ).textContent
		).toBe( '—' );
		expect( readout.querySelector( '.topology-node__spark' ) ).toBeNull();
		expect( curl.querySelector( '.topology-node.is-idle' ) ).not.toBeNull();
		expect( readout.classList.contains( 'is-idle' ) ).toBe( true );
	} );

	describe( 'on the canvas, below its owner', () => {
		it( "hangs centred under the owner's card, the notch's tip at its bottom edge", () => {
			const [ curl, seen ] = open();
			const tipX = ANCHOR.x + NODE_W / 2;
			const tipY = ANCHOR.y + CARD_H;
			const frame = dialog().querySelector( '.topology-sidecars__frame' );
			expect( frame.getAttribute( 'd' ) ).toContain(
				` L ${ tipX },${ tipY } L `
			);
			expect( at( seen ).y ).toBe( at( curl ).y );
			const gap = at( seen ).x - at( curl ).x - CARD_W;
			expect( gap ).toBeGreaterThan( 0 );
			expect( at( curl ).x + ( 2 * CARD_W + gap ) / 2 ).toBe( tipX );
			expect( at( curl ).y ).toBeGreaterThan( tipY );
		} );

		/**
		 * `count` readers of one owner.
		 *
		 * @param {number} count How many.
		 * @return {Array<{name: string, class: string}>} The sidecars.
		 */
		const readers = ( count ) =>
			Array.from( { length: count }, ( _, i ) => ( {
				name: `crawl-4471:reader-${ i }`,
				class: 'Remote_Consumer',
			} ) );

		it( 'lays four cards out two by two, the third under the first', () => {
			const cards = open( { sidecars: readers( 4 ) } ).map( at );
			expect( cards[ 1 ].y ).toBe( cards[ 0 ].y );
			expect( cards[ 2 ].x ).toBe( cards[ 0 ].x );
			expect( cards[ 3 ].x ).toBe( cards[ 1 ].x );
			expect( cards[ 2 ].y ).toBeGreaterThan( cards[ 0 ].y + CARD_H );
			expect( cards[ 3 ].y ).toBe( cards[ 2 ].y );
		} );

		it( 'lays three cards out two and one, centred under the owner', () => {
			const cards = open( { sidecars: readers( 3 ) } ).map( at );
			expect( cards[ 1 ].y ).toBe( cards[ 0 ].y );
			expect( cards[ 2 ].x ).toBe( cards[ 0 ].x );
			expect( cards[ 2 ].y ).toBeGreaterThan( cards[ 0 ].y );
			const tipX = ANCHOR.x + NODE_W / 2;
			expect( ( cards[ 0 ].x + cards[ 1 ].x + CARD_W ) / 2 ).toBe( tipX );
			expect(
				dialog()
					.querySelector( '.topology-sidecars__frame' )
					.getAttribute( 'd' )
			).toContain( ` L ${ tipX },${ ANCHOR.y + CARD_H } L ` );
		} );

		it( 'runs five cards three across', () => {
			const five = open( { sidecars: readers( 5 ) } ).map( at );
			expect( five[ 2 ].y ).toBe( five[ 0 ].y );
			expect( five[ 3 ].x ).toBe( five[ 0 ].x );
			expect( five[ 3 ].y ).toBeGreaterThan( five[ 0 ].y );
		} );

		it( 'runs 256 cards sixteen across', () => {
			const cards = open( { sidecars: readers( 256 ) } ).map( at );
			expect( cards[ 15 ].y ).toBe( cards[ 0 ].y );
			expect( cards[ 16 ].x ).toBe( cards[ 0 ].x );
			expect( cards[ 16 ].y ).toBeGreaterThan( cards[ 0 ].y );
			expect( cards[ 255 ].x ).toBe( cards[ 15 ].x );
		} );

		it( 'lays each readout over its own card', () => {
			const cards = open();
			const readouts = readoutsOf( dialog() );
			cards.forEach( ( card, i ) => {
				expect( readouts[ i ].getAttribute( 'transform' ) ).toBe(
					card
						.querySelector( '.topology-node' )
						.getAttribute( 'transform' )
				);
			} );
		} );

		it( 'starts no canvas pan or drag on a press', () => {
			const onCanvasDown = jest.fn();
			const cards = open( { onCanvasDown } );
			fireEvent.pointerDown( cards[ 1 ], { button: 0 } );
			fireEvent.pointerDown(
				dialog().querySelector( '.topology-sidecars__frame' ),
				{ button: 0 }
			);
			expect( onCanvasDown ).not.toHaveBeenCalled();
		} );
	} );

	describe( "the canvas's level of detail", () => {
		it( 'draws bare cards, with no readouts and no "…", below it', () => {
			const cards = open( { rows: OWNING, showDetail: false } );
			for ( const card of cards ) {
				const node = card.querySelector( '.topology-node' );
				expect( node.classList.contains( 'is-static' ) ).toBe( true );
				expect(
					node.querySelector( '.topology-node__type' )
				).toBeNull();
			}
			expect( dialog().querySelector( '.topology-readouts' ) ).toBeNull();
			expect(
				dialog().querySelector( '.topology-node__sidecars' )
			).toBeNull();
		} );

		it( "hangs from the owner card's centre-bottom and draws its cards at its size", () => {
			const big = { x: 410, y: 270, w: 640, h: 274 };
			const cards = open( { anchor: big } );
			const tipX = big.x + big.w / 2;
			const tipY = big.y + big.h + NODE_SHADOW;
			expect(
				dialog()
					.querySelector( '.topology-sidecars__frame' )
					.getAttribute( 'd' )
			).toContain( ` L ${ tipX },${ tipY } L ` );
			const bg = cards[ 0 ].querySelector( '.topology-node__bg' );
			expect( bg.getAttribute( 'width' ) ).toBe( '640' );
			expect( bg.getAttribute( 'height' ) ).toBe( '274' );
			const [ first, second ] = cards.map( at );
			expect( second.x - first.x ).toBeGreaterThan( big.w + NODE_SHADOW );
			expect( first.y ).toBeGreaterThan( tipY );
			expect( ( first.x + second.x + big.w + NODE_SHADOW ) / 2 ).toBe(
				tipX
			);
		} );
	} );

	describe( "the canvas's surface", () => {
		it( 'blooms its cards only while the canvas draws detail', () => {
			open( { showDetail: false } );
			const nodes = dialog().querySelector( ':scope > .topology-nodes' );
			expect( nodes.classList.contains( 'topology-nodes--bloom' ) ).toBe(
				false
			);
		} );

		it( 'blooms every card in one group, its readouts outside it', () => {
			const cards = open();
			const bloom = dialog().querySelectorAll( '.topology-nodes--bloom' );
			expect( bloom ).toHaveLength( 1 );
			for ( const card of cards ) {
				expect( bloom[ 0 ].contains( card ) ).toBe( true );
			}
			for ( const readout of readoutsOf( dialog() ) ) {
				expect( bloom[ 0 ].contains( readout ) ).toBe( false );
			}
		} );

		it( "clips through the canvas's defs and defines none of its own", () => {
			open();
			const clipped = [ ...dialog().querySelectorAll( '[clip-path]' ) ];
			expect( clipped.length ).toBeGreaterThan( 0 );
			for ( const el of clipped ) {
				expect( el.getAttribute( 'clip-path' ) ).toMatch(
					new RegExp( `^url\\(#${ SURFACE }-(id-)?clip\\)$` )
				);
			}
			expect( dialog().querySelector( '[id]' ) ).toBeNull();
			expect( dialog().querySelector( 'defs, foreignObject, svg' ) ).toBe(
				null
			);
		} );
	} );

	it( 'draws no port or drag on a card in the grid', () => {
		const cards = open();
		expect( cards[ 0 ].querySelector( '.topology-port' ) ).toBeNull();
		expect( cards[ 1 ].querySelector( '.topology-port' ) ).toBeNull();
	} );

	describe( "a card's own sidecars", () => {
		const more = () =>
			dialog().querySelectorAll(
				':scope > .topology-sidecars__more .topology-node__sidecars'
			);

		it( 'draw a "…" where the canvas card draws one, outside the pick control', () => {
			const cards = open( { rows: OWNING } );
			expect( more() ).toHaveLength( 1 );
			const [ dots ] = more();
			expect( dots.closest( '.topology-sidecars__card' ) ).toBeNull();
			expect( cards[ 1 ].contains( dots ) ).toBe( false );
			expect( dots.contains( cards[ 1 ] ) ).toBe( false );
			expect( dots.getAttribute( 'role' ) ).toBe( 'button' );
			expect( dots.getAttribute( 'aria-haspopup' ) ).toBe( 'dialog' );
			expect( dots.getAttribute( 'aria-label' ) ).toBe(
				'Owned nodes of crawl-4471:seen'
			);
			const card = at( cards[ 1 ] );
			expect( dots.parentNode.getAttribute( 'transform' ) ).toBe(
				`translate(${ card.x },${ card.y })`
			);
			const clipOf = ( c ) =>
				c
					.querySelector( '.topology-node__id' )
					.closest( '[clip-path]' )
					.getAttribute( 'clip-path' );
			expect( clipOf( cards[ 1 ] ) ).toBe( `url(#${ SURFACE }-id-clip)` );
			expect( clipOf( cards[ 0 ] ) ).toBe( `url(#${ SURFACE }-clip)` );
		} );

		it( 'open one level deeper from the "…" by click or key, and pick nothing', () => {
			const onOpen = jest.fn();
			const onPick = jest.fn();
			open( {
				rows: OWNING,
				onOpen,
				onPick,
				depth: 2,
				owners: [ 'crawl-0001', 'crawl-0001:spool', 'crawl-4471' ],
			} );
			const [ dots ] = more();
			fireEvent.click( dots );
			fireEvent.keyDown( dots, { key: 'Enter' } );
			fireEvent.keyDown( dots, { key: ' ' } );
			fireEvent.keyDown( dots, { key: 'a' } );
			expect( onOpen ).toHaveBeenCalledTimes( 3 );
			expect( onOpen ).toHaveBeenCalledWith( 3, 'crawl-4471:seen' );
			expect( onPick ).not.toHaveBeenCalled();
		} );

		it( 'hang their grid inside this one, below the card that opened it', () => {
			const cards = open( {
				rows: OWNING,
				owners: [ 'crawl-4471', 'crawl-4471:seen' ],
			} );
			const nested = dialog().querySelector( '[role="dialog"]' );
			expect( nested.getAttribute( 'aria-label' ) ).toBe(
				'Owned by crawl-4471:seen'
			);
			const seen = at( cards[ 1 ] );
			expect(
				nested
					.querySelector( '.topology-sidecars__frame' )
					.getAttribute( 'd' )
			).toContain(
				` L ${ seen.x + NODE_W / 2 },${ seen.y + CARD_H } L `
			);
			const [ log ] = cardsOf( nested );
			expect( log.getAttribute( 'aria-label' ) ).toBe(
				'crawl-4471:seen:log (Log)'
			);
			expect(
				readoutsOf( nested )[ 0 ].querySelector(
					'.topology-node__counter'
				).textContent
			).toBe( '512' );
		} );

		it( "draw and focus a new grid when another card's replaces the open one", () => {
			const both = [
				...OWNING,
				{
					id: 'crawl-4471:curl',
					count: 77,
					sidecars: [
						{ name: 'crawl-4471:curl:out', class: 'HTTP_Out' },
					],
				},
			];
			const nested = ( owner ) =>
				canvas( {
					rows: both,
					owners: [ 'crawl-4471', owner ],
				} );
			const { rerender } = render( nested( 'crawl-4471:seen' ) );
			rerender( nested( 'crawl-4471:curl' ) );
			const inner = dialog().querySelector( '[role="dialog"]' );
			expect( inner.getAttribute( 'aria-label' ) ).toBe(
				'Owned by crawl-4471:curl'
			);
			expect( document.activeElement ).toBe( cardsOf( inner )[ 0 ] );
		} );

		it( 'hang no grid for an owner this one no longer lists', () => {
			open( {
				rows: OWNING,
				owners: [ 'crawl-4471', 'crawl-4471:gone' ],
			} );
			expect( dialog().querySelector( '[role="dialog"]' ) ).toBeNull();
		} );
	} );

	it( 'wears the scope the console skins its cards under, and no modal class', () => {
		open();
		expect( dialog().classList.contains( 'topology-sidecars' ) ).toBe(
			true
		);
		expect( document.body.querySelector( '[class*="modal"]' ) ).toBeNull();
		expect( dialog().hasAttribute( 'data-depth' ) ).toBe( false );
	} );

	describe( 'the pick control', () => {
		it( 'is a focusable button named by node and class, first card focused on open', () => {
			const cards = open();
			expect( cards.map( ( c ) => c.getAttribute( 'role' ) ) ).toEqual( [
				'button',
				'button',
			] );
			expect( cards[ 1 ].getAttribute( 'tabindex' ) ).toBe( '0' );
			expect(
				cards.map( ( c ) => c.getAttribute( 'aria-label' ) )
			).toEqual( [
				'crawl-4471:curl (Curl)',
				'crawl-4471:seen (Table)',
			] );
			expect( document.activeElement ).toBe( cards[ 0 ] );
		} );

		it( 'picks on a click, Enter or Space, and keeps the focus a press gave it', () => {
			const onPick = jest.fn();
			const cards = open( { onPick } );
			cards[ 1 ].focus();
			fireEvent.click( cards[ 1 ] );
			fireEvent.keyDown( cards[ 1 ], { key: 'Enter' } );
			fireEvent.keyDown( cards[ 1 ], { key: ' ' } );
			fireEvent.keyDown( cards[ 1 ], { key: 'Tab' } );
			expect( onPick ).toHaveBeenCalledTimes( 3 );
			expect( onPick ).toHaveBeenCalledWith( 'crawl-4471:seen' );
			expect( document.activeElement ).toBe( cards[ 1 ] );
		} );

		it( 'wears the canvas selection on the card the Inspector shows', () => {
			const cards = open( { shown: 'crawl-4471:curl' } );
			const curl = cards[ 0 ].querySelector( '.topology-node' );
			expect( curl.classList.contains( 'is-selected' ) ).toBe( true );
			expect( curl.classList.contains( 'is-idle' ) ).toBe( false );
			expect(
				cards[ 1 ]
					.querySelector( '.topology-node' )
					.classList.contains( 'is-selected' )
			).toBe( false );
			expect( cards[ 0 ].getAttribute( 'aria-current' ) ).toBe( 'true' );
			expect( cards[ 1 ].hasAttribute( 'aria-current' ) ).toBe( false );
		} );
	} );

	it( 'closes on nothing itself: Esc and a click outside belong to its host', () => {
		const onPick = jest.fn();
		open( { onPick } );
		fireEvent.keyDown( document, { key: 'Escape' } );
		fireEvent.mouseDown( document.body );
		fireEvent.click( document.body );
		expect( dialog() ).not.toBeNull();
		expect( onPick ).not.toHaveBeenCalled();
	} );
} );
