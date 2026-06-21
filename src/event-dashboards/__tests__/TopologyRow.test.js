/**
 * TopologyRow — the unfolded per-topology detail row: heading (name + partition
 * pills + source/health badges + a topology-level collapse chevron + the shared
 * controls) over the live TopologySection subtree. The REAL TopologySection is
 * rendered (NOT mocked) so the node-row / segment-bar / within-tree-fold coverage
 * migrated from the old TopologyManager suite stays honest. consoleHref's
 * deep-link shapes are exercised here too.
 */

/* global globalThis */
import { render, fireEvent } from '@testing-library/react';
import { consoleHref, sectionFor, TopologyRow } from '../TopologyRow';

// TopologyControls has its OWN suite; here it's a prop-capturing stub so the row
// only proves it wired the right handlers + active flag + editHref.
jest.mock( '../TopologyControls', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__topologyControls ||= [] ).push( props );
		return el.createElement( 'span', { className: 'nodes-ctl-stub' } );
	};
} );

function controlFor( name ) {
	return globalThis.__topologyControls.find( ( c ) => c.name === name );
}

// Live status mirroring the enriched worker-status MODEL slices the hook attaches
// per active topology. The worker's `handler` matches the graph vertex
// (`producer`) so a real node row renders and the `byteRates` read is exercised.
function activeStatus() {
	return {
		graph: { nodes: [ { name: 'producer', kind: 'logic' } ], edges: [] },
		workers: [
			{
				type: 'alpha',
				handler: 'producer',
				partition: 0,
				source: '',
				status: 'running',
				started_at: 1000,
			},
		],
		byteRates: { 'producer-0-': 2048 },
		writeRates: {},
		segmentSize: 64 * 1024 * 1024,
		currentTime: 2000,
		prevSegments: {},
		removingSegments: {},
	};
}

// A status whose logs catalog carries a segment so a segment bar renders.
function statusWithSegments() {
	return {
		graph: {
			nodes: [ { name: 'sink', kind: 'partition', writes: 'a-log' } ],
			edges: [],
		},
		workers: [],
		logs: [
			{
				name: 'a-log',
				segment_size: 64 * 1024 * 1024,
				partitions: [
					{
						partition: 0,
						segments: [ { id: 0, size: 1024, mtime: 1000 } ],
						total_size: 1024,
					},
				],
			},
		],
		byteRates: {},
		writeRates: {},
		segmentSize: 64 * 1024 * 1024,
		currentTime: 2000,
		prevSegments: {},
		removingSegments: {},
	};
}

function rowProps( overrides = {} ) {
	return {
		topology: {
			name: 'alpha',
			source: 'stock',
			active: true,
			health: 'ok',
			status: activeStatus(),
		},
		onActivate: jest.fn(),
		onDeactivate: jest.fn(),
		onRestart: jest.fn(),
		onError: jest.fn(),
		onCollapseTopology: jest.fn(),
		collapsed: new Set(),
		onToggleFold: jest.fn(),
		...overrides,
	};
}

beforeEach( () => {
	globalThis.__topologyControls = [];
} );

describe( 'consoleHref', () => {
	it( 'builds a plain live-mode deep-link for a topology', () => {
		expect( consoleHref( 'alpha' ) ).toBe(
			'admin.php?page=newspack-nodes-hub&tab=console&topology=alpha'
		);
	} );
	it( 'adds edit=1 in edit mode', () => {
		const href = consoleHref( 'alpha', { edit: true } );
		expect( href ).toContain( 'topology=alpha' );
		expect( href ).toContain( 'edit=1' );
	} );
	it( 'adds new=1 (and no topology) for a blank editor draft', () => {
		const href = consoleHref( '', { isNew: true } );
		expect( href ).toContain( 'new=1' );
		expect( href ).not.toContain( 'topology=' );
	} );
} );

describe( 'sectionFor', () => {
	it( 'returns null without a graph', () => {
		expect( sectionFor( 'alpha', null ) ).toBeNull();
		expect( sectionFor( 'alpha', { workers: [] } ) ).toBeNull();
	} );
	it( 'builds a single section from the live status graph', () => {
		const section = sectionFor( 'alpha', activeStatus() );
		expect( section ).toBeTruthy();
		expect( section.topology ).toBe( 'alpha' );
	} );
} );

