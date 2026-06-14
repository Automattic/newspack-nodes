import { render, fireEvent } from '@testing-library/react';
import TreeEntity from '../TreeEntity';

const logEntity = {
	kind: 'log',
	name: 'requests.log',
	key: 'log:requests.log',
	hasCursor: false,
	partitions: [ { partition: 0, segments: [ { id: 0, size: 100 } ] } ],
	children: [
		{
			kind: 'node',
			name: 'flame-builder',
			key: 't|flame-builder|requests.log',
			workers: [
				{
					partition: 0,
					status: 'running',
					behind: 0,
					source: 'requests.log',
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
	expect( container.textContent ).toMatch( /requests\.log/ );
	expect( container.textContent ).toMatch( /flame-builder|Flame Builder/ );
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
						source: 'requests.log',
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
			byteRates={ { 'flame-builder-0-requests.log': 0 } }
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
	expect( onToggle ).toHaveBeenCalledWith( 'log:requests.log' );
} );

it( 'collapsed entity hides its detail rows and children', () => {
	const { container } = render(
		<TreeEntity
			entity={ logEntity }
			depth={ 0 }
			{ ...props }
			collapsed={ new Set( [ 'log:requests.log' ] ) }
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

it( 'folds every instance of a log/node from one identity key', () => {
	// Same log appears under two different parents — fold state is keyed by
	// entity.key (identity), so collapsing its key collapses both instances.
	const logX = {
		kind: 'log',
		name: 'x.log',
		key: 'log:x.log',
		hasCursor: false,
		partitions: [ { partition: 0, segments: [ { id: 0, size: 100 } ] } ],
		children: [],
	};
	const tree = {
		kind: 'node',
		name: 'p',
		key: 'node:p',
		workers: [],
		children: [
			{
				kind: 'node',
				name: 'a',
				key: 'node:a',
				workers: [],
				children: [ logX ],
			},
			{
				kind: 'node',
				name: 'b',
				key: 'node:b',
				workers: [],
				children: [ logX ],
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
			collapsed={ new Set( [ 'log:x.log' ] ) }
		/>
	);
	// Collapsing the one identity key hides the bars in BOTH places.
	expect(
		folded.container.querySelectorAll( '.worker-segment-h' )
	).toHaveLength( 0 );
} );
