import { render, fireEvent } from '@testing-library/react';
import TreeEntity from '../TreeEntity';
import { buildTopologySections } from '../topologyGraph';

// Count SegmentBar renders to prove a stable subtree is NOT re-rendered.
let mockSegmentBarRenders = 0;
jest.mock( '../SegmentBar', () => ( {
	SegmentBar: () => {
		mockSegmentBarRenders++;
		return <div className="worker-segment-h" />;
	},
} ) );

// Grouped layout: a log entity is ONE logical log carrying its partitions.
const logEntity = {
	kind: 'log',
	name: 'requests',
	key: 'log:requests',
	hasCursor: false,
	partitions: [
		{
			partition: 0,
			name: 'requests.p0',
			segments: [ { id: 0, size: 100 } ],
		},
		{
			partition: 1,
			name: 'requests.p1',
			segments: [ { id: 0, size: 100 } ],
		},
	],
	children: [
		{
			kind: 'node',
			name: 'flame-builder',
			key: 't|flame-builder|requests',
			workers: [
				{
					partition: 0,
					status: 'running',
					behind: 0,
					source: 'requests',
					handler: 'flame-builder',
				},
			],
			children: [],
		},
	],
};
const props = {
	byteRates: {},
	writeRates: {},
	segmentSize: 1024,
	currentTime: 2000,
	prevSegments: {},
	removingSegments: {},
	collapsed: new Set(),
	onToggle: () => {},
};

it( 'renders a log group label, one P{n} row per partition, and a fold caret', () => {
	const leaf = { ...logEntity, children: [] };
	const { container } = render(
		<TreeEntity entity={ leaf } depth={ 0 } { ...props } />
	);
	// Every log renders its group-label header.
	expect( container.querySelector( '.log-name' ).textContent ).toBe(
		'requests'
	);
	// Two partition sub-rows, each labelled P{partition}.
	expect( container.querySelectorAll( '.log-partition-row' ) ).toHaveLength(
		2
	);
	const labels = [
		...container.querySelectorAll( '.partition-label-inline' ),
	].map( ( el ) => el.textContent );
	expect( labels ).toEqual( [ 'P0', 'P1' ] );
	// Every log is foldable.
	expect( container.querySelector( '.caret' ) ).not.toBeNull();
} );

it( 'a source log that feeds a subtree keeps its group label and renders the subtree once', () => {
	const { container } = render(
		<TreeEntity entity={ logEntity } depth={ 0 } { ...props } />
	);
	expect( container.querySelector( '.log-name' ).textContent ).toBe(
		'requests'
	);
	expect( container.querySelectorAll( '.log-partition-row' ) ).toHaveLength(
		2
	);
	// The downstream reader node renders exactly once (no per-partition dup).
	const labels = [
		...container.querySelectorAll( '.partition-label-inline' ),
	].map( ( el ) => el.textContent );
	expect( labels ).toEqual( [ 'P0', 'P1' ] );
	expect( container.querySelectorAll( '.connector-name' ) ).toHaveLength( 1 );
	expect( container.textContent ).toMatch( /flame-builder/ );
} );

it( 'keys each partition write/read rate on the CONCRETE partition name', () => {
	// Rate key MUST match workerStatusTransform's recordLog key byte-for-byte.
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			writeRates={ { 'requests.p1': 2048 } }
		/>
	);
	const rates = [ ...container.querySelectorAll( '.log-write-rate' ) ].map(
		( el ) => el.textContent
	);
	// P0 has no rate (0 B/s); P1 keyed `requests.p1` shows 2 KB/s.
	expect( rates[ 1 ] ).toMatch( /2/ );
} );

