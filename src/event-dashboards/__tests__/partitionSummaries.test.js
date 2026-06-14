import { partitionSummaries } from '../partitionSummaries';

const w = ( partition, o = {} ) => ( {
	partition,
	status: o.status ?? 'running',
	started_at: o.started_at ?? 1000,
	heartbeat_age: o.heartbeat_age ?? 2,
	restart_pending: o.restart_pending ?? false,
} );

it( 'one summary per partition, sorted, from any row of that partition', () => {
	const out = partitionSummaries( [ w( 1 ), w( 0 ), w( 0 ) ] );
	expect( out.map( ( s ) => s.partition ) ).toEqual( [ 0, 1 ] );
	expect( out[ 0 ] ).toMatchObject( {
		status: 'running',
		started_at: 1000,
		heartbeat_age: 2,
	} );
} );

it( 'restart_pending true if any row of the partition is pending', () => {
	const [ p0 ] = partitionSummaries( [
		w( 0 ),
		w( 0, { restart_pending: true } ),
	] );
	expect( p0.restart_pending ).toBe( true );
} );

it( 'reflects per-partition status (all dead)', () => {
	const out = partitionSummaries( [
		w( 0, { status: 'dead' } ),
		w( 1, { status: 'dead' } ),
	] );
	expect( out.every( ( s ) => s.status === 'dead' ) ).toBe( true );
} );

it( 'handles empty input', () => {
	expect( partitionSummaries( [] ) ).toEqual( [] );
	expect( partitionSummaries( undefined ) ).toEqual( [] );
} );
