/**
 * The force canvas draws the console's graph, its sidecars and its sinks.
 *
 * Every rate, depth and name here differs from a default, so a value that is
 * dropped on the way to the ForceGraph reads differently from one that is kept.
 */
import { placeHulls, targetLinkId, toForceGraph } from '../forceGraphModel';
import {
	buildModel,
	circleRadius,
	detailRadius,
} from '@newspack-nodes/shared/forceGraph/model';

const CI = '_command_interpreter';

const QUIET = {
	selectedId: null,
	sidecar: null,
	hoveredId: null,
	hoveredHull: null,
	selectedHull: null,
	driftIds: null,
	editMode: false,
};

// A node of a class that differs from every default, with any other fields.
const node = ( id, rest = {} ) => ( { id, class: 'Press', ...rest } );

// A graph drawn with nothing selected, polled or hulled but what is named.
const draw = ( { state, rates = {}, hulls = [], tree = {}, ...rest } = {} ) =>
	toForceGraph( {
		graph: { nodes: [], edges: [] },
		rows: null,
		hulls,
		seats: placeHulls( hulls, tree ).seats,
		showSinks: false,
		rateOf: ( id ) => rates[ id ] ?? 0,
		...rest,
		state: { ...QUIET, ...state },
	} );

const byId = ( list ) =>
	Object.fromEntries( list.map( ( item ) => [ item.id, item ] ) );
const ids = ( list ) => list.map( ( { id } ) => id );
const wears = ( item, name ) => item.className.split( ' ' ).includes( name );

// The vat owns a feed, which owns a valve; the press stands alone.
const OWNED = {
	graph: {
		nodes: [
			node( 'press-61' ),
			node( 'vat-33', {
				class: 'Vat',
				sidecars: [ { name: 'vat-33:feed', class: 'Feed' } ],
			} ),
		],
		edges: [],
	},
	rows: {
		nodes: [
			node( 'press-61' ),
			node( 'vat-33', {
				class: 'Vat',
				sidecars: [ { name: 'vat-33:feed', class: 'Feed' } ],
			} ),
			node( 'vat-33:feed', {
				class: 'Feed',
				owner: 'vat-33',
				sidecars: [ { name: 'vat-33:feed:valve', class: 'Valve' } ],
			} ),
			node( 'vat-33:feed:valve', {
				class: 'Valve',
				owner: 'vat-33:feed',
			} ),
		],
		edges: [],
	},
};

// OWNED with edges from its canvas nodes, and its rows with theirs.
const ownedWith = ( { edges = [], rowEdges = [] } ) => ( {
	graph: { ...OWNED.graph, edges },
	rows: { ...OWNED.rows, edges: rowEdges },
} );

// `left` and `right` nest in `outer`, and `left` is included directly too.
const TREE = { left: {}, outer: { left: {}, right: {} } };
const HULLS = Object.freeze( [
	{ include: 'left', depth: 2, nodeIds: [ 'both-9' ] },
	{ include: 'right', depth: 2, nodeIds: [ 'both-9', 'only-right' ] },
	{
		include: 'outer',
		depth: 1,
		nodeIds: [ 'both-9', 'only-right', 'only-outer' ],
	},
] );

const groupsOf = ( hulls, tree ) => placeHulls( hulls, tree ).groups;

describe( 'placeHulls', () => {
	it( 'nests an include under the parent of its deepest occurrence', () => {
		const groups = byId( groupsOf( HULLS, TREE ) );

		expect( groups.left.parent ).toBe( 'outer' );
		expect( groups.right.parent ).toBe( 'outer' );
		expect( groups.outer.parent ?? null ).toBeNull();
		expect( groups.left.label ).toBe( 'left' );
	} );

	it( 'takes the first of two occurrences at one depth', () => {
		const tree = { north: { shared: {} }, south: { shared: {} } };
		const hulls = [ 'north', 'south', 'shared' ].map( ( include ) => ( {
			include,
			depth: 'shared' === include ? 2 : 1,
			nodeIds: [ 'n-4' ],
		} ) );

		expect( byId( groupsOf( hulls, tree ) ).shared.parent ).toBe( 'north' );
	} );

	it( 'skips an include without a hull to the one around it', () => {
		const tree = { outer: { unseen: { inner: {} } } };
		const hulls = [
			{ include: 'outer', depth: 1, nodeIds: [ 'n-4' ] },
			{ include: 'inner', depth: 3, nodeIds: [ 'n-4' ] },
		];

		expect( byId( groupsOf( hulls, tree ) ).inner.parent ).toBe( 'outer' );
	} );

	it( 'leaves an include the tree does not name at the top', () => {
		const [ group ] = groupsOf(
			[ { include: 'stray', depth: 0, nodeIds: [ 'n-4' ] } ],
			{ other: {} }
		);

		expect( group.parent ?? null ).toBeNull();
	} );

	it( 'never answers a parent cycle', () => {
		const hulls = [ 'a', 'b' ].map( ( include ) => ( {
			include,
			depth: 2,
			nodeIds: [ `${ include }-node` ],
		} ) );
		const groups = groupsOf( hulls, { a: { b: {} }, b: { a: {} } } );

		expect( () =>
			buildModel( {
				nodes: [ { id: 'n-4', label: 'n-4', group: 'a' } ],
				links: [],
				groups,
			} )
		).not.toThrow();
	} );

	it( 'colors a group by its name, so it keeps its color when another leaves', () => {
		const hulls = [ 'inner', 'harbor', 'orchard' ].map( ( include ) => ( {
			include,
			depth: 1,
			nodeIds: [ 'n-4' ],
		} ) );
		const colors = ( list ) =>
			groupsOf( list, {} ).map( ( { id, className } ) => [
				id,
				className,
			] );

		expect( colors( hulls ) ).toEqual( [
			[ 'inner', 'is-hull-1' ],
			[ 'harbor', 'is-hull-3' ],
			[ 'orchard', 'is-hull-6' ],
		] );
		expect( colors( hulls.slice( 1 ) ) ).toEqual(
			colors( hulls ).slice( 1 )
		);
	} );
} );

