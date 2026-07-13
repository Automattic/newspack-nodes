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
		includeTree: {
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

	it( 'offers to OPEN the included topology — the drill-in', () => {
		const onOpenTopology = jest.fn();
		render( <Inspector { ...props } onOpenTopology={ onOpenTopology } /> );
		fireEvent.click( screen.getByTestId( 'hull-open' ) );
		expect( onOpenTopology ).toHaveBeenCalledWith( 'performance' );
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
