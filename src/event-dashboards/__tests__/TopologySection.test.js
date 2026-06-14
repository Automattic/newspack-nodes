import { render, fireEvent } from '@testing-library/react';
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
				{ partition: 0, segments: [], cursor_seg: 0, cursor_offset: 0 },
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
	onRestart: jest.fn(),
};

it( 'header shows per-partition pills with uptime + heartbeat', () => {
	const { container } = render( <TopologySection { ...props } /> );
	expect( container.querySelector( '.topology-header' ).textContent ).toMatch(
		/combined/
	);
	expect(
		container.querySelectorAll(
			'.topology-header .worker-status-badge.compact'
		).length
	).toBe( 2 );
	expect( container.querySelector( '.topology-header' ).textContent ).toMatch(
		/6m/
	);
	expect(
		container.querySelector( '.connector-heartbeat.stale' )
	).not.toBeNull();
} );

it( 'shows ALL RUN and a fleet restart that calls onRestart(topology)', () => {
	const { container } = render( <TopologySection { ...props } /> );
	expect( container.textContent ).toMatch( /ALL RUN/ );
	fireEvent.click(
		container.querySelector( '.topology-header .worker-restart-btn' )
	);
	expect( props.onRestart ).toHaveBeenCalledWith( 'combined' );
} );

it( 'renders the section tree', () => {
	const { container } = render( <TopologySection { ...props } /> );
	expect( container.querySelector( '.topology-section' ) ).not.toBeNull();
	expect( container.textContent ).toMatch( /firehose\.log/ );
} );