describe( 'toForceGraph seats', () => {
	const graph = {
		nodes: [ 'both-9', 'only-right', 'only-outer', 'bare' ].map( ( id ) =>
			node( id )
		),
		edges: [],
	};

	it( 'seats a node in its deepest include, and a tie in the first the tree names', () => {
		const { nodes } = draw( { graph, hulls: HULLS, tree: TREE } );
		const groups = Object.fromEntries(
			nodes.map( ( { id, group } ) => [ id, group ?? null ] )
		);

		expect( groups ).toEqual( {
			'both-9': 'left',
			'only-right': 'right',
			'only-outer': 'outer',
			bare: null,
		} );
	} );

	it( 'breaks a tie by the first naming at any depth', () => {
		const tree = { late: {}, outer: { early: {}, late: {} } };
		const hulls = [ 'early', 'late' ].map( ( include ) => ( {
			include,
			depth: 2,
			nodeIds: [ 'both-9' ],
		} ) );

		const { nodes } = draw( { graph, hulls, tree } );

		expect( byId( nodes )[ 'both-9' ].group ).toBe( 'late' );
	} );
} );

describe( 'toForceGraph sidecars', () => {
	it( 'draws two levels in their patron group, each joined to its patron', () => {
		const { nodes, links, patronOf } = draw( {
			...OWNED,
			hulls: [ { include: 'works', depth: 1, nodeIds: [ 'vat-33' ] } ],
			tree: { works: {} },
		} );

		expect(
			nodes.map( ( { id, group, title } ) => [
				id,
				group ?? null,
				title,
			] )
		).toEqual( [
			[ 'press-61', null, 'Press' ],
			[ 'vat-33', 'works', 'Vat' ],
			[ 'vat-33:feed', 'works', 'Feed' ],
			[ 'vat-33:feed:valve', 'works', 'Valve' ],
		] );
		expect( nodes.map( ( { scale } ) => scale ) ).toEqual( [
			1, 1, 0.8, 0.8,
		] );
		expect(
			links.map( ( { id, source, target, directed } ) => [
				id,
				source,
				target,
				!! directed,
			] )
		).toEqual( [
			[ 'patron:vat-33:feed', 'vat-33:feed', 'vat-33', false ],
			[
				'patron:vat-33:feed:valve',
				'vat-33:feed:valve',
				'vat-33:feed',
				false,
			],
		] );
		expect( links.every( ( l ) => wears( l, 'is-patron' ) ) ).toBe( true );
		expect( [ ...patronOf ] ).toEqual( [
			[ 'vat-33:feed', { root: 'vat-33', owner: 'vat-33' } ],
			[ 'vat-33:feed:valve', { root: 'vat-33', owner: 'vat-33:feed' } ],
		] );
	} );

	it( 'labels a node with its name', () => {
		expect( draw( OWNED ).nodes.map( ( { label } ) => label ) ).toEqual(
			ids( draw( OWNED ).nodes )
		);
	} );

	it.each( [
		[ 'sidecar to patron', 'vat-33:feed', 'vat-33', 'rowEdges', {} ],
		[ 'patron to sidecar', 'vat-33', 'vat-33:feed', 'edges', {} ],
		[
			'patron to a listening sidecar',
			'vat-33',
			'vat-33:feed',
			'edges',
			{ registration: true, event: 'FLOOD' },
		],
	] )(
		'folds an edge, %s, into the patron line',
		( _, from, to, list, rest ) => {
			const { links } = draw( {
				...ownedWith( { [ list ]: [ { from, to, ...rest } ] } ),
			} );

			expect( ids( links ).sort() ).toEqual( [
				'patron:vat-33:feed',
				'patron:vat-33:feed:valve',
			] );
			const line = byId( links )[ 'patron:vat-33:feed' ];
			expect( line ).toMatchObject( {
				source: from,
				target: to,
				directed: true,
			} );
			expect( line.title ).toBe( rest.event );
			expect( wears( line, 'is-patron' ) ).toBe( true );
		}
	);

	it( 'titles a patron line with every event folded into it', () => {
		const listener = {
			from: 'vat-33',
			to: 'vat-33:feed',
			registration: true,
		};
		const { links } = draw(
			ownedWith( {
				edges: [
					{ from: 'vat-33', to: 'vat-33:feed' },
					{ ...listener, event: 'FLOOD' },
					{ ...listener, event: 'EBB' },
					{ ...listener, event: 'FLOOD' },
				],
				rowEdges: [ { from: 'vat-33:feed', to: 'vat-33' } ],
			} )
		);

		expect( byId( links )[ 'patron:vat-33:feed' ].title ).toBe(
			'FLOOD, EBB'
		);
		expect(
			byId( links )[ 'patron:vat-33:feed:valve' ].title
		).toBeUndefined();
	} );

	it( 'draws one line for edges both ways, the canvas node first', () => {
		const { links } = draw(
			ownedWith( {
				edges: [ { from: 'vat-33', to: 'vat-33:feed' } ],
				rowEdges: [ { from: 'vat-33:feed', to: 'vat-33' } ],
			} )
		);

		expect( byId( links )[ 'patron:vat-33:feed' ] ).toMatchObject( {
			source: 'vat-33',
			target: 'vat-33:feed',
		} );
	} );

	it( 'draws a sidecar’s other edges, and a canvas node’s once', () => {
		const edge = { from: 'press-61', to: 'vat-33' };
		const { links } = draw(
			ownedWith( {
				edges: [ edge ],
				rowEdges: [
					edge,
					{ from: 'press-61', to: 'vat-33:feed' },
					{ from: 'vat-33:feed:valve', to: 'press-61' },
				],
			} )
		);

		expect(
			ids( links ).filter( ( id ) => ! id.startsWith( 'patron:' ) )
		).toEqual( [
			'target:press-61/vat-33',
			'target:vat-33:feed:valve/press-61',
		] );
	} );

	it( 'draws an edge of the canvas to a sidecar that is not its own', () => {
		const { links } = draw(
			ownedWith( { edges: [ { from: 'press-61', to: 'vat-33:feed' } ] } )
		);

		expect( ids( links ) ).toContain( 'target:press-61/vat-33:feed' );
	} );

	it( 'draws a line from a sidecar to its patron’s patron', () => {
		const { links } = draw(
			ownedWith( {
				rowEdges: [ { from: 'vat-33:feed:valve', to: 'vat-33' } ],
			} )
		);

		expect( ids( links ) ).toEqual( [
			'target:vat-33:feed:valve/vat-33',
			'patron:vat-33:feed',
			'patron:vat-33:feed:valve',
		] );
	} );

	it( 'gives a Vault_Group child, owned and listed nowhere, no patron line', () => {
		const nodes = [
			node( 'spokes' ),
			node( 'spokes:oak', { owner: 'spokes' } ),
		];
		const { links, patronOf } = draw( {
			graph: { nodes, edges: [] },
			rows: { nodes, edges: [] },
		} );

		expect( links ).toEqual( [] );
		expect( patronOf.size ).toBe( 0 );
	} );

	it( 'draws no sidecar before the rows answer', () => {
		const { nodes, links } = draw( { ...OWNED, rows: null } );

		expect( ids( nodes ) ).toEqual( [ 'press-61', 'vat-33' ] );
		expect( links ).toEqual( [] );
	} );

	it( 'draws a listed sidecar missing from the rows by its name and class', () => {
		const [ , vat ] = OWNED.graph.nodes;
		const { nodes } = draw( {
			graph: { nodes: [ vat ], edges: [] },
			rows: { nodes: [ vat ], edges: [] },
		} );

		expect( nodes[ 1 ] ).toMatchObject( {
			id: 'vat-33:feed',
			label: 'vat-33:feed',
			title: 'Feed',
		} );
	} );

	it( 'reads the list of a canvas node the rows do not hold yet', () => {
		const { nodes } = draw( {
			...OWNED,
			rows: { nodes: [ node( 'press-61' ) ], edges: [] },
		} );

		expect( ids( nodes ) ).toContain( 'vat-33:feed' );
	} );

	it( 'takes a polled row’s list over the canvas node’s', () => {
		const { nodes } = draw( {
			...OWNED,
			rows: { nodes: [ node( 'vat-33' ) ], edges: [] },
		} );

		expect( ids( nodes ) ).toEqual( [ 'press-61', 'vat-33' ] );
	} );

	it( 'draws a node once, whoever lists it', () => {
		const rows = {
			nodes: [
				node( 'press-61', {
					sidecars: [
						{ name: 'press-61', class: 'Press' },
						{ name: 'vat-33', class: 'Vat' },
						{ name: 'spare', class: 'Spare' },
					],
				} ),
				node( 'vat-33', {
					sidecars: [ { name: 'spare', class: 'Spare' } ],
				} ),
			],
			edges: [],
		};
		const { nodes, links, patronOf } = draw( { ...OWNED, rows } );

		expect( ids( nodes ) ).toEqual( [ 'press-61', 'vat-33', 'spare' ] );
		expect( ids( links ) ).toEqual( [ 'patron:spare' ] );
		expect( patronOf.get( 'spare' ).owner ).toBe( 'press-61' );
	} );
} );