it( 'a consumed (hasCursor) log still shows its WRITE rate, labeled W', () => {
	// A consumed log must still surface how fast it is WRITTEN, labeled W.
	const consumed = {
		...logEntity,
		hasCursor: true,
		partitions: [
			{
				partition: 0,
				name: 'firehose.p0',
				segments: [ { id: 0, size: 100 } ],
				cursor_segment: 0,
				cursor_offset: 50,
			},
		],
		children: [],
	};
	const { container } = render(
		<TreeEntity
			entity={ consumed }
			depth={ 0 }
			{ ...props }
			writeRates={ { 'firehose.p0': 35000 } }
		/>
	);
	const rate = container.querySelector( '.log-write-rate' ).textContent;
	expect( rate ).toMatch( /W/ );
	expect( rate ).not.toMatch( /R/ );
	expect( rate ).toMatch( /34/ ); // 35000 B/s ≈ 34.2 KB/s
} );

it( 'shows behind on a node row when behind > 0', () => {
	const e = {
		...logEntity,
		children: [
			{
				...logEntity.children[ 0 ],
				workers: [
					{
						partition: 0,
						status: 'running',
						behind: 2 * 1024 * 1024,
						source: 'requests',
						handler: 'flame-builder',
					},
				],
			},
		],
	};
	const { container } = render(
		<TreeEntity
			entity={ e }
			depth={ 0 }
			{ ...props }
			byteRates={ { 'flame-builder-0-requests': 0 } }
		/>
	);
	expect( container.querySelector( '.connector-behind' ) ).not.toBeNull();
} );

it( 'fold caret toggles via onToggle with the entity key', () => {
	const onToggle = jest.fn();
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			onToggle={ onToggle }
		/>
	);
	fireEvent.click( container.querySelector( '.caret' ) );
	expect( onToggle ).toHaveBeenCalledWith( 'log:requests' );
} );

it( 'fold caret toggles from the keyboard with Enter and Space', () => {
	const onToggle = jest.fn();
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			onToggle={ onToggle }
		/>
	);
	const caret = container.querySelector( '.caret' );
	fireEvent.keyDown( caret, { key: 'Enter' } );
	fireEvent.keyDown( caret, { key: ' ' } );
	expect( onToggle.mock.calls ).toEqual( [
		[ 'log:requests' ],
		[ 'log:requests' ],
	] );
} );

it( 'collapsed entity hides its detail rows and children', () => {
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			collapsed={ new Set( [ 'log:requests' ] ) }
		/>
	);
	expect( container.querySelector( '.worker-segment-h' ) ).toBeNull();
	expect( container.textContent ).not.toMatch(
		/flame-builder|Flame Builder/
	);
} );

it( 'renders a joined node entity as its raw member names, comma-joined (no Title-Case)', () => {
	const joined = {
		kind: 'node',
		names: [ 'community', 'releases' ],
		name: 'community, releases',
		key: 'group:community|releases',
		workers: [],
		children: [],
	};
	const { container } = render(
		<TreeEntity entity={ joined } depth={ 0 } { ...props } />
	);
	expect( container.querySelector( '.connector-name' ).textContent ).toBe(
		'community, releases'
	);
} );

it( 'renders a node name raw (1:1 with the console, no Title-Case)', () => {
	const nodeEntity = {
		kind: 'node',
		name: 'job-router',
		key: 't|job-router|',
		children: [],
		workers: [],
	};
	const { container } = render(
		<TreeEntity entity={ nodeEntity } depth={ 0 } { ...props } />
	);
	expect( container.querySelector( '.connector-name' ).textContent ).toBe(
		'job-router'
	);
} );

it( 'a node row shows a status-colored partition pill and R rate', () => {
	const nodeEntity = {
		kind: 'node',
		name: 'job-router',
		key: 't|job-router|',
		children: [],
		workers: [
			{
				partition: 0,
				status: 'running',
				behind: 0,
				source: '',
				handler: 'job-router',
			},
		],
	};
	const { container } = render(
		<TreeEntity entity={ nodeEntity } depth={ 0 } { ...props } />
	);
	expect(
		container.querySelector( '.worker-status-badge.compact.running' )
	).not.toBeNull();
	expect( container.querySelector( '.connector-rate' ).textContent ).toMatch(
		/R /
	);
} );

