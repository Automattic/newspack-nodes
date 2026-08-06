import { buildTopologySections } from '../topologyGraph';

// Graph node factory — suffix-free names prove kind/reads/writes collapse.
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
// Depth-first search for the first entity (at any depth) matching a predicate.
const findEntity = ( entities, pred ) => {
	for ( const e of entities ) {
		if ( pred( e ) ) {
			return e;
		}
		const hit = findEntity( e.children || [], pred );
		if ( hit ) {
			return hit;
		}
	}
	return undefined;
};

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
	// Neither consumer 'alpha' nor partition 'beta' appears; their logs do.
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

it( 'each grouped partition carries its CONCRETE catalog name as the rate key (render === transform)', () => {
	// COUPLED RATE KEY: transform + render both key on the concrete name.
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: 'firehose.p<partition>' } ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[
			{
				name: 'firehose.p0',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'firehose.p1',
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
		]
	);
	const log = section.tree.find( ( e ) => e.kind === 'log' );
	// Render key = concrete name; transform key = log.name (same string).
	expect( log.partitions.map( ( p ) => p.name ) ).toEqual( [
		'firehose.p0',
		'firehose.p1',
	] );
} );

it( 'the concrete rate key couples render and transform for a NON-.p{N} layout', () => {
	// Partition token need not be trailing; both key the concrete name.
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: '<partition>-req' } ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[
			{
				name: '0-req',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: '1-req',
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
		]
	);
	const log = section.tree.find( ( e ) => e.kind === 'log' );
	// Render key = partition.name = log.name; coupling holds, token at FRONT.
	expect( log.partitions.map( ( p ) => p.name ) ).toEqual( [
		'0-req',
		'1-req',
	] );
} );

it( 'groups a partition-token log vertex into ONE logical entity with its partitions as sub-rows', () => {
	// A literal <partition> vertex must GROUP into ONE logical log entity.
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: 'firehose.p<partition>' } ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[
			{
				name: 'firehose.p0',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'firehose.p1',
				segment_size: 4096,
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
		]
	);
	// Exactly ONE logical log entity, named by the token-stripped vertex.
	const logs = section.tree.filter( ( e ) => e.kind === 'log' );
	expect( names( logs ) ).toEqual( [ 'firehose' ] );
	// It carries both partitions as sub-rows.
	expect( logs[ 0 ].partitions ).toHaveLength( 2 );
	expect( logs[ 0 ].partitions[ 0 ].partition ).toBe( 0 );
	expect( logs[ 0 ].partitions[ 1 ].partition ).toBe( 1 );
} );

it( 'groups a Topic vertex carrying the curly {partition} token like an angle-token log', () => {
	// Curly {partition} token must group like <partition> (aggregator-tab bug).
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'src', 'logic' ),
					gn( 'topic', 'topic', { writes: 'firehose.p{partition}' } ),
				],
				edges: [ [ 'src', 'topic' ] ],
			},
		},
		[],
		[
			{
				name: 'firehose.p0',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'firehose.p1',
				segment_size: 4096,
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
		]
	);
	// The topic's writes-log must be ONE logical firehose entity, not a token.
	const log = section.tree[ 0 ].children.find( ( e ) => e.kind === 'log' );
	expect( log.name ).toBe( 'firehose' );
	expect( log.partitions ).toHaveLength( 2 );
	expect( log.partitions[ 0 ].partition ).toBe( 0 );
	expect( log.partitions[ 1 ].partition ).toBe( 1 );
} );