describe( 'toForceGraph lines', () => {
	const nodes = [ node( 'a-1' ), node( 'b-2' ), node( 'c-3' ) ];
	const lines = ( edges, rest = {} ) =>
		draw( { graph: { nodes, edges }, ...rest } ).links;

	it( 'draws a target line curved, as d3_visualizer.html does, with an arrowhead', () => {
		const [ line ] = lines( [ { from: 'a-1', to: 'b-2' } ] );

		expect( line ).toMatchObject( {
			id: 'target:a-1/b-2',
			source: 'a-1',
			target: 'b-2',
			directed: true,
			curved: true,
		} );
		expect( line.className ).toBe( 'is-target' );
		expect( line.loose ).toBeUndefined();
		expect( line.title ).toBeUndefined();
	} );

	it( 'draws a registration line for each event, titled with it', () => {
		const drawn = lines( [
			{ from: 'a-1', to: 'b-2', registration: true, event: 'TIMER' },
			{ from: 'a-1', to: 'b-2', registration: true, event: 'FLOOD' },
		] );

		expect( ids( drawn ) ).toEqual( [
			'registration:a-1/b-2/TIMER',
			'registration:a-1/b-2/FLOOD',
		] );
		expect( drawn.map( ( { title } ) => title ) ).toEqual( [
			'TIMER',
			'FLOOD',
		] );
		expect( drawn.map( ( { directed } ) => directed ) ).toEqual( [
			true,
			true,
		] );
		expect( drawn[ 0 ].className ).toBe( 'is-registration' );
	} );

	it( 'draws both lines whose names run together alike', () => {
		const spelled = [ 'jobs', 'feed:tee', 'jobs:feed', 'tee' ];
		const drawn = draw( {
			graph: {
				nodes: spelled.map( ( id ) => node( id ) ),
				edges: [
					{ from: 'jobs', to: 'feed:tee' },
					{ from: 'jobs:feed', to: 'tee' },
				].flatMap( ( edge ) => [
					edge,
					{ ...edge, registration: true, event: 'TIMER' },
				] ),
			},
		} ).links;

		expect( ids( drawn ) ).toEqual( [
			'target:jobs/feed:tee',
			'registration:jobs/feed:tee/TIMER',
			'target:jobs:feed/tee',
			'registration:jobs:feed/tee/TIMER',
		] );
	} );

	it( 'draws both sinks whose names run together alike', () => {
		const drawn = draw( {
			graph: {
				nodes: [
					node( 'jobs', { sink: 'feed:tee' } ),
					node( 'jobs:feed', { sink: 'tee' } ),
					node( 'feed:tee' ),
					node( 'tee' ),
				],
				edges: [],
			},
			showSinks: true,
		} ).links;

		expect( ids( drawn ) ).toEqual( [
			'sink:jobs/feed:tee',
			'sink:jobs:feed/tee',
		] );
	} );

	it( 'draws a sidecar close to its patron, however their line is folded', () => {
		const own = { ...OWNED, showSinks: true };
		const folded = {
			...own,
			graph: {
				...OWNED.graph,
				nodes: OWNED.graph.nodes.map( ( one ) => ( {
					...one,
					sink: 'press-61',
				} ) ),
				edges: [
					{ from: 'vat-33', to: 'vat-33:feed' },
					{ from: 'press-61', to: 'vat-33' },
				],
			},
		};
		for ( const options of [ own, folded ] ) {
			const { links } = draw( options );
			const close = links.filter( ( { distance } ) => 100 === distance );
			expect( ids( close ).sort() ).toEqual( [
				'patron:vat-33:feed',
				'patron:vat-33:feed:valve',
			] );
			expect(
				links.filter( ( { distance } ) => undefined !== distance )
			).toEqual( close );
		}
		expect( draw( folded ).links.length ).toBeGreaterThan( 2 );
	} );

	it( 'draws a virtual edge as a virtual target line', () => {
		const [ line ] = lines( [ { from: 'a-1', to: 'b-2', virtual: true } ] );

		expect( line.id ).toBe( 'target:a-1/b-2' );
		expect( line.className ).toBe( 'is-virtual' );
	} );

	it.each( [
		[ 'config alone', [ 'config' ], 'is-virtual' ],
		[ 'a pair', [ 'pair' ], 'is-virtual' ],
		[ 'connect', [ 'connect' ], 'is-target' ],
		[ 'connect and config', [ 'connect', 'config' ], 'is-target' ],
	] )(
		'draws an edge whose role is %s and its virtual twin as one line',
		( _, roles, kind ) => {
			const pair = [
				{ from: 'a-1', to: 'b-2', roles },
				{ from: 'a-1', to: 'b-2', virtual: true },
			];
			for ( const edges of [ pair, [ ...pair ].reverse() ] ) {
				expect(
					lines( edges ).map( ( l ) => [ l.id, l.className ] )
				).toEqual( [ [ 'target:a-1/b-2', kind ] ] );
			}
		}
	);

	it( 'draws a config edge without a virtual twin as a target line', () => {
		const [ line ] = lines( [
			{ from: 'a-1', to: 'b-2', roles: [ 'config' ] },
			{ from: 'b-2', to: 'a-1', virtual: true },
		] );

		expect( line.className ).toBe( 'is-target' );
	} );

	it( 'draws a virtual line beside a registration over its ends', () => {
		const drawn = lines( [
			{ from: 'a-1', to: 'b-2', registration: true, event: 'TIMER' },
			{ from: 'a-1', to: 'b-2', virtual: true },
		] );

		expect( drawn.map( ( { className } ) => className ) ).toEqual( [
			'is-registration',
			'is-virtual',
		] );
	} );

	it( 'draws one line for edges that collapse on a pair, as the first', () => {
		const drawn = lines( [
			{ from: 'a-1', to: 'b-2' },
			{ from: 'a-1', to: 'b-2' },
			{ from: 'a-1', to: 'b-2', virtual: true },
			{ from: 'b-2', to: 'a-1' },
		] );

		expect( drawn.map( ( l ) => [ l.id, l.className ] ) ).toEqual( [
			[ 'target:a-1/b-2', 'is-target' ],
			[ 'target:b-2/a-1', 'is-target' ],
		] );
	} );

	it( 'bars every line but a connection from a press', () => {
		const drawn = draw( {
			...ownedWith( {
				edges: [
					{ from: 'press-61', to: 'vat-33' },
					{ from: 'vat-33', to: 'press-61', roles: [ 'config' ] },
					{
						from: 'press-61',
						to: 'vat-33',
						registration: true,
						event: 'EBB',
					},
				],
				rowEdges: [
					{ from: 'vat-33:feed', to: 'press-61' },
					{
						from: 'vat-33:feed:valve',
						to: 'press-61',
						roles: [ 'config' ],
					},
				],
			} ),
			showSinks: true,
		} ).links;
		const barred = Object.fromEntries(
			drawn.map( ( { id, pressable } ) => [ id, ! pressable ] )
		);

		expect( barred ).toEqual( {
			'target:press-61/vat-33': false,
			'target:vat-33/press-61': true,
			'registration:press-61/vat-33/EBB': true,
			'target:vat-33:feed/press-61': false,
			'target:vat-33:feed:valve/press-61': true,
			'patron:vat-33:feed': true,
			'patron:vat-33:feed:valve': true,
		} );
		expect(
			drawn.filter( ( { pressable } ) => undefined === pressable )
		).toEqual( [] );
	} );

	it( 'marks a node with a target line as an owner, as the visualizer colors one', () => {
		const drawn = byId(
			draw( {
				graph: {
					nodes: [
						node( 'press-61' ),
						node( 'vat-33' ),
						node( 'tank-47' ),
					],
					edges: [ { from: 'press-61', to: 'vat-33' } ],
				},
				showSinks: true,
			} ).nodes
		);
		expect(
			[ 'press-61', 'vat-33', 'tank-47' ].map( ( id ) =>
				wears( drawn[ id ], 'is-owner' )
			)
		).toEqual( [ true, false, false ] );
	} );

	it( 'bars a sink line from a press', () => {
		const [ line ] = draw( {
			graph: {
				nodes: [ node( 'a-1', { sink: 'b-2' } ), node( 'b-2' ) ],
				edges: [],
			},
			showSinks: true,
		} ).links;

		expect( line.id ).toBe( 'sink:a-1/b-2' );
		expect( line.pressable ).toBe( false );
	} );

	it.each( [
		[ [ { roles: [ 'connect' ] }, { virtual: true } ], true ],
		[ [ { roles: [ 'config' ] }, {} ], true ],
		[ [ { virtual: true } ], false ],
		[ [ { roles: [ 'pair' ] } ], false ],
		[ [ { registration: true, event: 'EBB' }, { virtual: true } ], false ],
	] )( 'takes a press on the line of %j: %s', ( kinds, pressable ) => {
		const pair = kinds.map( ( kind ) => ( {
			from: 'a-1',
			to: 'b-2',
			...kind,
		} ) );
		for ( const edges of [ pair, [ ...pair ].reverse() ] ) {
			expect( byId( lines( edges ) )[ 'target:a-1/b-2' ].pressable ).toBe(
				pressable
			);
		}
	} );

	it( 'names the line a connection draws', () => {
		const edge = { from: 'c-3', to: 'a-1' };

		expect( ids( lines( [ edge ] ) ) ).toEqual( [ targetLinkId( edge ) ] );
	} );

	it( 'draws no line to a node off the canvas', () => {
		expect(
			lines( [
				{ from: 'a-1', to: 'gone' },
				{ from: 'gone', to: 'b-2' },
			] )
		).toEqual( [] );
	} );
} );

