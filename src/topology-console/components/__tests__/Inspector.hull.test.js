/**
 * A selected hull is a COMPOSITION BOUNDARY, not a node — so the panel shows what
 * the canvas deliberately cannot: the recursion we flattened, the diamond nodes
 * only visible as an overlap, and the edges crossing the boundary (its interface).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import Inspector from '../Inspector';

describe( 'Inspector — selected hull', () => {
	const props = {
		selectedId: null,
		selectedHull: 'performance',
		editMode: true,
		parsed: {
			nodes: [
				{
					id: 'request-builder',
					class: 'Request_Builder',
					origin: [ 'performance' ],
				},
				{
					id: 'shared-tee',
					class: 'Tee',
					origin: [ 'performance', 'job-router' ],
				},
				{ id: 'own-echo', class: 'Echo' },
			],
			edges: [
				{ from: 'own-echo', to: 'request-builder' },
				{ from: 'request-builder', to: 'own-echo' },
			],
		},
		tree: {
			performance: { 'request-builder': {}, 'flame-builder': {} },
		},
		hulls: [
			{
				include: 'performance',
				nodeIds: [ 'request-builder', 'shared-tee' ],
			},
			{ include: 'job-router', nodeIds: [ 'shared-tee' ] },
		],
		catalog: [],
	};

	it( 'names the topology and lists what it provides', () => {
		render( <Inspector { ...props } /> );
		expect( screen.getByText( 'performance' ) ).toBeTruthy();
		expect( screen.getByTestId( 'hull-provides' ).textContent ).toContain(
			'request-builder'
		);
	} );

	it( 'flags a node SHARED with another include — the diamond, invisible on canvas', () => {
		render( <Inspector { ...props } /> );
		expect( screen.getByTestId( 'hull-shared' ).textContent ).toContain(
			'shared-tee'
		);
		expect( screen.getByTestId( 'hull-shared' ).textContent ).toContain(
			'job-router'
		);
	} );

	it( 'shows the boundary edges — what feeds it, and what it feeds', () => {
		render( <Inspector { ...props } /> );
		const iface = screen.getByTestId( 'hull-interface' ).textContent;
		expect( iface ).toContain( 'own-echo' );
		expect( iface ).toContain( 'request-builder' );
	} );

	it( 'does NOT duplicate the remove affordance — deletion lives in the tree', () => {
		render( <Inspector { ...props } /> );
		expect( screen.queryByTestId( 'hull-remove' ) ).toBeNull();
	} );

	it( 'lists what the topology itself includes, not its own name', () => {
		render( <Inspector { ...props } /> );
		const tree = screen.getByTestId( 'hull-includes' ).textContent;
		expect( tree ).toContain( 'request-builder' );
		expect( tree ).toContain( 'flame-builder' );
	} );

	it( 'omits the includes section entirely when it includes nothing', () => {
		render( <Inspector { ...props } tree={ { performance: {} } } /> );
		expect( screen.queryByTestId( 'hull-includes' ) ).toBeNull();
	} );

	it( 'offers to OPEN the included topology — the drill-in', () => {
		const onOpenTopology = jest.fn();
		render( <Inspector { ...props } onOpenTopology={ onOpenTopology } /> );
		fireEvent.click( screen.getByTestId( 'hull-open' ) );
		expect( onOpenTopology ).toHaveBeenCalledWith( 'performance' );
	} );
} );

describe( 'Inspector — hull stats', () => {
	// Counters distinct from every other node's, so a graph-wide (unscoped) roll-up
	// can't accidentally produce the hull's numbers.
	const props = {
		selectedId: null,
		selectedHull: 'performance',
		parsed: {
			nodes: [
				{
					id: 'request-builder',
					class: 'Request_Builder',
					count: 71,
					bytesRead: 2048,
					has_target: true,
					accepts_fill: false,
				},
				{
					id: 'shared-tee',
					class: 'Tee',
					count: 33,
					bytesWritten: 3072,
					has_target: false,
					accepts_fill: true,
				},
				{
					id: 'own-echo',
					class: 'Echo',
					count: 999,
					bytesRead: 999999,
					has_target: false,
					accepts_fill: true,
				},
			],
			edges: [],
		},
		tree: {},
		hulls: [
			{
				include: 'performance',
				nodeIds: [ 'request-builder', 'shared-tee' ],
			},
		],
		hullRateSeries: {
			in: [ 1, 5 ],
			out: [ 2, 6 ],
			read: [ 3, 7 ],
			write: [ 4, 9 ],
		},
		catalog: [],
	};

	it( 'rolls the hull members up into throughput totals', () => {
		render( <Inspector { ...props } /> );
		const stats = screen.getByTestId( 'hull-stats' ).textContent;
		expect( stats ).toContain( '71' );
		expect( stats ).toContain( '33' );
		expect( stats ).toContain( '2.0 K' );
		expect( stats ).toContain( '3.0 K' );
	} );

	it( 'counts ONLY the members — a non-member node is another scope', () => {
		render( <Inspector { ...props } /> );
		const stats = screen.getByTestId( 'hull-stats' ).textContent;
		expect( stats ).not.toContain( '999' );
	} );

	it( 'graphs the hull message and byte rates', () => {
		render( <Inspector { ...props } /> );
		const stats = screen.getByTestId( 'hull-stats' ).textContent;
		expect( stats ).toContain( '5.0 /s' );
		expect( stats ).toContain( '6.0 /s' );
		expect( stats ).toContain( '7 B/s' );
		expect( stats ).toContain( '9 B/s' );
	} );

	it( 'omits the dmesg strip — err/warn counts are process-wide, not per-hull', () => {
		render( <Inspector { ...props } /> );
		expect( screen.getByTestId( 'hull-stats' ).textContent ).not.toContain(
			'err'
		);
	} );

	it( 'shows NO stats in edit mode — a draft graph has nothing to measure', () => {
		render( <Inspector { ...props } editMode={ true } /> );
		expect( screen.queryByTestId( 'hull-stats' ) ).toBeNull();
	} );
} );

describe( 'HullPanel — shared vs contained', () => {
	it( 'does not call a nested include a SHARING peer of its own parent', () => {
		// job-router INCLUDES job-intake, so job-intake's nodes are in both hulls.
		// That's containment, not a diamond. Only a genuine second provider — a
		// sibling that independently brings the node — is worth naming.
		const props = {
			selectedId: null,
			selectedHull: 'job-intake',
			editMode: true,
			parsed: {
				nodes: [
					{
						id: 'jobs:partition',
						class: 'Partition',
						origin: [ 'job-router' ],
					},
				],
				edges: [],
			},
			tree: { 'job-router': { 'job-intake': {} } },
			hulls: [
				{
					include: 'job-router',
					nodeIds: [ 'jobs:partition', 'job-router' ],
				},
				{ include: 'job-intake', nodeIds: [ 'jobs:partition' ] },
			],
			catalog: [],
		};

		render( <Inspector { ...props } /> );

		expect( screen.queryByTestId( 'hull-shared' ) ).toBeNull();
	} );
} );