it( 'renders a source log consumer subtree ONCE, not duplicated per partition', () => {
	// Bug 79c9dd6: a SOURCE log's consumer subtree must render EXACTLY ONCE.
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'fh-in', 'consumer', {
						reads: 'firehose.p<partition>',
					} ),
					gn( 'request-builder', 'logic' ),
					gn( 'completed-out', 'partition', {
						writes: 'completed.p<partition>',
					} ),
					gn( 'requests-out', 'partition', {
						writes: 'requests.p<partition>',
					} ),
				],
				edges: [
					[ 'fh-in', 'request-builder' ],
					[ 'request-builder', 'completed-out' ],
					[ 'request-builder', 'requests-out' ],
				],
			},
		},
		[],
		[
			{
				name: 'firehose.p0',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'firehose.p1',
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
			{
				name: 'completed.p0',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'completed.p1',
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
			{
				name: 'requests.p0',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'requests.p1',
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
		]
	);
	// Walk the built tree, counting every entity by name.
	const counts = {};
	const walk = ( ents ) =>
		ents.forEach( ( e ) => {
			counts[ e.name ] = ( counts[ e.name ] || 0 ) + 1;
			walk( e.children );
		} );
	walk( section.tree );
	// (a) exactly ONE firehose logical entity.
	expect( counts.firehose ).toBe( 1 );
	// (b) the request-builder subtree appears EXACTLY ONCE.
	expect( counts[ 'request-builder' ] ).toBe( 1 );
	// (c) completed/requests each render as ONE grouped logical entity.
	expect( counts.completed ).toBe( 1 );
	expect( counts.requests ).toBe( 1 );
	// And the firehose entity carries both partitions as sub-rows.
	const firehose = section.tree.find( ( e ) => e.name === 'firehose' );
	expect( firehose.partitions ).toHaveLength( 2 );
} );

it( 'does not over-match a sibling log that shares the partition-token prefix', () => {
	// Substituted middle must be all-digits (no over-match on a sibling).
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', {
						reads: 'firehose.p<partition>',
					} ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[
			{
				name: 'firehose.p0',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'firehose.p1',
				segment_size: 4096,
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
			{
				name: 'firehose.priority.p0',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
		]
	);
	const logs = section.tree.filter( ( e ) => e.kind === 'log' );
	// One logical `firehose` entity with exactly its two partitions.
	expect( names( logs ) ).toEqual( [ 'firehose' ] );
	expect( logs[ 0 ].partitions.map( ( p ) => p.partition ) ).toEqual( [
		0, 1,
	] );
} );

it( 'matches a token at an arbitrary position and rejects a non-digit middle', () => {
	// Token in MIDDLE: 0-req/1-req match (digit), x-req rejected (non-digit).
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: '<partition>-req' } ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[
			{
				name: '0-req',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: '1-req',
				segment_size: 4096,
				partitions: [ { partition: 1, segments: [], total_size: 0 } ],
			},
			{
				name: 'x-req',
				segment_size: 4096,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
		]
	);
	const logs = section.tree.filter( ( e ) => e.kind === 'log' );
	// x-req has a non-digit middle and is rejected; only digit ones group.
	expect( names( logs ) ).toEqual( [ 'req' ] );
	expect( logs[ 0 ].partitions.map( ( p ) => p.partition ) ).toEqual( [
		0, 1,
	] );
} );

it( 'falls back to the literal partition-token vertex when no concrete catalog entry matches', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'r', 'consumer', { reads: 'missing.p<partition>' } ),
					gn( 'n', 'logic' ),
				],
				edges: [ [ 'r', 'n' ] ],
			},
		},
		[],
		[]
	);
	const log = section.tree.find( ( e ) => e.kind === 'log' );
	expect( log.name ).toBe( 'missing' );
	expect( log.partitions ).toEqual( [
		{ partition: 0, name: 'missing.p<partition>' },
	] );
} );

it( 'a token-free vertex matches its exact catalog twin only', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'digest', 'logic' ),
					gn( 'lg', 'log', { writes: 'digest.md' } ),
				],
				edges: [ [ 'digest', 'lg' ] ],
			},
		},
		[],
		[
			{
				name: 'digest.md',
				segment_size: 100,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'digest.markdown',
				segment_size: 100,
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
		]
	);
	const log = section.tree[ 0 ].children.find( ( e ) => e.kind === 'log' );
	expect( log.name ).toBe( 'digest.md' );
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
	expect( inLog.key ).toBe( 't>in.log' );
	expect( inLog.segment_size ).toBe( 4096 );
	expect( inLog.partitions ).toHaveLength( 1 );
} );