describe( 'toForceGraph selection', () => {
	const shown = ( state, rest = OWNED ) => draw( { ...rest, state } );

	it.each( [
		[ 'press-61', null, 'press-61' ],
		[ 'vat-33', 'vat-33:feed:valve', 'vat-33:feed:valve' ],
		[ 'vat-33', 'vat-33:lost', 'vat-33' ],
		[ null, null, null ],
	] )( 'of %s showing %s is %s', ( selectedId, sidecar, is ) => {
		expect( shown( { selectedId, sidecar } ).selectedId ).toBe( is );
	} );

	it( 'is the canvas node until its sidecars are drawn', () => {
		const state = { selectedId: 'vat-33', sidecar: 'vat-33:feed' };

		expect( shown( state, { ...OWNED, rows: null } ).selectedId ).toBe(
			'vat-33'
		);
	} );

	it( 'touches and spares the sidecar’s lines and body alone', () => {
		const { nodes, links } = shown( {
			selectedId: 'vat-33',
			sidecar: 'vat-33:feed:valve',
		} );

		expect(
			ids( links.filter( ( l ) => wears( l, 'is-touched' ) ) )
		).toEqual( [ 'patron:vat-33:feed:valve' ] );
		expect(
			ids( nodes.filter( ( n ) => ! wears( n, 'is-idle' ) ) )
		).toEqual( [ 'vat-33:feed:valve' ] );
	} );
} );

