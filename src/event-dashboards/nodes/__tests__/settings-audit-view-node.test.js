import { SettingsAuditViewNode } from '../settings-audit-view-node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';

// One settings.p0 record: TM_STRUCT, VALUE = { option }, instant in TIMESTAMP.
function settingsMsg( {
	ts = 1700000000,
	option = 'newspack_flame_colors',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = ts;
	m[ VALUE ] = { option };
	return m;
}

describe( 'SettingsAuditViewNode', () => {
	it( 'records a settings frame as a { ts, option } entry, newest-first', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { ts: 1700000001, option: 'newspack_alpha' } ) );
		v.fill( settingsMsg( { ts: 1700000002, option: 'newspack_beta' } ) );
		const entries = v.snapshot();
		expect( entries.map( ( e ) => e.option ) ).toEqual( [
			'newspack_beta',
			'newspack_alpha',
		] );
		expect( entries[ 0 ].ts ).toBe( 1700000002 );
	} );

	it( 'sorts newest-first by ts even when frames arrive out of ts order', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { ts: 100, option: 'newspack_a' } ) );
		v.fill( settingsMsg( { ts: 96, option: 'newspack_b' } ) );
		v.fill( settingsMsg( { ts: 98, option: 'newspack_c' } ) );
		expect( v.snapshot().map( ( e ) => e.ts ) ).toEqual( [ 100, 98, 96 ] );
	} );

	it( 'breaks a ts tie by arrival seq, newest arrival first', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { ts: 500, option: 'newspack_first' } ) );
		v.fill( settingsMsg( { ts: 500, option: 'newspack_second' } ) );
		expect( v.snapshot().map( ( e ) => e.option ) ).toEqual( [
			'newspack_second',
			'newspack_first',
		] );
	} );

	it( 'carries optional old/new value excerpts onto the entry', () => {
		const v = new SettingsAuditViewNode();
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ TIMESTAMP ] = 1700000000;
		m[ VALUE ] = {
			option: 'newspack_nodes_num_partitions',
			old: '4',
			new: '16',
		};
		v.fill( m );
		const entry = v.snapshot()[ 0 ];
		expect( entry.old ).toBe( '4' );
		expect( entry.new ).toBe( '16' );
	} );

	it( 'leaves old/new undefined for a name-only frame', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { option: 'newspack_nameonly' } ) );
		const entry = v.snapshot()[ 0 ];
		expect( entry.old ).toBeUndefined();
		expect( entry.new ).toBeUndefined();
	} );

	it( 'does NOT dedupe: the same option changed twice yields two rows', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { ts: 1700000010, option: 'newspack_gamma' } ) );
		v.fill( settingsMsg( { ts: 1700000020, option: 'newspack_gamma' } ) );
		expect( v.snapshot() ).toHaveLength( 2 );
	} );

	it( 'gives each entry a stable, unique id (a stable React key)', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { option: 'newspack_delta' } ) );
		v.fill( settingsMsg( { option: 'newspack_delta' } ) );
		const ids = v.snapshot().map( ( e ) => e.id );
		expect( new Set( ids ).size ).toBe( 2 );
	} );

	it( 'ring-caps to maxEntries, dropping the oldest', () => {
		const v = new SettingsAuditViewNode( 3 ); // cap = 3
		for ( let i = 1; i <= 5; i++ ) {
			v.fill(
				settingsMsg( {
					ts: 1700000000 + i,
					option: `newspack_opt${ i }`,
				} )
			);
		}
		const entries = v.snapshot();
		expect( entries ).toHaveLength( 3 );
		expect( entries.map( ( e ) => e.option ) ).toEqual( [
			'newspack_opt5',
			'newspack_opt4',
			'newspack_opt3',
		] );
	} );

	it( 'ignores a non-settings frame (VALUE not an { option } object) without throwing', () => {
		const v = new SettingsAuditViewNode();
		const bare = newMessage();
		bare[ TYPE ] = TM_STRUCT;
		bare[ VALUE ] = { hello: 'world' };
		const line = newMessage();
		line[ TYPE ] = TM_STRUCT;
		line[ VALUE ] = 'not-an-object';
		expect( () => {
			v.fill( bare );
			v.fill( line );
		} ).not.toThrow();
		expect( v.snapshot() ).toEqual( [] );
	} );

	it( 'reads the Message TIMESTAMP as the change instant (epoch seconds)', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg( { ts: 1699999999, option: 'newspack_epsilon' } ) );
		expect( v.snapshot()[ 0 ].ts ).toBe( 1699999999 );
	} );

	it( 'defaults ts to 0 when the frame carries no numeric TIMESTAMP', () => {
		const v = new SettingsAuditViewNode();
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ TIMESTAMP ] = null;
		m[ VALUE ] = { option: 'newspack_untimed' };
		v.fill( m );
		expect( v.snapshot()[ 0 ].ts ).toBe( 0 );
	} );

	it( 'snapshot() returns a FRESH array each call (memo sees a change)', () => {
		const v = new SettingsAuditViewNode();
		v.fill( settingsMsg() );
		expect( v.snapshot() ).not.toBe( v.snapshot() );
		expect( v.snapshot() ).toEqual( v.snapshot() );
	} );

	it( 'publishes a throttled view model via setState("view")', () => {
		const v = new SettingsAuditViewNode();
		const published = [];
		v.setState = ( key, value ) => published.push( [ key, value ] );
		v.fill( settingsMsg( { option: 'newspack_zeta' } ) );
		expect( published ).toHaveLength( 1 );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].entries[ 0 ].option ).toBe(
			'newspack_zeta'
		);
	} );

	it( 'publishes a TRAILING flush so a burst’s newest entry is not swallowed', () => {
		jest.useFakeTimers();
		try {
			const v = new SettingsAuditViewNode();
			const published = [];
			v.setState = ( key, value ) => published.push( value );
			v.fill( settingsMsg( { option: 'newspack_first' } ) ); // leading
			expect( published ).toHaveLength( 1 );
			v.fill( settingsMsg( { option: 'newspack_last' } ) ); // deferred
			expect( published ).toHaveLength( 1 );
			jest.advanceTimersByTime( 500 );
			expect( published ).toHaveLength( 2 ); // trailing flush fired
			expect( published[ 1 ].entries[ 0 ].option ).toBe(
				'newspack_last'
			);
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'removeNode clears a pending trailing-publish timer (no setState after teardown)', () => {
		jest.useFakeTimers();
		try {
			const v = new SettingsAuditViewNode();
			const published = [];
			v.setState = ( key, value ) => published.push( value );
			v.fill( settingsMsg( { option: 'newspack_a' } ) ); // leading publish
			v.fill( settingsMsg( { option: 'newspack_b' } ) ); // schedules trailing
			v.removeNode();
			jest.advanceTimersByTime( 1000 );
			expect( published ).toHaveLength( 1 ); // trailing flush cancelled
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'declares a Hidden, target-free node schema', () => {
		const schema = SettingsAuditViewNode.nodeSchema();
		expect( schema.category ).toBe( 'Hidden' );
		expect( schema.has_target ).toBe( false );
		expect( schema.arguments ).toEqual( [] );
		expect( schema.commands ).toEqual( [] );
	} );
} );
