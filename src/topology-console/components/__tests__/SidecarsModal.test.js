/**
 * SidecarsModal — the grid an owner's "…" opens: each sidecar drawn as the
 * card the canvas draws, live off the poll's rows and rates, a pick showing
 * its Inspector.
 */

import { render, fireEvent } from '@testing-library/react';
import SidecarsModal from '../SidecarsModal';
import SchematicCanvas from '../SchematicCanvas';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';

const SIDECARS = [
	{ name: 'crawl-4471:curl', class: 'Curl' },
	{ name: 'crawl-4471:seen', class: 'Table' },
];

/** The poll's sidecar rows: the Table has a row and a rate, the Curl none. */
const ROWS = [ { id: 'crawl-4471:seen', count: 9083, polling: 'PAUSED' } ];
const RATES = new Map( [
	[ 'crawl-4471:seen', { rate: 37.5, history: [ 12, 37.5 ] } ],
] );

/**
 * Render the grid over the fixture.
 *
 * @param {Object} props Overrides.
 * @return {HTMLElement[]} The cards, in order.
 */
function open( props = {} ) {
	render(
		<SidecarsModal
			owner="crawl-4471"
			sidecars={ SIDECARS }
			rows={ ROWS }
			rates={ RATES }
			onPick={ () => {} }
			onDismiss={ () => {} }
			{ ...props }
		/>
	);
	return [ ...document.body.querySelectorAll( '.topology-sidecars__card' ) ];
}

describe( 'SidecarsModal', () => {
	it( 'draws each sidecar as a canvas card, in the owner-named dialog', () => {
		const cards = open();
		expect(
			document.body.querySelector( '.topology-modal__title' ).textContent
		).toBe( 'Owned by crawl-4471' );
		expect( cards ).toHaveLength( 2 );
		const seen = cards[ 1 ];
		expect( seen.querySelector( '.topology-node__type' ).textContent ).toBe(
			'Table'
		);
		expect( seen.querySelector( '.topology-node__id' ).textContent ).toBe(
			'crawl-4471:seen'
		);
		expect(
			seen.querySelector( '.topology-node__counter' ).textContent
		).toBe( '9,083' );
		expect( seen.querySelector( '.topology-node__rate' ).textContent ).toBe(
			'37.5 /s'
		);
		expect(
			seen.querySelector( '.topology-node__spark' ).getAttribute( 'd' )
		).toMatch( /^M .* L / );
		expect( seen.querySelector( '.topology-node__paused' ) ).not.toBeNull();
		expect( seen.querySelector( '.topology-node.is-idle' ) ).toBeNull();
	} );

	it( 'draws a sidecar the poll has not reached yet idle, with no count', () => {
		const [ curl ] = open();
		expect( curl.querySelector( '.topology-node__type' ).textContent ).toBe(
			'Curl'
		);
		expect(
			curl.querySelector( '.topology-node__counter' ).textContent
		).toBe( '—' );
		expect( curl.querySelector( '.topology-node__spark' ) ).toBeNull();
		expect( curl.querySelector( '.topology-node.is-idle' ) ).not.toBeNull();
	} );

	it( 'draws no port, drag or nested "…" on a card in the grid', () => {
		const cards = open( {
			sidecars: [ { name: 'crawl-4471:seen', class: 'Table' } ],
			rows: [
				{
					id: 'crawl-4471:seen',
					count: 9083,
					sidecars: [ { name: 'crawl-4471:seen:log', class: 'Log' } ],
				},
			],
		} );
		expect( cards[ 0 ].querySelector( '.topology-port' ) ).toBeNull();
		expect(
			cards[ 0 ].querySelector( '.topology-node__sidecars' )
		).toBeNull();
	} );

	it( 'draws each card through clips and blooms its own dialog defines', () => {
		const cards = open();
		const dialog = document.body.querySelector( '[role="dialog"]' );
		const defined = ( url, tag ) => {
			const id = /^url\(#(.+)\)$/.exec( url )[ 1 ];
			return dialog.querySelector( `${ tag }[id="${ id }"]` );
		};
		const clipped = [ ...dialog.querySelectorAll( '[clip-path]' ) ];
		expect( clipped.length ).toBeGreaterThan( 0 );
		for ( const el of clipped ) {
			expect(
				defined( el.getAttribute( 'clip-path' ), 'clipPath' )
			).not.toBeNull();
		}
		for ( const c of cards ) {
			expect(
				c.querySelector( '.topology-nodes--bloom .topology-node' )
			).not.toBeNull();
		}
		const grid = dialog.querySelector( '.topology-sidecars__grid' );
		for ( const skin of [ 'crt', 'neo' ] ) {
			const url = grid.style.getPropertyValue(
				`--topology-bloom-${ skin }`
			);
			expect( defined( url, 'filter' ) ).not.toBeNull();
		}
	} );

	it( 'shares no id with a canvas drawn beside it', () => {
		renderWithCatalog(
			<SchematicCanvas
				parsed={ { nodes: [ { id: 'crawl-4471' } ], edges: [] } }
				selectedId={ null }
				onSelect={ () => {} }
				onDeselect={ () => {} }
				hoveredId={ null }
				onHover={ () => {} }
				rateRef={ { current: new Map() } }
				classCatalog={ {} }
			/>,
			{
				positionOverrides: { 'crawl-4471': { x: 60, y: 80 } },
				onPositionChange: () => {},
				viewport: null,
				onViewportChange: () => {},
			}
		);
		open();
		const ids = [ ...document.querySelectorAll( '[id]' ) ].map(
			( el ) => el.id
		);
		expect( ids.length ).toBeGreaterThan( 4 );
		expect( ids.filter( ( id, i ) => ids.indexOf( id ) !== i ) ).toEqual(
			[]
		);
	} );

	it( 'wears the scope the console skins its cards under', () => {
		open();
		const dialog = document.body.querySelector( '[role="dialog"]' );
		expect( dialog.classList.contains( 'topology-sidecars' ) ).toBe( true );
	} );

	it( 'focuses the first card as it opens', () => {
		const cards = open();
		expect( document.activeElement ).toBe( cards[ 0 ] );
	} );

	it( 'shows the card picked, each card a button the keyboard activates', () => {
		const onPick = jest.fn();
		const cards = open( { onPick } );
		expect( cards.every( ( c ) => 'BUTTON' === c.tagName ) ).toBe( true );
		expect( cards[ 1 ].getAttribute( 'type' ) ).toBe( 'button' );
		fireEvent.click( cards[ 1 ] );
		expect( onPick ).toHaveBeenCalledWith( 'crawl-4471:seen' );
	} );

	it( 'names each card for assistive tech by its node and class', () => {
		const cards = open();
		expect( cards.map( ( c ) => c.getAttribute( 'aria-label' ) ) ).toEqual(
			[ 'crawl-4471:curl (Curl)', 'crawl-4471:seen (Table)' ]
		);
	} );
} );