describe( 'toForceGraph sinks', () => {
	const canvas = [
		node( 'a-1', { sink: CI } ),
		node( 'b-2', { sink: 'a-1' } ),
		node( 'c-3', { sink: '_router' } ),
		node( 'd-4', { sink: '' } ),
	];
	const graph = { nodes: canvas, edges: [] };
	const rows = {
		nodes: [
			...canvas,
			node( CI, { class: 'Command_Interpreter', sink: '_router' } ),
			node( '_router', { class: 'Router', sink: '' } ),
			node( '_router:side', { owner: '_router' } ),
		],
		edges: [ { from: CI, to: 'd-4' } ],
	};

	it( 'draws neither the interpreter nor a sink line until asked', () => {
		const { nodes, links } = draw( { graph, rows } );

		expect( ids( nodes ) ).toEqual( [ 'a-1', 'b-2', 'c-3', 'd-4' ] );
		expect( links ).toEqual( [] );
	} );

	it( 'draws each sink, and the interpreter, and never the router', () => {
		const { nodes, links, patronOf } = draw( {
			graph,
			rows,
			showSinks: true,
			hulls: [ { include: 'works', depth: 1, nodeIds: [ 'a-1' ] } ],
			tree: { works: {} },
		} );

		expect( ids( nodes ) ).toEqual( [ 'a-1', 'b-2', 'c-3', 'd-4', CI ] );
		expect( byId( nodes )[ CI ].group ?? null ).toBeNull();
		expect( ids( nodes.filter( ( { center } ) => center ) ) ).toEqual( [
			CI,
		] );
		expect( byId( nodes )[ CI ].scale ).toBe( 1 );
		expect( patronOf.size ).toBe( 0 );
		expect(
			links
				.filter( ( { id } ) => id.startsWith( 'sink:' ) )
				.map( ( l ) => [
					l.id,
					l.source,
					l.target,
					l.className,
					l.directed,
					l.loose,
					l.tangle,
				] )
		).toEqual( [
			[
				`sink:a-1/${ CI }`,
				'a-1',
				CI,
				'is-sink',
				true,
				undefined,
				false,
			],
			[ 'sink:b-2/a-1', 'b-2', 'a-1', 'is-sink', true, undefined, false ],
		] );
	} );

	it( 'draws the interpreter’s own edges with it', () => {
		const { links } = draw( { graph, rows, showSinks: true } );

		expect( ids( links ) ).toContain( `target:${ CI }/d-4` );
	} );

	it( 'draws a sidecar’s sink', () => {
		const [ press, vat, feed, valve ] = OWNED.rows.nodes;
		const { links } = draw( {
			...OWNED,
			rows: {
				nodes: [ press, vat, { ...feed, sink: 'press-61' }, valve ],
				edges: [],
			},
			showSinks: true,
		} );

		expect( ids( links ) ).toContain( 'sink:vat-33:feed/press-61' );
	} );

	it( 'leaves the interpreter’s own sidecars off', () => {
		const { nodes } = draw( {
			graph,
			rows: {
				nodes: [
					...canvas,
					node( CI, { sidecars: [ { name: 'ci:x', class: 'X' } ] } ),
				],
				edges: [],
			},
			showSinks: true,
		} );

		expect( ids( nodes ) ).not.toContain( 'ci:x' );
	} );

	it( 'draws the sinks of the graph alone before the rows answer', () => {
		const { nodes, links } = draw( { graph, showSinks: true } );

		expect( ids( nodes ) ).not.toContain( CI );
		expect( ids( links ) ).toEqual( [ 'sink:b-2/a-1' ] );
	} );
} );

