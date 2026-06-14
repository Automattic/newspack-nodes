import { buildTopologySections } from '../topologyGraph';

// Graph node factory — suffix-free names prove collapse keys on kind/reads/writes.
const gn = ( name, kind, extra = {} ) => ( { name, kind, ...extra } );
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

it( 'groups one section per topology key in the graph', () => {
	const sections = buildTopologySections(
		{
			aggregator: { nodes: [], edges: [] },
			'job-router': { nodes: [], edges: [] },
		},
		[ w( { type: 'aggregator' } ) ],
		[]
	);
	expect( sections.map( ( s ) => s.topology ) ).toEqual( [
		'aggregator',
		'job-router',
	] );
	const agg = sections.find( ( s ) => s.topology === 'aggregator' );
	expect( agg.workers ).toHaveLength( 1 );
	expect( agg.workers[ 0 ].type ).toBe( 'aggregator' );
} );

it( 'collapses a consumer to its reads log and a partition to its writes log (by kind, not name suffix)', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'alpha', 'consumer', { reads: 'firehose.log' } ),
					gn( 'request-builder', 'logic' ),
					gn( 'beta', 'partition', { writes: 'requests.log' } ),
				],
				edges: [
					[ 'alpha', 'request-builder' ],
					[ 'request-builder', 'beta' ],
				],
			},
		},
		[],
		[]
	);
	// Neither the consumer 'alpha' nor the partition 'beta' appears; their logs do.
	expect( names( section.tree ) ).toEqual( [ 'firehose.log' ] );
	const rb = section.tree[ 0 ].children.find(
		( e ) => e.name === 'request-builder'
	);
	expect( rb.kind ).toBe( 'node' );
	expect( names( rb.children ) ).toEqual( [ 'requests.log' ] );
} );

it( 'contracts tees, including a tee feeding a tee', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'in', 'consumer', { reads: 'firehose.log' } ),
					gn( 'tee1', 'tee' ),
					gn( 'tee2', 'tee' ),
					gn( 'left', 'logic' ),
					gn( 'right', 'logic' ),
				],
				edges: [
					[ 'in', 'tee1' ],
					[ 'tee1', 'tee2' ],
					[ 'tee2', 'left' ],
					[ 'tee2', 'right' ],
				],
			},
		},
		[],
		[]
	);
	const firehose = section.tree.find( ( e ) => e.name === 'firehose.log' );
	expect( names( firehose.children ) ).toEqual( [ 'left', 'right' ] );
} );

it( 'roots = in-degree-0 vertices, alpha-sorted', () => {
	const [ section ] = buildTopologySections(
		{
			combined: {
				nodes: [
					gn( 'cache_cozy_tick', 'logic' ),
					gn( 'jobsout', 'partition', { writes: 'jobs.log' } ),
					gn( 'fh', 'consumer', { reads: 'firehose.log' } ),
					gn( 'job-router', 'logic' ),
				],
				edges: [
					[ 'cache_cozy_tick', 'jobsout' ],
					[ 'fh', 'job-router' ],
					[ 'job-router', 'jobsout' ],
				],
			},
		},
		[],
		[]
	);
	expect( names( section.tree ) ).toEqual( [
		'cache_cozy_tick',
		'firehose.log',
	] );
} );

it( 'orders siblings alpha and repeats a multi-writer log under each writer', () => {
	const [ section ] = buildTopologySections(
		{
			combined: {
				nodes: [
					gn( 'fh', 'consumer', { reads: 'firehose.log' } ),
					gn( 'job-router', 'logic' ),
					gn( 'cache_cozy_tick', 'logic' ),
					gn( 'jobsout', 'partition', { writes: 'jobs.log' } ),
				],
				edges: [
					[ 'fh', 'job-router' ],
					[ 'job-router', 'jobsout' ],
					[ 'cache_cozy_tick', 'jobsout' ],
				],
			},
		},
		[],
		[]
	);
	const cacheTick = section.tree.find(
		( e ) => e.name === 'cache_cozy_tick'
	);
	const firehose = section.tree.find( ( e ) => e.name === 'firehose.log' );
	const jobRouter = firehose.children.find(
		( e ) => e.name === 'job-router'
	);
	expect( names( cacheTick.children ) ).toEqual( [ 'jobs.log' ] );
	expect( names( jobRouter.children ) ).toEqual( [ 'jobs.log' ] );
} );

it( 'terminates on a cycle (log writer feeds a node that writes back)', () => {
	expect( () =>
		buildTopologySections(
			{
				t: {
					nodes: [
						gn( 'r', 'consumer', { reads: 'a.log' } ),
						gn( 'loop', 'logic' ),
						gn( 'wr', 'partition', { writes: 'a.log' } ),
					],
					edges: [
						[ 'r', 'loop' ],
						[ 'loop', 'wr' ],
					],
				},
			},
			[],
			[]
		)
	).not.toThrow();
} );

it( 'overlays partitions from the logs catalog onto a log entity', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: 'in.log' } ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[
			{
				name: 'in.log',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
		]
	);
	const inLog = section.tree[ 0 ];
	expect( inLog.kind ).toBe( 'log' );
	expect( inLog.key ).toBe( 'log:in.log' );
	expect( inLog.segment_size ).toBe( 4096 );
	expect( inLog.partitions ).toHaveLength( 1 );
} );

it( 'overlays this topology worker rows onto a logic node entity by handler', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: 'in.log' } ),
					gn( 'request-builder', 'logic' ),
				],
				edges: [ [ 'r', 'request-builder' ] ],
			},
		},
		[
			w( { type: 't', handler: 'request-builder', behind: 5 } ),
			w( { type: 't', handler: 'other', behind: 9 } ),
		],
		[]
	);
	const inLog = section.tree[ 0 ];
	const rb = inLog.children.find( ( e ) => e.name === 'request-builder' );
	expect( rb.kind ).toBe( 'node' );
	expect( rb.key ).toBe( 'node:request-builder' );
	expect( rb.workers ).toHaveLength( 1 );
	expect( rb.workers[ 0 ].behind ).toBe( 5 );
} );

it( 'gives a declared-but-unstaffed logic node an empty worker list', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: 'in.log' } ),
					gn( 'idle', 'logic' ),
				],
				edges: [ [ 'r', 'idle' ] ],
			},
		},
		[],
		[]
	);
	const idle = section.tree[ 0 ].children.find( ( e ) => e.name === 'idle' );
	expect( idle.workers ).toEqual( [] );
} );
