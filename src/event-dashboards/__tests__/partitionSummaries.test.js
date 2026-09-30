import { partitionSummaries } from '../partitionSummaries';

const w = ( partition, o = {} ) => ( {
	partition,
	state: o.state ?? 'live',
	started_at: o.started_at ?? 1000,
	heartbeat_age: o.heartbeat_age ?? 2,
	restart_pending: o.restart_pending ?? false,
} );

it( 'one summary per partition, sorted, from any row of that partition', () => {
	const out = partitionSummaries( [ w( 1 ), w( 0 ), w( 0 ) ] );
	expect( out.map( ( s ) => s.partition ) ).toEqual( [ 0, 1 ] );
	expect( out[ 0 ] ).toEqual( {
		partition: 0,
		state: 'live',
		started_at: 1000,
		heartbeat_age: 2,
		restart_pending: false,
	} );
} );

it( 'restart_pending true if any row of the partition is pending', () => {
	const [ p0 ] = partitionSummaries( [
		w( 0 ),
		w( 0, { restart_pending: true } ),
	] );
	expect( p0.restart_pending ).toBe( true );
} );

it( "carries each partition's server state, never re-derived here", () => {
	const out = partitionSummaries( [
		w( 0, { state: 'held' } ),
		w( 1, { state: 'idle' } ),
		w( 2, { state: 'stale', heartbeat_age: 1 } ),
	] );
	expect( out.map( ( s ) => s.state ) ).toEqual( [
		'held',
		'idle',
		'stale',
	] );
} );

it( 'handles empty input', () => {
	expect( partitionSummaries( [] ) ).toEqual( [] );
	expect( partitionSummaries( undefined ) ).toEqual( [] );
} );