it( 'merges cursor data from consuming workers onto canonical log slots', () => {
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
		[
			w( {
				type: 't',
				handler: 'r',
				partition: 0,
				inputs: [ 'in.log' ],
				inputs_status: [
					{
						name: 'in.log',
						cursor_segment: 2,
						cursor_offset: 128,
					},
				],
			} ),
		],
		[
			{
				name: 'in.log',
				segment_size: 4096,
				partitions: [
					{ partition: 0, segments: [ { id: 2 } ], total_size: 512 },
				],
			},
		]
	);
	const log = section.tree[ 0 ];
	expect( log.hasCursor ).toBe( true );
	expect( log.partitions[ 0 ] ).toEqual(
		expect.objectContaining( {
			partition: 0,
			cursor_segment: 2,
			cursor_offset: 128,
			name: 'in.log',
		} )
	);
} );

it( 'falls back to consuming worker input status when the log catalog is absent', () => {
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
		[
			w( {
				type: 't',
				handler: 'r',
				partition: 3,
				inputs: [ 'in.log' ],
				inputs_status: [
					{
						name: 'in.log',
						segments: [ { id: 7 } ],
						total_size: 700,
						cursor_segment: 7,
						cursor_offset: 10,
					},
				],
			} ),
		],
		[]
	);
	const log = section.tree[ 0 ];
	expect( log.hasCursor ).toBe( true );
	expect( log.partitions[ 0 ] ).toEqual(
		expect.objectContaining( {
			partition: 0,
			segments: [ { id: 7 } ],
			total_size: 700,
			cursor_segment: 7,
			cursor_offset: 10,
			name: 'in.log',
		} )
	);
} );

it( 'falls back to producing worker output status when no catalog or cursor status exists', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'src', 'logic' ),
					gn( 'out', 'partition', { writes: 'out.log' } ),
				],
				edges: [ [ 'src', 'out' ] ],
			},
		},
		[
			w( {
				type: 't',
				handler: 'src',
				partition: 2,
				outputs: [ 'out.log' ],
				outputs_status: [
					{
						name: 'out.log',
						segments: [ { id: 4 } ],
						total_size: 400,
					},
				],
			} ),
		],
		[]
	);
	const log = section.tree[ 0 ].children[ 0 ];
	expect( log.hasCursor ).toBe( false );
	expect( log.partitions[ 0 ] ).toEqual(
		expect.objectContaining( {
			partition: 0,
			segments: [ { id: 4 } ],
			total_size: 400,
			name: 'out.log',
		} )
	);
} );

it( 'collapses a Log sink to a log entity named by its file basename', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'digest', 'logic' ),
					gn( 'lg', 'log', { writes: 'digest.md' } ),
				],
				edges: [ [ 'digest', 'lg' ] ],
			},
		},
		[],
		[]
	);
	// The logic node is the root; the Log sink renders as a nested LOG entity.
	const root = section.tree[ 0 ];
	expect( root.name ).toBe( 'digest' );
	const log = root.children.find( ( e ) => e.name === 'digest.md' );
	expect( log ).toBeDefined();
	expect( log.kind ).toBe( 'log' );
} );

it( 'overlays catalog segments onto a Log sink log entity', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'digest', 'logic' ),
					gn( 'lg', 'log', { writes: 'digest.md' } ),
				],
				edges: [ [ 'digest', 'lg' ] ],
			},
		},
		[],
		[
			{
				name: 'digest.md',
				segment_size: 100,
				partitions: [
					{
						partition: 0,
						segments: [ { id: 0, size: 42, mtime: 5 } ],
						total_size: 42,
					},
				],
			},
		]
	);
	const log = section.tree[ 0 ].children.find(
		( e ) => e.name === 'digest.md'
	);
	expect( log.kind ).toBe( 'log' );
	expect( log.segment_size ).toBe( 100 );
	expect( log.partitions ).toHaveLength( 1 );
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
	expect( rb.key ).toBe( 't>in.log>request-builder' );
	expect( rb.workers ).toHaveLength( 1 );
	expect( rb.workers[ 0 ].behind ).toBe( 5 );
} );

