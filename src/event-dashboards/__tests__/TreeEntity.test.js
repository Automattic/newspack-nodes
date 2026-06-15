import { render, fireEvent } from '@testing-library/react';
import TreeEntity from '../TreeEntity';

// Flat layout: a log entity is ONE concrete per-partition dir carrying that
// partition's single slot. Its name is the concrete dir name (`requests.p0`).
const logEntity = {
	kind: 'log',
	name: 'requests.p0',
	key: 'log:requests.p0',
	hasCursor: false,
	partitions: [ { partition: 0, segments: [ { id: 0, size: 100 } ] } ],
	children: [
		{
			kind: 'node',
			name: 'flame-builder',
			key: 't|flame-builder|requests.p0',
			workers: [
				{
					partition: 0,
					status: 'running',
					behind: 0,
					source: 'requests.p0',
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

it( 'renders a log name and a reader node nested under it', () => {
	const { container } = render(
		<TreeEntity entity={ logEntity } depth={ 0 } { ...props } />
	);
	expect( container.textContent ).toMatch( /requests\.p0/ );
	expect( container.textContent ).toMatch( /flame-builder|Flame Builder/ );
} );

it( 'keys the log write/read rate on the concrete entry name (no .log strip, no partition suffix)', () => {
	// The rate key MUST stay byte-identical to workerStatusTransform's recordLog
	// key (the concrete log.name). With a flat per-partition entity that is just
	// `entity.name` — `requests.p0` — not `${name.replace(/\.log$/,'')}-${p}`.
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			writeRates={ { 'requests.p0': 2048 } }
		/>
	);
	expect( container.querySelector( '.log-write-rate' ).textContent ).toMatch(
		/2/
	);
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
						source: 'requests.p0',
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
			byteRates={ { 'flame-builder-0-requests.p0': 0 } }
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
	expect( onToggle ).toHaveBeenCalledWith( 'log:requests.p0' );
} );

it( 'collapsed entity hides its detail rows and children', () => {
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			collapsed={ new Set( [ 'log:requests.p0' ] ) }
		/>
	);
	expect( container.querySelector( '.worker-segment-h' ) ).toBeNull();
	expect( container.textContent ).not.toMatch(
		/flame-builder|Flame Builder/
	);
} );

it( 'renders a joined node entity as its member names, Title-Cased and comma-joined', () => {
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
		'Community, Releases'
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
		partitions: [ { partition: 0, segments: [ { id: 0, size: 100 } ] } ],
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