describe( 'toForceGraph lighting', () => {
	const DEAF = { accepts_fill: false, has_target: false };

	// One of each line, `a-1` sinking into and targeting `b-2`.
	const wired = ( flags = {} ) => {
		const owner = node( 'b-2', {
			...flags,
			sidecars: [ { name: 'b-2:side', class: 'Side' } ],
		} );
		const nodes = [ node( 'a-1', { ...flags, sink: 'b-2' } ), owner ];
		return {
			graph: {
				nodes,
				edges: [
					{ from: 'a-1', to: 'b-2' },
					{
						from: 'a-1',
						to: 'b-2',
						registration: true,
						event: 'TIMER',
					},
				],
			},
			rows: {
				nodes: [ ...nodes, node( 'b-2:side', { ...flags } ) ],
				edges: [],
			},
			showSinks: true,
		};
	};

	const rateOfLines = ( options ) =>
		Object.fromEntries(
			draw( options ).links.map( ( { id, rate } ) => [
				id.split( ':' )[ 0 ],
				rate,
			] )
		);

	it.each( [
		[ 0, 0, 0, { target: 0, registration: 0, sink: 0, patron: 0 } ],
		[ 7, 0, 0, { target: 0, registration: 0, sink: 7, patron: 0 } ],
		[ 0, 7, 0, { target: 0, registration: 0, sink: 0, patron: 0 } ],
		[ 0, 0, 7, { target: 0, registration: 0, sink: 0, patron: 7 } ],
		[ 7, 3, 0, { target: 7, registration: 7, sink: 7, patron: 0 } ],
	] )(
		'lights lines at rates %d, %d and the sidecar’s %d, whatever the ports',
		( a, b, side, lit ) => {
			const rates = { 'a-1': a, 'b-2': b, 'b-2:side': side };

			expect( rateOfLines( { ...wired(), rates } ) ).toEqual( lit );
			expect( rateOfLines( { ...wired( DEAF ), rates } ) ).toEqual( lit );
		}
	);

	it( 'lights a patron line folded the other way by the sidecar still', () => {
		const { graph, ...rest } = wired();
		const { links } = draw( {
			...rest,
			graph: { ...graph, edges: [ { from: 'b-2', to: 'b-2:side' } ] },
			rates: { 'b-2': 3, 'b-2:side': 7 },
		} );

		expect( byId( links )[ 'patron:b-2:side' ].rate ).toBe( 7 );
	} );

	it( 'gives a node its own rate, idle while that is zero', () => {
		for ( const flags of [ {}, DEAF ] ) {
			const { nodes } = draw( {
				...wired( flags ),
				rates: { 'a-1': 7, 'b-2:side': 3 },
			} );

			expect( nodes.map( ( { rate } ) => rate ) ).toEqual( [ 7, 0, 3 ] );
			expect( nodes.map( ( n ) => wears( n, 'is-idle' ) ) ).toEqual( [
				false,
				true,
				false,
			] );
		}
	} );

	it( 'gives a draft neither a rate nor a sidecar, and idles nothing', () => {
		const { nodes, links } = draw( {
			...wired(),
			rates: { 'a-1': 7, 'b-2': 3 },
			state: { editMode: true },
		} );

		expect( ids( nodes ) ).toEqual( [ 'a-1', 'b-2' ] );
		expect( nodes.map( ( { className } ) => className ) ).toEqual( [
			'is-owner',
			'',
		] );
		expect( ids( links ) ).toEqual( [
			'target:a-1/b-2',
			'registration:a-1/b-2/TIMER',
			'sink:a-1/b-2',
		] );
		for ( const { rate } of [ ...nodes, ...links ] ) {
			expect( rate ).toBeUndefined();
		}
	} );
} );

