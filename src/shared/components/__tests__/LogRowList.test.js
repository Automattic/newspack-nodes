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
function tickFrame( ts = performance.now() ) {
	const cbs = rafCbs;
	rafCbs = [];
	act( () => cbs.forEach( ( cb ) => cb( ts ) ) );
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

it( 'a burst keeps the unbounded glide, with the ring bound into the window', () => {
	const lines = rows( 5 );
	const node = makeNode( lines );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
		/>
	);
	tickFrame();

	// A 200-row burst lands between frames (ids keep climbing).
	const burst = Array.from( { length: 200 }, ( _, i ) => ( {
		id: 205 - i,
		partition: 0,
		content: `burst-${ 205 - i }`,
		isEven: false,
	} ) );
	lines.unshift( ...burst );
	tickFrame();

	// The glide is untouched: the full burst debt translates (no clamp)…
	const content = container.querySelector(
		'.newspack-nodes-log-rows__content'
	);
	const m = ( content.style.transform || '' ).match( /,(-?[\d.]+)px,/ );
	const offset = m ? parseFloat( m[ 1 ] ) : 0;
	expect( Math.abs( offset ) ).toBeGreaterThan( 18 * 100 );
	// …but the window is BOUND to the transform it committed with: under
	// the current translate, painted rows start at/above the viewport top —
	// the decay reveals real rows, never blank space…
	const rendered = container.querySelectorAll( '.row' );
	const firstContent = rendered[ 0 ].getAttribute( 'data-content' );
	const firstIndex = 205 - parseInt( firstContent.split( '-' )[ 1 ], 10 );
	expect( firstIndex * 18 + offset ).toBeLessThanOrEqual( 0 );
	// …and the window stays O(viewport + glide path), not the whole ring.
	expect( rendered.length ).toBeLessThan( 60 );
} );

it( 'a flood caps the glide debt so the window stays bounded and fresh', () => {
	const lines = rows( 5 );
	const node = makeNode( lines );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
		/>
	);
	tickFrame();

	// A 2000-row flood lands between frames — far past any perceivable glide.
	const flood = Array.from( { length: 2000 }, ( _, i ) => ( {
		id: 2005 - i,
		partition: 0,
		content: `flood-${ 2005 - i }`,
		isEven: false,
	} ) );
	lines.unshift( ...flood );
	tickFrame();

	// The debt is clamped to the glide budget (MAX_DEBT_ROWS * rowHeight)…
	const content = container.querySelector(
		'.newspack-nodes-log-rows__content'
	);
	const m = ( content.style.transform || '' ).match( /,(-?[\d.]+)px,/ );
	const offset = m ? parseFloat( m[ 1 ] ) : 0;
	expect( Math.abs( offset ) ).toBeLessThanOrEqual( 300 * 18 );
	// …so the painted window stays bounded instead of scaling with the flood…
	const rendered = container.querySelectorAll( '.row' );
	expect( rendered.length ).toBeLessThan( 100 );
	// …while the glide invariant holds: painted rows start at/above the top.
	const firstContent = rendered[ 0 ].getAttribute( 'data-content' );
	const firstIndex = 2005 - parseInt( firstContent.split( '-' )[ 1 ], 10 );
	expect( firstIndex * 18 + offset ).toBeLessThanOrEqual( 0 );
} );

it( 'a flood outrunning the ring never blanks the viewport', () => {
	// @longform Ring capped at 300 while debt would exceed it: ids jump by
	// 2000 but only the newest 300 survive — the uncapped debt put start
	// past visible and rendered NOTHING (alternating-empty-viewport bug).
	const lines = rows( 300 );
	const node = makeNode( lines );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
		/>
	);
	tickFrame();

	const churned = Array.from( { length: 300 }, ( _, i ) => ( {
		id: 2300 - i,
		partition: 0,
		content: `churn-${ 2300 - i }`,
		isEven: false,
	} ) );
	lines.length = 0;
	lines.push( ...churned );
	tickFrame();

	expect( container.querySelectorAll( '.row' ).length ).toBeGreaterThan( 0 );
} );

