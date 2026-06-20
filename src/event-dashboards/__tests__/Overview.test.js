/**
 * Overview — the hub's at-a-glance fleet-health board (the first paint). A live
 * "is everything OK right now?" glance over useTopologyManager: a fleet strip
 * (counts + partitions-up + a worst-health pill), the supervisor card, one row
 * per ACTIVE topology (per-partition worker pills + consumer lag + uptime,
 * problems sorted first), and a de-emphasized group of stopped topologies. The
 * hook's data contract is exercised by its own suite; here it's mocked.
 */

import { render } from '@testing-library/react';
import Overview from '../Overview';

jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyManager: jest.fn(),
} ) );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );

// A worker descriptor (server `dump_graph` shape, passed through verbatim).
function worker( overrides = {} ) {
	return {
		partition: 0,
		status: 'running',
		started_at: 1000,
		heartbeat_age: 2,
		behind: 0,
		restart_pending: false,
		...overrides,
	};
}

function active( name, health, workers, source = 'user' ) {
	return {
		name,
		source,
		active: true,
		health,
		status: { workers },
	};
}

function hookValue( overrides = {} ) {
	return {
		topologies: [],
		supervisor: null,
		currentTime: 5000,
		activate: jest.fn(),
		deactivate: jest.fn(),
		restart: jest.fn(),
		connected: true,
		...overrides,
	};
}

afterEach( () => useTopologyManager.mockReset() );

describe( 'Overview fleet board', () => {
	it( 'fleet strip summarizes topology + active counts and partitions-up', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [
						worker( { partition: 0 } ),
						worker( { partition: 1 } ),
					] ),
					active( 'beta', 'stalled', [
						worker( { partition: 0, status: 'dead' } ),
					] ),
					{ name: 'gamma', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		const fleet = container.querySelector( '.nodes-overview__fleet' );
		expect( fleet.textContent ).toMatch( /3 topologies/ );
		expect( fleet.textContent ).toMatch( /2 active/ );
		// 2 active partitions running (alpha p0+p1), 1 dead (beta) → 2/3 up.
		expect( fleet.textContent ).toMatch( /2\s*\/\s*3/ );
	} );

	it( 'shows a worst-health pill: stalled outranks behind outranks ok', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'a', 'behind', [ worker( { behind: 4096 } ) ] ),
					active( 'b', 'stalled', [ worker( { status: 'dead' } ) ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		const pill = container.querySelector( '.nodes-overview__fleet-health' );
		expect( pill.className ).toContain(
			'nodes-overview__fleet-health--stalled'
		);
		expect( pill.textContent ).toMatch( /1 stalled/ );
	} );

	it( 'an active row shows partition pills, lag, and a live-mode name link', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'behind', [
						worker( { partition: 0, behind: 4096 } ),
					] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		const row = container.querySelector( '.nodes-overview__row' );
		// Name links to live mode.
		const name = row.querySelector( '.nodes-overview__name' );
		expect( name.tagName ).toBe( 'A' );
		expect( name.getAttribute( 'href' ) ).toContain( 'topology=alpha' );
		expect( name.getAttribute( 'href' ) ).not.toContain( 'edit=1' );
		// A partition pill is present.
		expect( row.querySelector( '.nodes-overview__part' ) ).not.toBeNull();
		// Consumer lag is surfaced (the critique's headline metric).
		expect(
			row.querySelector( '.nodes-overview__lag' ).textContent
		).toMatch( /lag/i );
		// Edit deep-link survives.
		expect(
			row.querySelector( '.nodes-overview__edit' ).getAttribute( 'href' )
		).toContain( 'edit=1' );
	} );

	it( 'sorts problem topologies above healthy ones', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'aaa-ok', 'ok', [ worker() ] ),
					active( 'zzz-stalled', 'stalled', [
						worker( { status: 'dead' } ),
					] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		const names = [
			...container.querySelectorAll(
				'.nodes-overview__row .nodes-overview__name'
			),
		].map( ( n ) => n.textContent );
		// 'zzz-stalled' floats above 'aaa-ok' despite sorting last alphabetically.
		expect( names ).toEqual( [ 'zzz-stalled', 'aaa-ok' ] );
	} );

	it( 'puts stopped topologies in a de-emphasized group: plain name, Edit only, no live link', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Not rendered as an active row.
		expect( container.querySelector( '.nodes-overview__row' ) ).toBeNull();
		const stopped = container.querySelector( '.nodes-overview__stopped' );
		expect( stopped ).not.toBeNull();
		const name = stopped.querySelector( '.nodes-overview__name' );
		expect( name.textContent ).toBe( 'beta' );
		expect( name.tagName ).not.toBe( 'A' );
		expect(
			stopped
				.querySelector( '.nodes-overview__edit' )
				.getAttribute( 'href' )
		).toContain( 'edit=1' );
	} );

	it( 'renders a live lag sparkline in each active row', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'behind', [ worker( { behind: 4096 } ) ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect(
			container.querySelector( '.nodes-overview__row .nodes-spark' )
		).not.toBeNull();
	} );

	it( 'accumulates lag samples across polls into the sparkline', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				currentTime: 5000,
				topologies: [
					active( 'alpha', 'behind', [ worker( { behind: 4096 } ) ] ),
				],
			} )
		);
		const { container, rerender } = render( <Overview /> );
		// One sample so far → flat baseline, no polyline yet.
		expect(
			container.querySelector( '.nodes-overview__row polyline' )
		).toBeNull();
		// A second poll (new server tick, higher lag) appends a sample.
		useTopologyManager.mockReturnValue(
			hookValue( {
				currentTime: 5004,
				topologies: [
					active( 'alpha', 'behind', [ worker( { behind: 8192 } ) ] ),
				],
			} )
		);
		rerender( <Overview /> );
		const line = container.querySelector( '.nodes-overview__row polyline' );
		expect( line ).not.toBeNull();
		expect(
			line.getAttribute( 'points' ).trim().split( /\s+/ )
		).toHaveLength( 2 );
	} );

	it( 'offers a New Topology deep-link', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		const { container } = render( <Overview /> );
		expect(
			container
				.querySelector( '.nodes-overview__new' )
				.getAttribute( 'href' )
		).toContain( 'new=1' );
	} );
} );