describe( 'toForceGraph circles', () => {
	const wired = () => {
		const owner = node( 'b-2', {
			sidecars: [ { name: 'b-2:side', class: 'Side' } ],
		} );
		const nodes = [ node( 'a-1', { sink: 'b-2' } ), owner ];
		return {
			graph: { nodes, edges: [ { from: 'a-1', to: 'b-2' } ] },
			rows: { nodes: [ ...nodes, node( 'b-2:side' ) ], edges: [] },
		};
	};
	const circles = ( options ) =>
		draw( options ).nodes.map( ( one ) => [
			one.id,
			circleRadius( one ),
			one.detail,
			one.scale,
		] );

	it( 'draws every node, sidecars too, just wide enough for its own rate', () => {
		expect(
			circles( {
				...wired(),
				rates: { 'a-1': 6400, 'b-2:side': 1600 },
			} )
		).toEqual( [
			[ 'a-1', detailRadius( '6,400/s' ), '6,400/s', 1 ],
			[ 'b-2', detailRadius( '0/s' ), '0/s', 1 ],
			[ 'b-2:side', detailRadius( '1,600/s' ), '1,600/s', 0.8 ],
		] );
	} );

	it( 'writes a rate out whole and in full, grouped, with no fraction', () => {
		const { nodes } = draw( {
			...wired(),
			rates: { 'a-1': 0.4, 'b-2': 1234567.6, 'b-2:side': 9.5 },
		} );
		expect( nodes.map( ( { detail } ) => detail ) ).toEqual( [
			'<1/s',
			'1,234,568/s',
			'10/s',
		] );
	} );

	it( 'draws a canvas without traffic at the width of its zero rate', () => {
		expect( circles( wired() ) ).toEqual( [
			[ 'a-1', 13.5, '0/s', 1 ],
			[ 'b-2', 13.5, '0/s', 1 ],
			[ 'b-2:side', 13.5, '0/s', 0.8 ],
		] );
	} );

	it( 'draws a draft’s nodes at the least radius, with no rate in them', () => {
		expect(
			circles( {
				...wired(),
				rates: { 'a-1': 6400 },
				state: { editMode: true },
			} )
		).toEqual( [
			[ 'a-1', 10, undefined, 1 ],
			[ 'b-2', 10, undefined, 1 ],
		] );
	} );
} );