it( 'shows only the worker for the input branch that reaches a repeated handler', () => {
	const [ section ] = buildTopologySections(
		{
			combined: {
				nodes: [
					gn( 'firehose-reader', 'consumer', {
						reads: 'firehose.p<partition>',
					} ),
					gn( 'jobintake-reader', 'consumer', {
						reads: 'jobintake.p<partition>',
					} ),
					gn( 'job-router', 'logic' ),
				],
				edges: [
					[ 'firehose-reader', 'job-router' ],
					[ 'jobintake-reader', 'job-router' ],
				],
			},
		},
		[
			w( {
				type: 'combined',
				handler: 'job-router',
				source: 'firehose.p0',
				partition: 0,
				behind: 731,
			} ),
			w( {
				type: 'combined',
				handler: 'job-router',
				source: 'jobintake.p0',
				partition: 0,
				behind: 863,
			} ),
		],
		[
			{
				name: 'firehose.p0',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
			{
				name: 'jobintake.p0',
				partitions: [ { partition: 0, segments: [], total_size: 0 } ],
			},
		]
	);

	const firehose = section.tree.find(
		( entity ) => entity.name === 'firehose'
	);
	const jobintake = section.tree.find(
		( entity ) => entity.name === 'jobintake'
	);
	const firehoseRouter = firehose.children.find(
		( entity ) => entity.name === 'job-router'
	);
	const jobintakeRouter = jobintake.children.find(
		( entity ) => entity.name === 'job-router'
	);

	expect( firehoseRouter.workers ).toHaveLength( 1 );
	expect( firehoseRouter.workers[ 0 ].source ).toBe( 'firehose.p0' );
	expect( firehoseRouter.workers[ 0 ].behind ).toBe( 731 );
	expect( jobintakeRouter.workers ).toHaveLength( 1 );
	expect( jobintakeRouter.workers[ 0 ].source ).toBe( 'jobintake.p0' );
	expect( jobintakeRouter.workers[ 0 ].behind ).toBe( 863 );
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

it( 'joins convergent sibling logic roots onto one node, subtree built once', () => {
	const [ section ] = buildTopologySections(
		{
			digest: {
				nodes: [
					gn( 'community', 'logic' ),
					gn( 'releases', 'logic' ),
					gn( 'summarizer', 'logic' ),
					gn( 'scorer', 'logic' ),
				],
				edges: [
					[ 'community', 'summarizer' ],
					[ 'releases', 'summarizer' ],
					[ 'summarizer', 'scorer' ],
				],
			},
		},
		[],
		[]
	);
	expect( section.tree ).toHaveLength( 1 );
	const root = section.tree[ 0 ];
	expect( root.kind ).toBe( 'node' );
	expect( root.names ).toEqual( [ 'community', 'releases' ] );
	expect( root.key ).toBe( 'digest>community+releases' );
	expect( names( root.children ) ).toEqual( [ 'summarizer' ] );
	const summarizer = root.children[ 0 ];
	expect( names( summarizer.children ) ).toEqual( [ 'scorer' ] );
} );

it( 'does not join siblings whose downstream sets differ', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'a', 'logic' ),
					gn( 'b', 'logic' ),
					gn( 'x', 'logic' ),
					gn( 'y', 'logic' ),
				],
				edges: [
					[ 'a', 'x' ],
					[ 'b', 'y' ],
				],
			},
		},
		[],
		[]
	);
	expect( names( section.tree ) ).toEqual( [ 'a', 'b' ] );
	expect( section.tree.every( ( e ) => e.names === undefined ) ).toBe( true );
} );

