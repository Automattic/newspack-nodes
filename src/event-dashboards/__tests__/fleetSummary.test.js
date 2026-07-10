import { fleetSummary } from '../fleetSummary';

// A topology row as useTopologyManager emits it (active, partitions, health).
const topo = ( name, o = {} ) => ( {
	name,
	active: o.active ?? true,
	num_partitions: o.num_partitions ?? 1,
	health: o.health ?? 'ok',
	status: o.workers ? { workers: o.workers } : null,
} );
const wk = ( partition, status = 'running' ) => ( { partition, status } );

it( 'counts topologies and active topologies', () => {
	const s = fleetSummary( [
		topo( 'a' ),
		topo( 'b', { active: false } ),
		topo( 'c' ),
	] );
	expect( s.topologyCount ).toBe( 3 );
	expect( s.activeCount ).toBe( 2 );
} );

it( 'workersTotal counts CONFIGURED num_partitions over active topologies, not reporting workers', () => {
	// A 2-partition topology missing its 2nd worker still counts 2, not 1.
	const s = fleetSummary( [
		topo( 'a', { num_partitions: 2, workers: [ wk( 0 ) ] } ),
	] );
	expect( s.workersTotal ).toBe( 2 );
	expect( s.workersUp ).toBe( 1 );
} );

it( 'workersUp counts running partitions and is capped at num_partitions', () => {
	const s = fleetSummary( [
		topo( 'a', {
			num_partitions: 1,
			workers: [ wk( 0, 'running' ), wk( 0, 'running' ) ],
		} ),
	] );
	expect( s.workersUp ).toBe( 1 );
	expect( s.workersTotal ).toBe( 1 );
} );

it( 'excludes inactive topologies from the worker counts', () => {
	const s = fleetSummary( [
		topo( 'a', { workers: [ wk( 0 ) ] } ),
		topo( 'b', { active: false, num_partitions: 4 } ),
	] );
	expect( s.workersTotal ).toBe( 1 );
	expect( s.workersUp ).toBe( 1 );
} );

it( 'defaults a missing/zero num_partitions to 1', () => {
	const s = fleetSummary( [
		{ name: 'a', active: true, status: { workers: [ wk( 0 ) ] } },
	] );
	expect( s.workersTotal ).toBe( 1 );
} );

it( 'rolls health up to the worst across active topologies', () => {
	expect(
		fleetSummary( [ topo( 'a' ), topo( 'b', { health: 'behind' } ) ] )
			.health
	).toBe( 'behind' );
	expect(
		fleetSummary( [
			topo( 'a', { health: 'behind' } ),
			topo( 'b', { health: 'stalled' } ),
		] ).health
	).toBe( 'stalled' );
	expect( fleetSummary( [ topo( 'a' ) ] ).health ).toBe( 'ok' );
} );

it( 'a stopped topology never drags fleet health below ok', () => {
	const s = fleetSummary( [
		topo( 'a' ),
		topo( 'b', { active: false, health: 'stalled' } ),
	] );
	expect( s.health ).toBe( 'ok' );
} );

it( 'counts behind and stalled active topologies for the health label', () => {
	const s = fleetSummary( [
		topo( 'a', { health: 'stalled' } ),
		topo( 'b', { health: 'behind' } ),
		topo( 'c', { health: 'behind' } ),
		topo( 'd', { active: false, health: 'stalled' } ),
	] );
	expect( s.stalledCount ).toBe( 1 );
	expect( s.behindCount ).toBe( 2 );
} );

it( 'empty fleet is ok with zero counts', () => {
	expect( fleetSummary( [] ) ).toEqual( {
		topologyCount: 0,
		activeCount: 0,
		workersUp: 0,
		workersTotal: 0,
		health: 'ok',
		behindCount: 0,
		stalledCount: 0,
	} );
} );