describe( 'toForceGraph state', () => {
	const graph = {
		nodes: [
			node( 'a-1' ),
			node( 'b-2', {
				sidecars: [ { name: 'b-2:side', class: 'Side' } ],
			} ),
			node( 'c-3' ),
			node( 'd-4' ),
		],
		edges: [
			{ from: 'a-1', to: 'b-2' },
			{ from: 'b-2', to: 'c-3' },
			{ from: 'c-3', to: 'd-4' },
		],
	};
	const rows = graph;
	const hulls = [ { include: 'works', depth: 1, nodeIds: [ 'a-1', 'b-2' ] } ];
	const tree = { works: {} };
	const inState = ( state, rest = {} ) =>
		draw( { graph, rows, hulls, tree, state, ...rest } );

	// The ids of the items wearing a class.
	const wearing = ( list, name ) =>
		ids( list.filter( ( item ) => wears( item, name ) ) );

	it( 'touches the lines of the selected node, dimming none', () => {
		const { nodes, links } = inState( { selectedId: 'b-2' } );

		expect( wearing( links, 'is-touched' ) ).toEqual( [
			'target:a-1/b-2',
			'target:b-2/c-3',
			'patron:b-2:side',
		] );
		expect( wearing( [ ...nodes, ...links ], 'is-dimmed' ) ).toEqual( [] );
	} );

	it( 'touches the lines of the hovered node alone, dimming the rest', () => {
		const { nodes, links } = inState( {
			selectedId: 'a-1',
			hoveredId: 'd-4',
		} );

		expect( wearing( links, 'is-touched' ) ).toEqual( [
			'target:c-3/d-4',
		] );
		expect( wearing( links, 'is-dimmed' ) ).toEqual( [
			'target:a-1/b-2',
			'target:b-2/c-3',
			'patron:b-2:side',
		] );
		expect( wearing( nodes, 'is-dimmed' ) ).toEqual( [
			'a-1',
			'b-2',
			'c-3',
			'b-2:side',
		] );
	} );

	it( 'lights what lies in the selected hull, sidecars too, and dims the rest', () => {
		const { nodes, links } = inState( { selectedHull: 'works' } );

		expect( wearing( nodes, 'is-lit' ) ).toEqual( [
			'a-1',
			'b-2',
			'b-2:side',
		] );
		expect( wearing( nodes, 'is-dimmed' ) ).toEqual( [ 'c-3', 'd-4' ] );
		expect( wearing( links, 'is-lit' ) ).toEqual( [
			'target:a-1/b-2',
			'patron:b-2:side',
		] );
		expect( wearing( links, 'is-dimmed' ) ).toEqual( [
			'target:b-2/c-3',
			'target:c-3/d-4',
		] );
	} );

	it( 'dims a line that enters the selected hull', () => {
		const { links } = inState(
			{ selectedHull: 'works' },
			{ graph: { ...graph, edges: [ { from: 'd-4', to: 'a-1' } ] } }
		);

		expect( byId( links )[ 'target:d-4/a-1' ].className ).toBe(
			'is-target is-dimmed'
		);
	} );

	it( 'dims a hull’s own node and line while another node is hovered', () => {
		const { nodes, links } = inState( {
			selectedHull: 'works',
			hoveredId: 'a-1',
		} );

		expect( wearing( nodes, 'is-dimmed' ) ).toContain( 'b-2' );
		expect( wearing( links, 'is-dimmed' ) ).toContain( 'patron:b-2:side' );
		expect( wearing( links, 'is-dimmed' ) ).not.toContain(
			'target:a-1/b-2'
		);
	} );

	it( 'lights the hovered hull over the selected one', () => {
		const both = [
			...hulls,
			{ include: 'yard', depth: 1, nodeIds: [ 'c-3', 'd-4' ] },
		];
		const { nodes, links } = inState(
			{ selectedHull: 'works', hoveredHull: 'yard' },
			{ hulls: both, tree: { works: {}, yard: {} } }
		);

		expect( wearing( nodes, 'is-lit' ) ).toEqual( [ 'c-3', 'd-4' ] );
		expect( wearing( nodes, 'is-dimmed' ) ).toEqual( [
			'a-1',
			'b-2',
			'b-2:side',
		] );
		expect( wearing( links, 'is-lit' ) ).toEqual( [ 'target:c-3/d-4' ] );
		expect( wearing( nodes, 'is-idle' ) ).toEqual( [
			'a-1',
			'b-2',
			'b-2:side',
		] );
	} );

	it( 'lights a hovered hull with none selected', () => {
		const { nodes } = inState( { hoveredHull: 'works' } );

		expect( wearing( nodes, 'is-lit' ) ).toEqual( [
			'a-1',
			'b-2',
			'b-2:side',
		] );
	} );

	it( 'focuses nothing for a selected include without a hull', () => {
		const { nodes, links } = inState( { selectedHull: 'not-drawn' } );

		for ( const name of [ 'is-lit', 'is-dimmed' ] ) {
			expect( wearing( [ ...nodes, ...links ], name ) ).toEqual( [] );
		}
	} );

	it( 'idles a still node unless it is selected, hovered or in focus', () => {
		const rates = { 'd-4': 7 };

		expect( wearing( inState( {}, { rates } ).nodes, 'is-idle' ) ).toEqual(
			[ 'a-1', 'b-2', 'c-3', 'b-2:side' ]
		);
		expect(
			wearing(
				inState( { selectedId: 'a-1', hoveredId: 'c-3' }, { rates } )
					.nodes,
				'is-idle'
			)
		).toEqual( [ 'b-2', 'b-2:side' ] );
		expect(
			wearing(
				inState( { selectedHull: 'works' }, { rates } ).nodes,
				'is-idle'
			)
		).toEqual( [ 'c-3' ] );
	} );

	it( 'marks drift, and none while there is no drift to know', () => {
		expect(
			wearing(
				inState( { driftIds: new Set( [ 'c-3' ] ) } ).nodes,
				'is-drift'
			)
		).toEqual( [ 'c-3' ] );
		expect( wearing( inState( {} ).nodes, 'is-drift' ) ).toEqual( [] );
	} );

	it( 'never emits the classes the component adds itself', () => {
		const { nodes, links } = inState(
			{
				selectedId: 'a-1',
				hoveredId: 'b-2',
				selectedHull: 'works',
				driftIds: new Set( [ 'c-3' ] ),
			},
			{ rates: { 'a-1': 7, 'b-2': 3 } }
		);

		for ( const name of [ 'is-live', 'is-selected', 'is-hovered' ] ) {
			expect( wearing( [ ...nodes, ...links ], name ) ).toEqual( [] );
		}
	} );
} );

describe( 'toForceGraph and the model', () => {
	it( 'answers what the layout takes, with every part drawn at once', () => {
		const wired = ownedWith( {
			rowEdges: [ { from: 'vat-33:feed', to: 'press-61' } ],
		} );
		const [ press, vat ] = wired.graph.nodes;
		const hulls = [
			{ include: 'outer', depth: 1, nodeIds: [ 'press-61' ] },
			{ include: 'inner', depth: 2, nodeIds: [ 'vat-33' ] },
		];
		const tree = { outer: { inner: {} } };
		const drawn = draw( {
			...wired,
			graph: {
				...wired.graph,
				nodes: [ press, { ...vat, sink: 'press-61' } ],
			},
			hulls,
			tree,
			showSinks: true,
		} );
		const model = buildModel( {
			...drawn,
			groups: groupsOf( hulls, tree ),
		} );
		const laidOut = [ ...model.pulls, ...model.spans ];

		expect( model.leaves ).toHaveLength( 4 );
		expect( model.links ).toHaveLength( drawn.links.length );
		expect( ids( drawn.links ) ).toContain( 'sink:vat-33/press-61' );
		expect( laidOut.map( ( { link } ) => link.id ) ).not.toContain(
			'sink:vat-33/press-61'
		);
		expect( model.byId.get( 'vat-33:feed:valve' ).parent.id ).toBe(
			'group:inner'
		);
	} );
} );
