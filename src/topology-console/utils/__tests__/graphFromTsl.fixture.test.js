import fs from 'fs';
import path from 'path';
import { graphFromTsl } from '../draftToGraph';

// The SAME request-builder.tsl the PHP TopologyRegistryFixtureTest drives, so
// both static parsers are verified against identical input: make/connect/
// command aliases, backslash continuations, and cd cwd-pathing.
const FIXTURE = fs.readFileSync(
	path.join( __dirname, '../../../../tests/fixtures/request-builder.tsl' ),
	'utf8'
);

describe( 'graphFromTsl — request-builder.tsl fixture', () => {
	const byName = () => {
		const g = graphFromTsl( FIXTURE );
		const map = {};
		for ( const n of g.nodes ) {
			map[ n.name ] = n;
		}
		return { g, map };
	};

	it( 'joins a multiline backslash-continued make_node', () => {
		const { map } = byName();
		expect( map[ 'firehose:consumer' ].ctorArgs ).toEqual( [
			'<config:logs_dir>/firehose.p<partition>',
			'<config:offsets_dir>/firehose.<topology>.p<partition>',
			'<config:deadletter_dir>/firehose.<topology>.p<partition>',
		] );
		expect( Object.keys( map ) ).toEqual( [
			'firehose:consumer',
			'fanout',
			'completed:tee',
			'requests:partition',
			'errors:partition',
			'gyroscope:partition',
			'completed:partition',
		] );
	} );

	it( 'captures cd-block bare verbs + cmd as verbInvocations on the cwd node', () => {
		const { map } = byName();
		expect( map.fanout.verbInvocations ).toEqual( [
			{ verb: 'set_multi_writer', args: [ 'true' ], viaConfig: true },
			{
				verb: 'set_completed_target',
				args: [ 'completed:tee' ],
				viaConfig: true,
			},
			{
				verb: 'set_errors_target',
				args: [ 'errors:partition' ],
				viaConfig: true,
			},
			{
				verb: 'set_inflight_target',
				args: [ 'gyroscope:partition' ],
				viaConfig: true,
			},
		] );
	} );

	it( 'captures command / command_node alias verbs', () => {
		const { map } = byName();
		expect( map[ 'requests:partition' ].verbInvocations ).toEqual( [
			{ verb: 'with_index', args: [ 'request-index' ], viaConfig: true },
			{ verb: 'void_warranty', args: [], viaConfig: true },
		] );
		// `command errors:partition void_warranty` — the BARE form, which is
		// how an interpreter-class node takes a verb directly.
		expect( map[ 'errors:partition' ].verbInvocations ).toEqual( [
			{ verb: 'void_warranty', args: [], viaConfig: false },
		] );
		expect( map[ 'completed:partition' ].verbInvocations ).toEqual( [
			{ verb: 'void_warranty', args: [], viaConfig: true },
		] );
	} );

	it( 'wires connect / connect_node alias + continuation edges', () => {
		const { g } = byName();
		const edges = g.edges.map( ( e ) => `${ e.from }->${ e.to }` );
		expect( edges ).toContain( 'firehose:consumer->fanout' );
		expect( edges ).toContain( 'fanout->requests:partition' );
		expect( edges ).toContain( 'completed:tee->completed:partition' );
		expect( edges ).toContain( 'completed:tee->gyroscope:partition' );
	} );
} );
