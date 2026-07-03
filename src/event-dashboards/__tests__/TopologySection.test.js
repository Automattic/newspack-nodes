import { render } from '@testing-library/react';
import TopologySection from '../TopologySection';

const section = {
	topology: 'combined',
	tree: [
		{
			kind: 'log',
			name: 'firehose.log',
			key: 'log:firehose.log',
			hasCursor: true,
			partitions: [
				{
					partition: 0,
					name: 'firehose.log.p0',
					segments: [],
					cursor_segment: 0,
					cursor_offset: 0,
				},
			],
			children: [],
		},
	],
};
const workers = [
	{
		type: 'combined',
		handler: 'n',
		partition: 0,
		status: 'running',
		started_at: 1000,
		heartbeat_age: 2,
	},
	{
		type: 'combined',
		handler: 'n',
		partition: 1,
		status: 'running',
		started_at: 1000,
		heartbeat_age: 40,
	},
];
const props = {
	section,
	workers,
	currentTime: 1000 + 360,
	byteRates: {},
	writeRates: {},
	segmentSize: 1024,
	prevSegments: {},
	removingSegments: {},
	collapsed: new Set(),
	onToggle: () => {},
};

it( 'renders no header — the manager card heading is the sole head', () => {
	const { container } = render( <TopologySection { ...props } /> );
	expect( container.querySelector( '.topology-header' ) ).toBeNull();
	expect( container.querySelector( '.topology-name' ) ).toBeNull();
} );

it( 'renders the section tree', () => {
	const { container } = render( <TopologySection { ...props } /> );
	expect( container.querySelector( '.tree-branch' ) ).not.toBeNull();
	expect( container.textContent ).toMatch( /firehose\.log/ );
} );
