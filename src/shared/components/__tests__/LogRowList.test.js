/**
 * LogRowList tests — the shared, ring-aware DOM-virtualized log list.
 *
 * The list reads a ring-backed view node (`linesCount` + `lineAt(i)`, newest
 * first) and renders ONLY the on-screen virtualization window each rAF frame via
 * `lineAt(i)` — it never materializes the whole ring (the 100k-buffer caveat).
 * It reports `{ total, visible, lps }` up to the consumer's toolbar and does the
 * new-row smooth-scroll compensation the old canvas renderer did.
 */

import { render, act } from '@testing-library/react';
import LogRowList, { DEBUG_MAX_ROWS } from '../LogRowList';

// Minimal ring fixture: newest-first `lines`, the node API the list consumes.
function makeNode( lines, lps = 0 ) {
	return {
		lps,
		lineAtCalls: 0,
		get linesCount() {
			return lines.length;
		},
		lineAt( i ) {
			this.lineAtCalls += 1;
			return lines[ i ];
		},
	};
}

// Build N newest-first rows with monotonically DECREASING ids (0 is newest).
function rows( n, prefix = 'line' ) {
	return Array.from( { length: n }, ( _, i ) => ( {
		id: n - i,
		partition: 0,
		content: `${ prefix }-${ n - i }`,
		isEven: ( n - i ) % 2 === 0,
	} ) );
}

let rafCbs;
beforeEach( () => {
	rafCbs = [];
	global.requestAnimationFrame = ( cb ) => {
		rafCbs.push( cb );
		return rafCbs.length;
	};
	global.cancelAnimationFrame = () => {};
} );

// Run every queued frame once (each re-arms; we drain the current batch).
function tickFrame() {
	const cbs = rafCbs;
	rafCbs = [];
	act( () => cbs.forEach( ( cb ) => cb( performance.now() ) ) );
}

const renderRow = ( row ) => (
	<div key={ row.id } className="row" data-content={ row.content }>
		{ row.content }
	</div>
);

it( 'pulls only the on-screen window via lineAt, not the whole 40-row ring', () => {
	const node = makeNode( rows( 40 ) );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
		/>
	);
	tickFrame();
	const rendered = container.querySelectorAll( '.row' );
	// A materialize-the-whole-ring regression would render all 40.
	expect( rendered.length ).toBeGreaterThan( 0 );
	expect( rendered.length ).toBeLessThan( 40 );
	// The spacer still sizes to the FULL ring so the scrollbar is honest.
	const content = container.querySelector(
		'.newspack-nodes-log-rows__content'
	);
	expect( content.style.minHeight ).toBe( `${ 40 * 18 }px` );
} );

it( 'reports total / visible / lps up to the consumer', () => {
	const node = makeNode( rows( 40 ), 7.5 );
	const onStats = jest.fn();
	render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			onStats={ onStats }
		/>
	);
	tickFrame();
	expect( onStats ).toHaveBeenCalledWith( {
		total: 40,
		visible: 40,
		lps: 7.5,
	} );
} );

it( 'filters the ring, reporting and rendering only matching rows', () => {
	const base = rows( 30, 'plain' );
	base[ 3 ].content = 'zebra-alpha';
	base[ 9 ].content = 'zebra-beta';
	const node = makeNode( base );
	const onStats = jest.fn();
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			filter="zebra"
			onStats={ onStats }
		/>
	);
	tickFrame();
	expect( onStats ).toHaveBeenLastCalledWith( {
		total: 30,
		visible: 2,
		lps: 0,
	} );
	const rendered = [ ...container.querySelectorAll( '.row' ) ];
	expect( rendered.length ).toBe( 2 );
	rendered.forEach( ( el ) =>
		expect( el.dataset.content ).toMatch( /zebra/ )
	);
} );

it( 'debug mode renders the newest rows unvirtualized, capped at DEBUG_MAX_ROWS', () => {
	const node = makeNode( rows( DEBUG_MAX_ROWS + 40 ) );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			debug
		/>
	);
	tickFrame();
	// Every rendered row is real content (no spacer window math)…
	expect( container.querySelectorAll( '.row' ).length ).toBe(
		DEBUG_MAX_ROWS
	);
	// …starting from the NEWEST row.
	expect(
		container.querySelector( '.row' ).getAttribute( 'data-content' )
	).toBe( `line-${ DEBUG_MAX_ROWS + 40 }` );
	// Natural heights: no fixed-height spacer container sizing.
	expect(
		container.querySelector( '.newspack-nodes-log-rows.is-debug' )
	).not.toBeNull();
} );

it( 'debug mode windows the filter matches the same way', () => {
	const base = rows( 30, 'noise' );
	base[ 3 ].content = 'needle 4194';
	const node = makeNode( base );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			filter="needle"
			debug
		/>
	);
	tickFrame();
	const rendered = container.querySelectorAll( '.row' );
	expect( rendered.length ).toBe( 1 );
	expect( rendered[ 0 ].getAttribute( 'data-content' ) ).toBe(
		'needle 4194'
	);
} );

it( 'shows the empty label when there are no rows', () => {
	const node = makeNode( [] );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			emptyLabel="Nothing streaming"
		/>
	);
	tickFrame();
	expect( container.textContent ).toMatch( /Nothing streaming/ );
	expect( container.querySelectorAll( '.row' ).length ).toBe( 0 );
} );

it( 'reads the current node each frame so a graph reinit is picked up', () => {
	const nodeA = makeNode( rows( 10 ) );
	const nodeB = makeNode( rows( 25 ) );
	let current = nodeA;
	const onStats = jest.fn();
	render(
		<LogRowList
			getNode={ () => current }
			rowHeight={ 18 }
			renderRow={ renderRow }
			onStats={ onStats }
		/>
	);
	tickFrame();
	expect( onStats ).toHaveBeenLastCalledWith(
		expect.objectContaining( { total: 10 } )
	);
	current = nodeB;
	tickFrame();
	expect( onStats ).toHaveBeenLastCalledWith(
		expect.objectContaining( { total: 25 } )
	);
} );

it( 'maintains scroll position when new rows arrive while scrolled down', () => {
	const lines = rows( 50 );
	const node = makeNode( lines );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
		/>
	);
	tickFrame();
	const list = container.querySelector( '.newspack-nodes-log-rows' );
	// Scroll down past the top zone so the "reading history" branch runs.
	list.scrollTop = 200;
	// Prepend 4 newer rows (ids above the current top of 50).
	for ( let k = 0; k < 4; k++ ) {
		lines.unshift( {
			id: 51 + k,
			partition: 0,
			content: `new-${ k }`,
			isEven: false,
		} );
	}
	tickFrame();
	expect( list.scrollTop ).toBe( 200 + 4 * 18 );
} );
