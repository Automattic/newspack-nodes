import { buildTopologySections } from '../topologyGraph';

const w = ( o ) => ( {
	type: o.type,
	handler: o.handler ?? o.type,
	source: o.source ?? '',
	partition: o.partition ?? 0,
	inputs: o.inputs ?? [],
	outputs: o.outputs ?? [],
	status: o.status ?? 'running',
	started_at: o.started_at ?? 1000,
	heartbeat_age: o.heartbeat_age ?? 1,
	restart_pending: o.restart_pending ?? false,
	behind: o.behind ?? 0,
	inputs_status: o.inputs_status ?? [],
	outputs_status: o.outputs_status ?? [],
} );
const names = ( entities ) => entities.map( ( e ) => e.name );

it( 'groups workers into one section per topology (type)', () => {
	const sections = buildTopologySections(
		[
			w( { type: 'aggregator', outputs: [ 'firehose.log' ] } ),
			w( {
				type: 'job-router',
				inputs: [ 'firehose.log' ],
				outputs: [ 'jobintake.log' ],
			} ),
		],
		[]
	);
	expect( sections.map( ( s ) => s.topology ).sort() ).toEqual( [
		'aggregator',
		'job-router',
	] );
	// Each section carries its own workers (so the view needn't re-filter).
	const agg = sections.find( ( s ) => s.topology === 'aggregator' );
	expect( agg.workers ).toHaveLength( 1 );
	expect( agg.workers[ 0 ].type ).toBe( 'aggregator' );
} );

it( 'roots = source nodes + logs consumed-but-not-produced, alpha-sorted', () => {
	const [ section ] = buildTopologySections(
		[
			w( {
				type: 'combined',
				handler: 'cache_cozy_tick',
				outputs: [ 'jobs.log' ],
			} ),
			w( {
				type: 'combined',
				handler: 'job-router',
				inputs: [ 'firehose.log' ],
				outputs: [ 'jobs.log' ],
			} ),
		],
		[]
	);
	expect( names( section.tree ) ).toEqual( [
		'cache_cozy_tick',
		'firehose.log',
	] );
} );

it( 'a node child = its output logs (alpha); a log child = its reader nodes (alpha)', () => {
	const [ section ] = buildTopologySections(
		[
			w( {
				type: 't',
				handler: 'request-builder',
				inputs: [ 'firehose.log' ],
				outputs: [ 'requests.log', 'completed.log', 'errors.log' ],
			} ),
			w( {
				type: 't',
				handler: 'flame-builder',
				inputs: [ 'requests.log' ],
				outputs: [ 'flames.log' ],
			} ),
		],
		[]
	);
	const firehose = section.tree.find( ( e ) => e.name === 'firehose.log' );
	const rb = firehose.children.find( ( e ) => e.name === 'request-builder' );
	expect( names( rb.children ) ).toEqual( [
		'completed.log',
		'errors.log',
		'requests.log',
	] );
	const requests = rb.children.find( ( e ) => e.name === 'requests.log' );
	expect( names( requests.children ) ).toEqual( [ 'flame-builder' ] );
	expect( names( requests.children[ 0 ].children ) ).toEqual( [
		'flames.log',
	] );
} );

it( 'a multi-writer log appears under each writer', () => {
	const [ section ] = buildTopologySections(
		[
			w( {
				type: 't',
				handler: 'job-router',
				inputs: [ 'firehose.log' ],
				outputs: [ 'jobs.log' ],
			} ),
			w( {
				type: 't',
				handler: 'cache_cozy_tick',
				outputs: [ 'jobs.log' ],
			} ),
		],
		[]
	);
	const writers = section.tree
		.flatMap( ( e ) => ( e.kind === 'node' ? [ e ] : e.children ) )
		.filter( ( e ) => e.kind === 'node' );
	const jobsUnder = writers.filter( ( n ) =>
		n.children.some( ( c ) => c.name === 'jobs.log' )
	);
	expect( jobsUnder.map( ( n ) => n.name ).sort() ).toEqual( [
		'cache_cozy_tick',
		'job-router',
	] );
} );

it( 'terminates on a cycle (log → node → same log)', () => {
	expect( () =>
		buildTopologySections(
			[
				w( {
					type: 't',
					handler: 'loop',
					inputs: [ 'a.log' ],
					outputs: [ 'a.log' ],
				} ),
			],
			[]
		)
	).not.toThrow();
} );

it( 'log entities carry kind + segment partitions; node entities carry their worker rows', () => {
	const [ section ] = buildTopologySections(
		[
			w( {
				type: 't',
				handler: 'n',
				inputs: [ 'in.log' ],
				outputs: [ 'out.log' ],
				behind: 5,
			} ),
		],
		[]
	);
	const inLog = section.tree[ 0 ];
	expect( inLog.kind ).toBe( 'log' );
	expect( Array.isArray( inLog.partitions ) ).toBe( true );
	expect( inLog.children[ 0 ].kind ).toBe( 'node' );
	expect( inLog.children[ 0 ].workers[ 0 ].behind ).toBe( 5 );
} );