it( 'joins sibling logic roots that converge on a shared log (one entity, log once)', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'wa', 'partition', { writes: 'shared.log' } ),
					gn( 'wb', 'partition', { writes: 'shared.log' } ),
					gn( 'srcA', 'logic' ),
					gn( 'srcB', 'logic' ),
				],
				edges: [
					[ 'srcA', 'wa' ],
					[ 'srcB', 'wb' ],
				],
			},
		},
		[],
		[]
	);
	// Sibling roots writing one log collapse to one entity, log rendered once.
	expect( names( section.tree ) ).toEqual( [ 'srcA, srcB' ] );
	const joined = section.tree[ 0 ];
	expect( names( joined.children ) ).toEqual( [ 'shared.log' ] );
} );

it( 'joins nested convergence inside a joined group too', () => {
	const [ section ] = buildTopologySections(
		{
			t: {
				nodes: [
					gn( 'root1', 'logic' ),
					gn( 'root2', 'logic' ),
					gn( 'mid1', 'logic' ),
					gn( 'mid2', 'logic' ),
					gn( 'leaf', 'logic' ),
				],
				edges: [
					[ 'root1', 'mid1' ],
					[ 'root1', 'mid2' ],
					[ 'root2', 'mid1' ],
					[ 'root2', 'mid2' ],
					[ 'mid1', 'leaf' ],
					[ 'mid2', 'leaf' ],
				],
			},
		},
		[],
		[]
	);
	expect( section.tree ).toHaveLength( 1 );
	const root = section.tree[ 0 ];
	expect( root.names ).toEqual( [ 'root1', 'root2' ] );
	expect( root.children ).toHaveLength( 1 );
	const mid = root.children[ 0 ];
	expect( mid.names ).toEqual( [ 'mid1', 'mid2' ] );
	expect( names( mid.children ) ).toEqual( [ 'leaf' ] );
} );

