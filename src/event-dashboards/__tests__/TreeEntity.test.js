import { render, fireEvent } from '@testing-library/react';
import TreeEntity from '../TreeEntity';

// Count SegmentBar renders so a test can prove a stable subtree is NOT
// re-rendered when an unrelated sibling's prop identity changes on a poll. The
// stub still emits `.worker-segment-h` so the structural tests keep matching.
let mockSegmentBarRenders = 0;
jest.mock( '../SegmentBar', () => ( {
	SegmentBar: () => {
		mockSegmentBarRenders++;
		return <div className="worker-segment-h" />;
	},
} ) );

// Grouped layout: a log entity is ONE logical log (`requests`) carrying its
// concrete partitions as sub-rows.
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
	// The rate key MUST stay byte-identical to workerStatusTransform's recordLog
	// key (the concrete per-partition name), so the W/R rate animations line up.
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
	// A log being read by a Consumer must still surface how fast it is WRITTEN —
	// the consumer's read rate already shows on its own node row.
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

it( 'folds only the instance whose position key is collapsed, not its twin', () => {
	// Same log appears under two different parents, but position-based keys make
	// the two instances DISTINCT (a>x.log vs b>x.log). Collapsing one instance's
	// key folds only that instance; the other keeps its segment bar.
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
	// Collapsing only the 'a' instance leaves exactly one segment bar (the 'b' twin).
	expect(
		folded.container.querySelectorAll( '.worker-segment-h' )
	).toHaveLength( 1 );
} );

it( 'a stable subtree does not re-render when an unrelated sibling prop identity changes', () => {
	// The Overview polls every 4s; the parent mints fresh byteRates/writeRates/
	// prevSegments/removingSegments object identities each poll even when a given
	// subtree's data is unchanged. TreeEntity must not propagate that churn into
	// subtrees whose relevant inputs are referentially stable.
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
	// A poll that changes nothing relevant to this subtree, but mints a fresh
	// unrelated identity (currentTime) — the subtree must NOT re-render.
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
