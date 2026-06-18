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

it( 'each grouped partition carries its CONCRETE catalog name as the rate key (render === transform)', () => {
	// THE COUPLED RATE KEY: the transform (recordLog) keys on the concrete
	// worker-status name verbatim (`firehose.p0`); the render (LogRows) keys on
	// the partition's concrete `name`. makeLog must stamp that concrete name on
	// each partition so the two sides are byte-identical by construction — no
	// logical derivation anywhere in the key path.
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
	// The render-side key is the concrete name verbatim; the transform-side key
	// (recordLog) is `log.name` — the same concrete catalog string. Equal.
	expect( log.partitions.map( ( p ) => p.name ) ).toEqual( [
		'firehose.p0',
		'firehose.p1',
	] );
} );

it( 'the concrete rate key couples render and transform for a NON-.p{N} layout', () => {
	// The fragility being closed: a partition token NOT in trailing-`.p{N}`
	// position (`<partition>-req` → `0-req`/`1-req`). The render side keys on the
	// partition's concrete `name`; the transform keys on the worker-status
	// `log.name` verbatim. Both are the same concrete catalog string, so they
	// match regardless of where the partition token sits.
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
	// Render key = partition.name; transform key = the verbatim worker log.name.
	// They are the same concrete string for every partition — the coupling holds
	// even though the token is at the FRONT, not a trailing `.p{N}`.
	expect( log.partitions.map( ( p ) => p.name ) ).toEqual( [
		'0-req',
		'1-req',
	] );
} );

it( 'groups a partition-token log vertex into ONE logical entity with its partitions as sub-rows', () => {
	// graph_for emits the writes/reads basename verbatim from the .tsl path arg,
	// so a partitioned log vertex carries the literal `<partition>` token. The
	// catalog holds CONCRETE per-partition entries (firehose.p0, firehose.p1).
	// The vertex must GROUP into one LOGICAL log entity (`firehose`) carrying
	// both partitions as sub-rows — NOT one flat entity per concrete entry.
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
	// Exactly ONE logical log entity, named by the partition-token-stripped vertex.
	const logs = section.tree.filter( ( e ) => e.kind === 'log' );
	expect( names( logs ) ).toEqual( [ 'firehose' ] );
	// It carries both partitions as sub-rows.
	expect( logs[ 0 ].partitions ).toHaveLength( 2 );
	expect( logs[ 0 ].partitions[ 0 ].partition ).toBe( 0 );
	expect( logs[ 0 ].partitions[ 1 ].partition ).toBe( 1 );
} );

it( 'groups a Topic vertex carrying the curly {partition} token like an angle-token log', () => {
	// A Topic's path template uses the deferred curly `{partition}` token (distinct
	// from the shell's `<partition>`), so graph_for emits `firehose.p{partition}`
	// for the topic vertex. It must resolve to the SAME concrete catalog entries
	// (firehose.p0, firehose.p1) and group into one logical `firehose` entity —
	// exactly like the `<partition>` case — not render the literal token with no
	// segments (the aggregator-tab bug).
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
	// The topic's writes-log is a child of its producer; it must be ONE logical
	// `firehose` entity carrying both concrete partitions — not the literal token.
	const log = section.tree[ 0 ].children.find( ( e ) => e.kind === 'log' );
	expect( log.name ).toBe( 'firehose' );
	expect( log.partitions ).toHaveLength( 2 );
	expect( log.partitions[ 0 ].partition ).toBe( 0 );
	expect( log.partitions[ 1 ].partition ).toBe( 1 );
} );

it( 'renders a source log consumer subtree ONCE, not duplicated per partition', () => {
	// THE BUG (79c9dd6): a SOURCE log feeding a consumer subtree expanded into one
	// flat entity per partition, DUPLICATING the entire downstream subtree once per
	// partition. firehose.p<partition> → request-builder → completed.p<partition> /
	// requests.p<partition> must render the request-builder subtree EXACTLY ONCE.
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
	// Vertex `firehose.p<partition>` (token at END) must group its own partitions
	// only — NOT a sibling `firehose.priority.p0` that merely startsWith the pre
	// `firehose.p`. The substituted middle must be all-digits.
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
	// Token in the MIDDLE (`<partition>-req`): `0-req`/`1-req` match (digit
	// middle), but `x-req` must NOT (non-digit middle). The logical name is the
	// token-stripped vertex (`req`) and it groups both digit partitions.
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
	// `x-req` has a non-digit middle and is rejected; only the digit ones group.
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
	expect( inLog.key ).toBe( 'in.log' );
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
						cursor_seg: 2,
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
			cursor_seg: 2,
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
						cursor_seg: 7,
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
			cursor_seg: 7,
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
	// The logic node is the root; the Log sink renders as a LOG entity
	// named by its file basename, nested under it.
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
	expect( rb.key ).toBe( 'in.log>request-builder' );
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
	expect( root.key ).toBe( 'community+releases' );
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
	// srcA and srcB are SIBLINGS (both roots) writing to the same log — they collapse
	// to one joined entity with `shared.log` rendered once. (The repeat-per-writer rule
	// is only for producers in different subtrees/generations, never same-level siblings.)
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