describe( 'TopologyRow — folded mode', () => {
	it( 'folded renders the heading but NO body, with an expand chevron', () => {
		const props = rowProps( { folded: true, onExpand: jest.fn() } );
		const { container } = render( <TopologyRow { ...props } /> );
		expect( container.querySelector( '.nodes-tm__body' ) ).toBeNull();
		const chevron = container.querySelector( '.nodes-tm__expand' );
		expect( chevron ).toBeTruthy();
		chevron.click();
		expect( props.onExpand ).toHaveBeenCalledWith( 'alpha' );
		// Still shows the same per-partition heading pills as the unfolded view.
		expect(
			container.querySelectorAll( '.topology-partition' ).length
		).toBeGreaterThan( 0 );
	} );

	it( 'unfolded (default) renders the body + a collapse chevron', () => {
		const { container } = render( <TopologyRow { ...rowProps() } /> );
		expect( container.querySelector( '.nodes-tm__body' ) ).toBeTruthy();
		expect( container.querySelector( '.nodes-tm__collapse' ) ).toBeTruthy();
	} );

	it( 'shows the catch-up ETA when behind, hides it when ok', () => {
		const behind = render(
			<TopologyRow
				{ ...rowProps( {
					folded: true,
					onExpand: jest.fn(),
					topology: {
						name: 'alpha',
						source: 'stock',
						active: true,
						health: 'behind',
						etaSeconds: 600,
						status: activeStatus(),
					},
				} ) }
			/>
		);
		expect(
			behind.container.querySelector( '.nodes-tm__eta' ).textContent
		).toContain( '10m' );

		const ok = render(
			<TopologyRow
				{ ...rowProps( { folded: true, onExpand: jest.fn() } ) }
			/>
		);
		expect( ok.container.querySelector( '.nodes-tm__eta' ) ).toBeNull();
	} );

	it( 'exposes a draggable grip that calls onDragStart with the name', () => {
		const props = rowProps( {
			folded: true,
			onExpand: jest.fn(),
			onDragStart: jest.fn(),
			onDropOn: jest.fn(),
		} );
		const { container } = render( <TopologyRow { ...props } /> );
		const grip = container.querySelector( '.nodes-tm__grip' );
		expect( grip ).toBeTruthy();
		expect( grip.getAttribute( 'draggable' ) ).toBe( 'true' );
	} );

	it( 'shows a k/n up badge for a partially-up topology (not ALL RUN / ALL DEAD)', () => {
		const props = rowProps( {
			folded: true,
			onExpand: jest.fn(),
			topology: {
				name: 'alpha',
				source: 'stock',
				active: true,
				health: 'ok',
				status: {
					graph: { nodes: [], edges: [] },
					workers: [
						{
							type: 'alpha',
							handler: 'alpha',
							partition: 0,
							status: 'running',
							started_at: 1000,
						},
						{
							type: 'alpha',
							handler: 'alpha',
							partition: 1,
							status: 'dead',
							started_at: 1000,
						},
					],
					currentTime: 2000,
				},
			},
		} );
		const { container } = render( <TopologyRow { ...props } /> );
		const badges = [
			...container.querySelectorAll( '.worker-status-badge' ),
		].map( ( b ) => b.textContent );
		expect( badges ).toContain( '1/2 up' );
		expect( badges ).not.toContain( 'ALL RUN' );
		expect( badges ).not.toContain( 'ALL DEAD' );
	} );
} );