it( 'renders each repeated handler branch with only its own source rate', () => {
	const [ section ] = buildTopologySections(
		{
			combined: {
				nodes: [
					{
						name: 'firehose-reader',
						kind: 'consumer',
						reads: 'firehose.p<partition>',
					},
					{
						name: 'jobintake-reader',
						kind: 'consumer',
						reads: 'jobintake.p<partition>',
					},
					{ name: 'job-router', kind: 'logic' },
				],
				edges: [
					[ 'firehose-reader', 'job-router' ],
					[ 'jobintake-reader', 'job-router' ],
				],
			},
		},
		[
			{
				type: 'combined',
				handler: 'job-router',
				source: 'firehose.p0',
				partition: 0,
				status: 'running',
				behind: 0,
			},
			{
				type: 'combined',
				handler: 'job-router',
				source: 'jobintake.p0',
				partition: 0,
				status: 'running',
				behind: 0,
			},
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
	const { container } = render(
		<div>
			{ section.tree.map( ( entity ) => (
				<TreeEntity
					key={ entity.key }
					entity={ entity }
					depth={ 0 }
					{ ...props }
					byteRates={ {
						'job-router-0-firehose.p0': 357,
						'job-router-0-jobintake.p0': 941,
					} }
				/>
			) ) }
		</div>
	);

	const pills = container.querySelectorAll( '.worker-status-badge' );
	const rates = [ ...container.querySelectorAll( '.connector-rate' ) ].map(
		( node ) => node.textContent
	);

	expect( pills ).toHaveLength( 2 );
	expect( rates ).toEqual( [ 'R 357 B/s', 'R 941 B/s' ] );
} );

it( 'folds only the instance whose position key is collapsed, not its twin', () => {
	// Position-based keys make the two same-log instances DISTINCT.
	const logUnder = ( key ) => ( {
		kind: 'log',
		name: 'x.log',
		key,
		hasCursor: false,
		partitions: [
			{
				partition: 0,
				name: 'x.log.p0',
				segments: [ { id: 0, size: 100 } ],
			},
		],
		children: [],
	} );
	const tree = {
		kind: 'node',
		name: 'p',
		key: 'p',
		workers: [],
		children: [
			{
				kind: 'node',
				name: 'a',
				key: 'p>a',
				workers: [],
				children: [ logUnder( 'p>a>x.log' ) ],
			},
			{
				kind: 'node',
				name: 'b',
				key: 'p>b',
				workers: [],
				children: [ logUnder( 'p>b>x.log' ) ],
			},
		],
	};
	const base = {
		byteRates: {},
		writeRates: {},
		segmentSize: 1024,
		currentTime: 0,
		prevSegments: {},
		removingSegments: {},
		onToggle: () => {},
	};
	const open = render(
		<TreeEntity
			entity={ tree }
			depth={ 0 }
			{ ...base }
			collapsed={ new Set() }
		/>
	);
	// Both x.log instances show their segment bar when expanded.
	expect(
		open.container.querySelectorAll( '.worker-segment-h' )
	).toHaveLength( 2 );
	const folded = render(
		<TreeEntity
			entity={ tree }
			depth={ 0 }
			{ ...base }
			collapsed={ new Set( [ 'p>a>x.log' ] ) }
		/>
	);
	// Collapsing only 'a' leaves exactly one segment bar (the 'b' twin).
	expect(
		folded.container.querySelectorAll( '.worker-segment-h' )
	).toHaveLength( 1 );
} );

it( 'a stable subtree does not re-render when an unrelated sibling prop identity changes', () => {
	// Each poll mints fresh identities; stable subtrees must NOT re-render.
	const stable = {
		byteRates: {},
		writeRates: {},
		segmentSize: 1024,
		prevSegments: {},
		removingSegments: {},
		collapsed: new Set(),
		onToggle: () => {},
	};
	const { rerender } = render(
		<TreeEntity entity={ logEntity } depth={ 0 } { ...stable } />
	);
	const afterFirst = mockSegmentBarRenders;
	// A fresh unrelated currentTime must NOT re-render this subtree.
	rerender(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...stable }
			currentTime={ Date.now() }
		/>
	);
	expect( mockSegmentBarRenders ).toBe( afterFirst );
} );