// @longform A saturated ring pins linesCount while the pinned debt clamp
// pins the offset — every recommit-guard input freezes even though the ring
// keeps rotating. The guard must also watch the top row id, or the viewport
// shows stale rows indefinitely (frozen is as broken as blank).
it( 'a sustained flood at ring saturation keeps the window fresh', () => {
	const lines = rows( 400 );
	const node = makeNode( lines );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
		/>
	);
	tickFrame();

	// Rotate the saturated ring hard for several frames (ids keep climbing).
	const rotate = ( gen ) => {
		const fresh = Array.from( { length: 400 }, ( _, i ) => ( {
			id: gen * 1000 + 400 - i,
			partition: 0,
			content: `gen${ gen }-${ 400 - i }`,
			isEven: false,
		} ) );
		lines.length = 0;
		lines.push( ...fresh );
	};
	rotate( 1 );
	tickFrame();
	rotate( 2 );
	tickFrame();
	const before = [ ...container.querySelectorAll( '.row' ) ].map( ( el ) =>
		el.getAttribute( 'data-content' )
	);
	rotate( 3 );
	tickFrame();
	const after = [ ...container.querySelectorAll( '.row' ) ].map( ( el ) =>
		el.getAttribute( 'data-content' )
	);
	expect( after ).not.toEqual( before );
	expect( after.join() ).toContain( 'gen3-' );
} );

it( 'debug mode stays fresh while a saturated ring rotates', () => {
	const lines = rows( 40 );
	const node = makeNode( lines );
	const { container } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			debug
		/>
	);
	tickFrame();

	// Same count, newer ids: the visible/end guard alone would freeze this.
	const fresh = Array.from( { length: 40 }, ( _, i ) => ( {
		id: 1040 - i,
		partition: 0,
		content: `fresh-${ 1040 - i }`,
		isEven: false,
	} ) );
	lines.length = 0;
	lines.push( ...fresh );
	tickFrame();

	expect(
		container.querySelector( '.row' ).getAttribute( 'data-content' )
	).toBe( 'fresh-1040' );
} );

it( 'coalesces stats reports to the stats interval', () => {
	const lines = rows( 10 );
	const node = makeNode( lines );
	const onStats = jest.fn();
	render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ renderRow }
			onStats={ onStats }
		/>
	);
	const t0 = performance.now();
	tickFrame( t0 );
	expect( onStats ).toHaveBeenCalledTimes( 1 );

	// Rapid frames with changing totals stay quiet inside the interval…
	lines.unshift( { id: 11, partition: 0, content: 'a', isEven: false } );
	tickFrame( t0 + 16 );
	lines.unshift( { id: 12, partition: 0, content: 'b', isEven: true } );
	tickFrame( t0 + 32 );
	expect( onStats ).toHaveBeenCalledTimes( 1 );

	// …and the next frame past the interval publishes the fresh totals.
	tickFrame( t0 + 300 );
	expect( onStats ).toHaveBeenCalledTimes( 2 );
	expect( onStats ).toHaveBeenLastCalledWith(
		expect.objectContaining( { total: 12 } )
	);
} );

it( 'reuses row elements when the parent re-renders with an unchanged model', () => {
	const node = makeNode( rows( 20 ) );
	const spyRender = jest.fn( renderRow );
	const { rerender } = render(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ spyRender }
		/>
	);
	tickFrame();
	const calls = spyRender.mock.calls.length;
	expect( calls ).toBeGreaterThan( 0 );

	// A parent re-render (e.g. a toolbar stats tick) must not re-map rows.
	rerender(
		<LogRowList
			getNode={ () => node }
			rowHeight={ 18 }
			renderRow={ spyRender }
		/>
	);
	expect( spyRender.mock.calls.length ).toBe( calls );
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

it( 'leaving debug mode does not replay rows that arrived during it', () => {
	const lines = rows( 10 );
	const node = makeNode( lines );
	const props = {
		getNode: () => node,
		rowHeight: 18,
		renderRow,
	};
	const { container, rerender } = render( <LogRowList { ...props } debug /> );
	tickFrame();

	// Rows stream in while debug is active (ids keep climbing).
	for ( let k = 0; k < 60; k++ ) {
		lines.unshift( {
			id: 11 + k,
			partition: 0,
			content: `during-${ k }`,
			isEven: false,
		} );
	}
	tickFrame();

	// Back to the live regime: no glide debt for already-seen rows.
	rerender( <LogRowList { ...props } debug={ false } /> );
	tickFrame();
	const content = container.querySelector(
		'.newspack-nodes-log-rows__content'
	);
	const m = ( content.style.transform || '' ).match( /,(-?[\d.]+)px,/ );
	expect( m ? parseFloat( m[ 1 ] ) : 0 ).toBe( 0 );
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
	const t0 = performance.now();
	tickFrame( t0 );
	expect( onStats ).toHaveBeenLastCalledWith(
		expect.objectContaining( { total: 10 } )
	);
	current = nodeB;
	// Past the stats-coalescing interval so the fresh node's totals publish.
	tickFrame( t0 + 300 );
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