describe( 'collectLogPartitions — per-topology cursor + recorded end merge', () => {
	// One topology's cursor + end merge onto the canonical catalog slot.
	const READER_GRAPH = {
		t: {
			nodes: [
				gn( 'in', 'consumer', { reads: 'firehose.log' } ),
				gn( 'proc', 'logic' ),
			],
			edges: [ [ 'in', 'proc' ] ],
		},
	};
	const CATALOG = [
		{
			name: 'firehose.log',
			partitions: [
				{
					partition: 0,
					segments: [ { id: 0, size: 100 } ],
					total_size: 100,
				},
			],
		},
	];

	it( 'merges cursor + end_segment/end_size from this topology consumer into the canonical slot', () => {
		const workers = [
			w( {
				type: 't',
				handler: 'proc',
				source: 'firehose.log',
				inputs: [ 'firehose.log' ],
				inputs_status: [
					{
						name: 'firehose.log',
						partition: 0,
						segments: [ { id: 0, size: 100 } ],
						total_size: 100,
						cursor_segment: 0,
						cursor_offset: 40,
						end_segment: 0,
						end_size: 80,
					},
				],
			} ),
		];
		const [ section ] = buildTopologySections(
			READER_GRAPH,
			workers,
			CATALOG
		);
		const firehose = section.tree.find(
			( e ) => 'log' === e.kind && 'firehose.log' === e.name
		);
		const part = firehose.partitions[ 0 ];
		expect( part.cursor_segment ).toBe( 0 );
		expect( part.cursor_offset ).toBe( 40 );
		expect( part.end_segment ).toBe( 0 );
		expect( part.end_size ).toBe( 80 );
	} );

	it( 'a topology with NO consumer of the log gets a slot with segments but no cursor/end', () => {
		// agg WRITES firehose.log but never reads it: all-gray bar.
		const NO_CONSUMER_GRAPH = {
			agg: {
				nodes: [
					gn( 'src', 'logic' ),
					gn( 'fh', 'partition', { writes: 'firehose.log' } ),
				],
				edges: [ [ 'src', 'fh' ] ],
			},
		};
		const workers = [
			w( {
				type: 'agg',
				handler: 'src',
				source: '',
				outputs: [ 'firehose.log' ],
				outputs_status: [],
			} ),
		];
		const [ section ] = buildTopologySections(
			NO_CONSUMER_GRAPH,
			workers,
			CATALOG
		);
		const firehose = findEntity(
			section.tree,
			( e ) => 'log' === e.kind && 'firehose.log' === e.name
		);
		const part = firehose.partitions[ 0 ];
		expect( part.segments.map( ( s ) => s.id ) ).toEqual( [ 0 ] );
		expect( part.cursor_segment ).toBeUndefined();
		expect( part.end_segment ).toBeUndefined();
		expect( firehose.hasCursor ).toBe( false );
	} );

	it( 'two topologies reading the same log do NOT share each other cursor/end (no lockstep)', () => {
		const TWO_READERS_GRAPH = {
			rb: {
				nodes: [
					gn( 'in', 'consumer', { reads: 'firehose.log' } ),
					gn( 'request-builder', 'logic' ),
				],
				edges: [ [ 'in', 'request-builder' ] ],
			},
			jr: {
				nodes: [
					gn( 'in', 'consumer', { reads: 'firehose.log' } ),
					gn( 'job-router', 'logic' ),
				],
				edges: [ [ 'in', 'job-router' ] ],
			},
		};
		const reader = ( type, handler, cursorOffset, endSize ) =>
			w( {
				type,
				handler,
				source: 'firehose.log',
				inputs: [ 'firehose.log' ],
				inputs_status: [
					{
						name: 'firehose.log',
						partition: 0,
						segments: [ { id: 0, size: 100 } ],
						total_size: 100,
						cursor_segment: 0,
						cursor_offset: cursorOffset,
						end_segment: 0,
						end_size: endSize,
					},
				],
			} );
		const sections = buildTopologySections(
			TWO_READERS_GRAPH,
			[
				reader( 'rb', 'request-builder', 40, 80 ),
				reader( 'jr', 'job-router', 10, 50 ),
			],
			CATALOG
		);
		const slotIn = ( topo ) => {
			const section = sections.find( ( s ) => s.topology === topo );
			const firehose = section.tree.find(
				( e ) => 'log' === e.kind && 'firehose.log' === e.name
			);
			return firehose.partitions[ 0 ];
		};
		// Each tree shows ITS OWN consumer's cursor/end — not the other's.
		expect( slotIn( 'rb' ).cursor_offset ).toBe( 40 );
		expect( slotIn( 'rb' ).end_size ).toBe( 80 );
		expect( slotIn( 'jr' ).cursor_offset ).toBe( 10 );
		expect( slotIn( 'jr' ).end_size ).toBe( 50 );
	} );
} );

// `topic-probe.tsl` is included by seven topologies, so a `topicprobe` node
// exists in each. Overview renders every topology against ONE shared fold set,
// so a key that names only the tree path made folding it in one row fold it in
// all of them.
it( 'scopes an entity key by topology, so a shared node name cannot collide', () => {
	// `logic` is what a Topic_Probe resolves to; the key IS the persisted
	// contract, so pin both strings rather than only their difference.
	const graphTopo = { nodes: [ gn( 'topicprobe', 'logic' ) ], edges: [] };
	const sections = buildTopologySections(
		{ aggregator: graphTopo, 'job-router': graphTopo },
		[],
		[]
	);
	const probeIn = ( topology ) =>
		findEntity(
			sections.find( ( s ) => s.topology === topology ).tree,
			( e ) => 'topicprobe' === e.name
		);

	expect( probeIn( 'aggregator' ).kind ).toBe( 'node' );
	expect( probeIn( 'aggregator' ).key ).toBe( 'aggregator>topicprobe' );
	expect( probeIn( 'job-router' ).key ).toBe( 'job-router>topicprobe' );
} );