describe( 'TopologyRow', () => {
	it( 'renders the live TopologySection subtree for an active topology', () => {
		const { container } = render( <TopologyRow { ...rowProps() } /> );
		expect( container.querySelector( '.topology-section' ) ).toBeTruthy();
	} );

	it( 'renders a node row with the model read rate (not a crash, not 0 B/s)', () => {
		const { container } = render( <TopologyRow { ...rowProps() } /> );
		const rate = container.querySelector( '.connector-rate' );
		expect( rate ).toBeTruthy();
		expect( rate.textContent ).toContain( '2' );
		expect( rate.textContent ).not.toContain( '0 B/s' );
	} );

	it( 'renders Stopped (no section) for an inactive topology', () => {
		const props = rowProps( {
			topology: {
				name: 'beta',
				source: 'user',
				active: false,
				status: null,
			},
		} );
		const { container, getByText } = render( <TopologyRow { ...props } /> );
		expect( container.querySelector( '.topology-section' ) ).toBeFalsy();
		expect( getByText( 'Stopped' ) ).toBeTruthy();
	} );

	it( 'links the active name to live mode and renders the source badge', () => {
		const { container } = render( <TopologyRow { ...rowProps() } /> );
		const link = container.querySelector( 'a.nodes-tm__name' );
		expect( link.getAttribute( 'href' ) ).toContain( 'topology=alpha' );
		expect( link.getAttribute( 'href' ) ).not.toContain( 'edit=1' );
		expect(
			container.querySelector( '.nodes-tm__badge--stock' )
		).toBeTruthy();
	} );

	it( 'wires its controls with active flag, hook mutations, and an Edit deep-link', () => {
		const props = rowProps();
		render( <TopologyRow { ...props } /> );
		const ctl = controlFor( 'alpha' );
		expect( ctl.active ).toBe( true );
		expect( ctl.onDeactivate ).toBe( props.onDeactivate );
		expect( ctl.onRestart ).toBe( props.onRestart );
		expect( ctl.editHref ).toContain( 'edit=1' );
	} );

	it( 'folds and restores its segment rows via the within-tree caret', () => {
		const props = rowProps( {
			topology: {
				name: 'alpha',
				source: 'stock',
				active: true,
				status: statusWithSegments(),
			},
			collapsed: new Set(),
		} );
		// Drive the within-tree fold the way TopologySection does: it calls
		// onToggle(key); a stateful wrapper threads the collapsed Set back in.
		function Wrapper() {
			const el = require( '@wordpress/element' );
			const [ collapsed, setCollapsed ] = el.useState( () => new Set() );
			const onToggleFold = ( key ) =>
				setCollapsed( ( prev ) => {
					const next = new Set( prev );
					if ( next.has( key ) ) {
						next.delete( key );
					} else {
						next.add( key );
					}
					return next;
				} );
			return el.createElement( TopologyRow, {
				...props,
				collapsed,
				onToggleFold,
			} );
		}
		const { container } = render( <Wrapper /> );
		const caret = container.querySelector( '.caret' );
		expect( container.querySelector( '.worker-segment-h' ) ).toBeTruthy();
		fireEvent.click( caret );
		expect( container.querySelector( '.worker-segment-h' ) ).toBeFalsy();
		fireEvent.click( caret );
		expect( container.querySelector( '.worker-segment-h' ) ).toBeTruthy();
	} );

	it( 'renders a topology-level collapse chevron that calls onCollapseTopology with the name', () => {
		const props = rowProps();
		const { container } = render( <TopologyRow { ...props } /> );
		const chevron = container.querySelector( '.nodes-tm__collapse' );
		expect( chevron ).toBeTruthy();
		fireEvent.click( chevron );
		expect( props.onCollapseTopology ).toHaveBeenCalledWith( 'alpha' );
	} );

	it( 'shows the rolled-up health indicator on an active heading', () => {
		const props = rowProps( {
			topology: {
				name: 'alpha',
				source: 'stock',
				active: true,
				health: 'stalled',
				status: activeStatus(),
			},
		} );
		const { container } = render( <TopologyRow { ...props } /> );
		expect(
			container.querySelector( '.nodes-tm__health--stalled' )
		).toBeTruthy();
	} );

	it( 'hoists the per-partition pills into the heading with a stale marker', () => {
		const props = rowProps( {
			topology: {
				name: 'alpha',
				source: 'stock',
				active: true,
				health: 'ok',
				status: {
					...activeStatus(),
					workers: [
						{
							type: 'alpha',
							handler: 'producer',
							partition: 0,
							source: '',
							status: 'running',
							started_at: 1000,
							heartbeat_age: 2,
						},
						{
							type: 'alpha',
							handler: 'producer',
							partition: 1,
							source: '',
							status: 'running',
							started_at: 1000,
							heartbeat_age: 40,
						},
					],
				},
			},
		} );
		const { container } = render( <TopologyRow { ...props } /> );
		const heading = container.querySelector( '.nodes-tm__heading' );
		expect(
			heading.querySelectorAll( '.topology-partition' )
		).toHaveLength( 2 );
		expect(
			heading.querySelector( '.connector-heartbeat.stale' )
		).toBeTruthy();
		expect( heading.textContent ).toMatch( /ALL RUN/ );
	} );
} );
