/**
 * Tests for the force graph's model: the bodies, links and spans a layout
 * moves, built once from the host's nodes, links and groups.
 */

import {
	buildModel,
	circleRadius,
	detailRadius,
	labelHalfW,
	LABEL_HALF_H,
} from '../model';

const node = ( id, extra = {} ) => ( { id, label: id, ...extra } );
const link = ( source, target, extra = {} ) => ( { source, target, ...extra } );
const group = ( id, parent = null ) => ( { id, parent } );

const ids = ( bodies ) => bodies.map( ( body ) => body.id );
const branch = ( model, id ) =>
	model.branches.find( ( one ) => id === one.group.id );

describe( 'labelHalfW', () => {
	it( 'is half the label rect, never narrower than 60', () => {
		expect( labelHalfW( 'x'.repeat( 20 ) ) ).toBe( 78 );
		expect( labelHalfW( 'ab' ) ).toBe( 30 );
		expect( LABEL_HALF_H ).toBe( 12 );
	} );
} );

describe( 'detailRadius', () => {
	it( 'is half the detail and three pixels', () => {
		expect( detailRadius( '12,345,678/s' ) ).toBe( 45 );
		expect( detailRadius( '0/s' ) ).toBe( 13.5 );
	} );
} );

describe( 'circleRadius', () => {
	it( 'is the size, or half the detail and three pixels where wider', () => {
		// Twelve characters of 7 pixels, halved, and 3 of padding.
		expect( circleRadius( { size: 13, detail: '12,345,678/s' } ) ).toBe(
			45
		);
		expect( circleRadius( { size: 47, detail: '12,345,678/s' } ) ).toBe(
			47
		);
		expect( circleRadius( { size: 13 } ) ).toBe( 13 );
	} );
} );

describe( 'buildModel scale', () => {
	const extent = ( extra ) => {
		const { halfW, halfH, radius } = buildModel( {
			nodes: [ node( 'x'.repeat( 20 ), extra ) ],
			links: [],
			groups: [],
		} ).leaves[ 0 ];
		return [ halfW, halfH, radius ];
	};

	it( 'a scaled label is measured at its scale, its least width too', () => {
		expect( extent( { scale: 0.5 } ) ).toEqual( [
			39,
			6,
			Math.hypot( 39, 6 ),
		] );
		expect( extent( {} ).slice( 0, 2 ) ).toEqual( [ 78, 12 ] );
		expect( extent( { label: 'ab', scale: 0.5 } )[ 0 ] ).toBe( 15 );
	} );

	it( 'a circle too narrow for its detail is laid out at the detail', () => {
		expect(
			extent( { label: 'ab', size: 13, detail: '12,345,678/s' } ).slice(
				0,
				2
			)
		).toEqual( [ 45, 70 ] );
	} );

	it( 'a scaled label over a circle leaves the circle its size', () => {
		expect( extent( { size: 33, scale: 0.5 } ).slice( 0, 2 ) ).toEqual( [
			39, 45.5,
		] );
		expect( extent( { size: 44, scale: 0.5 } )[ 0 ] ).toBe( 44 );
		expect( extent( { size: 33 } ).slice( 0, 2 ) ).toEqual( [ 78, 58 ] );
	} );
} );

describe( 'buildModel links and spans', () => {
	it( 'a dangling link is dropped and a self link spans nothing', () => {
		const model = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ) ],
			links: [ link( 'A', 'B' ), link( 'A', 'gone' ), link( 'A', 'A' ) ],
			groups: [],
		} );

		expect( model.links ).toHaveLength( 2 );
		expect( model.spans ).toHaveLength( 1 );
	} );

	it( 'a pair linked many times, either way, is one span', () => {
		const model = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ) ],
			links: [ link( 'A', 'B' ), link( 'A', 'B' ), link( 'B', 'A' ) ],
			groups: [],
		} );

		expect( model.links ).toHaveLength( 3 );
		expect( model.spans ).toHaveLength( 1 );
	} );

	it( 'a link that does not tangle pulls, but no crossing of it counts', () => {
		const free = link( 'A', 'B', { tangle: false } );
		const model = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ), node( 'C' ) ],
			links: [ free, link( 'B', 'C' ) ],
			groups: [],
		} );
		const pairs = ( list ) =>
			list.map( ( l ) => [ l.source.id, l.target.id ] );

		expect( pairs( model.pulls ) ).toEqual( [
			[ 'A', 'B' ],
			[ 'B', 'C' ],
		] );
		expect( pairs( model.spans ) ).toEqual( [ [ 'B', 'C' ] ] );
	} );

	it( 'a loose link is drawn, and takes no part in the layout', () => {
		const loose = link( 'A', 'B', { loose: true } );
		const model = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ), node( 'C' ) ],
			links: [ loose, link( 'B', 'C', { loose: false } ) ],
			groups: [],
		} );

		expect( model.links ).toHaveLength( 2 );
		expect( model.links[ 0 ].link ).toBe( loose );
		for ( const list of [ model.pulls, model.spans ] ) {
			expect( list.map( ( l ) => [ l.source.id, l.target.id ] ) ).toEqual(
				[ [ 'B', 'C' ] ]
			);
		}
		expect( model.byId.get( 'A' ).neighbors ).toEqual( [] );
		expect( model.byId.get( 'A' ).spans ).toEqual( [] );
		expect( ids( model.byId.get( 'B' ).neighbors ) ).toEqual( [ 'C' ] );
		expect( model.movable.map( ( { body } ) => body.id ) ).toEqual( [
			'B',
			'C',
		] );
	} );

	it( 'a pair a loose link shares keeps its one span', () => {
		const model = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ) ],
			links: [ link( 'B', 'A', { loose: true } ), link( 'A', 'B' ) ],
			groups: [],
		} );

		expect( model.spans ).toEqual( [ model.links[ 1 ] ] );
		expect( model.pulls ).toEqual( [ model.links[ 1 ] ] );
	} );

	it( 'a link keeps the host link beside its two leaves', () => {
		const host = { source: 'A', target: 'B', weight: 7 };
		const model = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ) ],
			links: [ host ],
			groups: [],
		} );

		expect( model.links[ 0 ].link ).toBe( host );
		expect( model.links[ 0 ].source ).toBe( model.byId.get( 'A' ) );
		expect( model.links[ 0 ].target ).toBe( model.byId.get( 'B' ) );
	} );
} );

describe( 'buildModel byId', () => {
	it( 'files the leaves alone, though a node may carry a hull’s id', () => {
		const model = buildModel( {
			nodes: [
				node( 'A', { group: 'g' } ),
				node( 'B', { group: 'h' } ),
				node( 'group:g' ),
			],
			links: [ link( 'A', 'group:g' ), link( 'A', 'group:h' ) ],
			groups: [ group( 'g' ), group( 'h' ) ],
		} );

		expect( [ ...model.byId.keys() ] ).toEqual( [ 'A', 'B', 'group:g' ] );
		expect( [ ...model.byId.values() ] ).toEqual( model.leaves );
		expect( model.links.map( ( { target } ) => target ) ).toEqual( [
			model.leaves[ 2 ],
		] );
	} );
} );

describe( 'buildModel groups', () => {
	it( 'a group with neither nodes nor two child groups draws no branch', () => {
		const model = buildModel( {
			nodes: [ node( 'n', { group: 'a/b/c' } ) ],
			links: [],
			groups: [
				group( 'a' ),
				group( 'a/b', 'a' ),
				group( 'a/b/c', 'a/b' ),
			],
		} );

		expect( model.branches ).toHaveLength( 1 );
		expect( model.branches[ 0 ].id ).toBe( 'group:a/b/c' );
		expect( model.branches[ 0 ].parent ).toBeNull();
	} );

	it( 'a group where two child groups meet is a branch', () => {
		const model = buildModel( {
			nodes: [
				node( 'p', { group: 'a/b' } ),
				node( 'q', { group: 'a/b' } ),
				node( 'r', { group: 'a/c' } ),
			],
			links: [],
			groups: [ group( 'a' ), group( 'a/b', 'a' ), group( 'a/c', 'a' ) ],
		} );

		expect( ids( model.branches ).sort() ).toEqual( [
			'group:a',
			'group:a/b',
			'group:a/c',
		] );
		const top = branch( model, 'a' );
		expect( top.population ).toBe( 3 );
		expect( top.depth ).toBe( 0 );
		expect( branch( model, 'a/b' ).parent ).toBe( top );
		expect( branch( model, 'a/b' ).depth ).toBe( 1 );
		expect( branch( model, 'a/b' ).ancestors ).toEqual(
			new Set( [ top ] )
		);
		expect( ids( top.leafNodes ).sort() ).toEqual( [ 'p', 'q', 'r' ] );
	} );

	it( 'a group with no node beneath it is no branch and no meeting child', () => {
		const model = buildModel( {
			nodes: [ node( 'n' ), node( 'm', { group: 'k/x' } ) ],
			links: [],
			groups: [
				group( 'e' ),
				group( 'e/1', 'e' ),
				group( 'e/2', 'e' ),
				group( 'k' ),
				group( 'k/x', 'k' ),
				group( 'k/y', 'k' ),
			],
		} );

		expect( ids( model.branches ) ).toEqual( [ 'group:k/x' ] );
		expect( model.branches[ 0 ].leafNodes ).toHaveLength( 1 );
	} );

	it( 'a node deep beneath a group counts that group child as populated', () => {
		const model = buildModel( {
			nodes: [
				node( 'p', { group: 'a/b/c' } ),
				node( 'q', { group: 'a/d' } ),
			],
			links: [],
			groups: [
				group( 'a' ),
				group( 'a/b', 'a' ),
				group( 'a/b/c', 'a/b' ),
				group( 'a/d', 'a' ),
			],
		} );

		expect( ids( model.branches ).sort() ).toEqual( [
			'group:a',
			'group:a/b/c',
			'group:a/d',
		] );
	} );

	it( 'branches come deepest first', () => {
		const model = buildModel( {
			nodes: [
				node( 'p', { group: 'a/b' } ),
				node( 'q', { group: 'a/c' } ),
				node( 'r', { group: 'z' } ),
			],
			links: [],
			groups: [
				group( 'a' ),
				group( 'a/b', 'a' ),
				group( 'a/c', 'a' ),
				group( 'z' ),
			],
		} );
		const depths = model.branches.map( ( b ) => b.depth );

		expect( depths ).toEqual( [ ...depths ].sort( ( a, b ) => b - a ) );
		expect( depths[ 0 ] ).toBe( 1 );
	} );

	it( 'a branch holds child branches and leaves as its children', () => {
		const model = buildModel( {
			nodes: [
				node( 'p', { group: 'a' } ),
				node( 'q', { group: 'a/b' } ),
			],
			links: [],
			groups: [ group( 'a' ), group( 'a/b', 'a' ) ],
		} );

		expect( ids( branch( model, 'a' ).children ) ).toEqual( [
			'group:a/b',
			'p',
		] );
	} );

	it( 'a node without a group is a top-level sibling', () => {
		const model = buildModel( {
			nodes: [ node( 'loose' ), node( 'p', { group: 'g' } ) ],
			links: [],
			groups: [ group( 'g' ) ],
		} );

		expect( model.byId.get( 'loose' ).parent ).toBeNull();
		expect( ids( model.siblings[ 0 ] ) ).toEqual( [ 'group:g', 'loose' ] );
		expect( ids( model.siblings[ 1 ] ) ).toEqual( [ 'p' ] );
	} );

	it( 'a node naming no known group fails loud', () => {
		expect( () =>
			buildModel( {
				nodes: [ node( 'p', { group: 'nope' } ) ],
				links: [],
				groups: [],
			} )
		).toThrow( 'nope' );
	} );

	it( 'a group parent cycle fails loud', () => {
		const build = ( groups, nodes ) =>
			buildModel( { nodes, links: [], groups } );

		expect( () =>
			build( [ group( 'a', 'a' ) ], [ node( 'n', { group: 'a' } ) ] )
		).toThrow( 'force graph: group parent cycle at "a"' );
		expect( () =>
			build( [ group( 'd' ), group( 'a', 'b' ), group( 'b', 'a' ) ], [] )
		).toThrow( 'force graph: group parent cycle at "a"' );
		expect( () =>
			build(
				[ group( 'c', 'a' ), group( 'a', 'b' ), group( 'b', 'a' ) ],
				[ node( 'n', { group: 'c' } ) ]
			)
		).toThrow( 'force graph: group parent cycle at "a"' );
	} );

	it( 'a group naming an unknown parent fails loud, branch or not', () => {
		expect( () =>
			buildModel( {
				nodes: [ node( 'n', { group: 'g' } ) ],
				links: [],
				groups: [ group( 'g', 'ghost' ) ],
			} )
		).toThrow( 'force graph: unknown parent group "ghost"' );
		expect( () =>
			buildModel( {
				nodes: [ node( 'n', { group: 'g' } ) ],
				links: [],
				groups: [ group( 'g' ), group( 'x', 'phantom' ) ],
			} )
		).toThrow( 'force graph: unknown parent group "phantom"' );
	} );

	it( 'a duplicate node id or group id fails loud', () => {
		expect( () =>
			buildModel( {
				nodes: [ node( 'A' ), node( 'A' ) ],
				links: [],
				groups: [],
			} )
		).toThrow( 'force graph: duplicate node "A"' );
		expect( () =>
			buildModel( {
				nodes: [],
				links: [],
				groups: [ group( 'g' ), group( 'g' ) ],
			} )
		).toThrow( 'force graph: duplicate group "g"' );
	} );

	it( 'only links within one parent pull', () => {
		const grouped = buildModel( {
			nodes: [
				node( 'p', { group: 'g' } ),
				node( 'q', { group: 'g' } ),
				node( 'r', { group: 'h' } ),
			],
			links: [ link( 'p', 'q' ), link( 'p', 'r' ) ],
			groups: [ group( 'g' ), group( 'h' ) ],
		} );
		expect( grouped.pulls ).toHaveLength( 1 );
		expect( grouped.pulls[ 0 ].target.id ).toBe( 'q' );

		const flat = buildModel( {
			nodes: [ node( 'A' ), node( 'B' ) ],
			links: [ link( 'A', 'B' ), link( 'B', 'A' ), link( 'A', 'A' ) ],
			groups: [],
		} );
		expect( flat.pulls ).toHaveLength( 2 );
	} );
} );

describe( 'buildModel bodies', () => {
	it( 'a sized node is a circle body', () => {
		const model = buildModel( {
			nodes: [
				node( 'ab', { size: 41 } ),
				node( 'x'.repeat( 20 ), { size: 41 } ),
				node( 'plain' ),
			],
			links: [],
			groups: [],
		} );

		const small = model.byId.get( 'ab' );
		expect( small.halfW ).toBe( 41 );
		expect( small.halfH ).toBe( 66 );
		expect( model.byId.get( 'x'.repeat( 20 ) ).halfW ).toBe( 78 );
		const plain = model.byId.get( 'plain' );
		expect( plain.halfW ).toBe( labelHalfW( 'plain' ) );
		expect( plain.halfH ).toBe( LABEL_HALF_H );
		expect( plain.radius ).toBeCloseTo(
			Math.hypot( plain.halfW, plain.halfH )
		);
		expect( plain.population ).toBe( 1 );
	} );

	it( 'nodes are read by id, not by selector', () => {
		const model = buildModel( {
			nodes: [ node( 'a/b:c' ), node( 'it "is" it' ) ],
			links: [],
			groups: [],
		} );

		expect( model.byId.get( 'a/b:c' ).node.id ).toBe( 'a/b:c' );
		expect( model.byId.get( 'it "is" it' ).type ).toBe( 'leaf' );
	} );

	it( 'a group and a node may share a name', () => {
		const model = buildModel( {
			nodes: [ node( 'g', { group: 'g' } ) ],
			links: [],
			groups: [ group( 'g' ) ],
		} );

		expect( model.byId.get( 'g' ).type ).toBe( 'leaf' );
		expect( branch( model, 'g' ).type ).toBe( 'branch' );
		expect( branch( model, 'g' ).group.id ).toBe( 'g' );
	} );

	it( 'a body spans and neighbors only what leaves it', () => {
		const model = buildModel( {
			nodes: [
				node( 'p', { group: 'g' } ),
				node( 'q', { group: 'g' } ),
				node( 'r' ),
			],
			links: [ link( 'p', 'q' ), link( 'q', 'r' ) ],
			groups: [ group( 'g' ) ],
		} );

		const hull = branch( model, 'g' );
		expect( hull.spans ).toHaveLength( 2 );
		expect( ids( hull.neighbors ) ).toEqual( [ 'r' ] );
		expect( ids( model.byId.get( 'p' ).neighbors ) ).toEqual( [ 'q' ] );
		expect( ids( model.byId.get( 'r' ).neighbors ) ).toEqual( [ 'q' ] );
	} );

	it( 'movable holds only bodies with a neighbor outside themselves', () => {
		const model = buildModel( {
			nodes: [
				node( 'p', { group: 'g' } ),
				node( 'q', { group: 'g' } ),
				node( 'r' ),
			],
			links: [ link( 'p', 'r' ) ],
			groups: [ group( 'g' ) ],
		} );

		expect( model.movable.map( ( m ) => m.body.id ) ).toEqual( [
			'group:g',
			'r',
			'p',
		] );
		const p = model.movable.find( ( m ) => 'p' === m.body.id );
		expect( ids( p.peers ) ).toEqual( [ 'p', 'q' ] );
		const hull = model.movable.find( ( m ) => 'group:g' === m.body.id );
		expect( ids( hull.peers ) ).toEqual( [ 'group:g' ] );
	} );

	it( 'movable and its peers leave out a docked node', () => {
		const model = buildModel( {
			nodes: [ node( 'p' ), node( 'q' ), node( 'lone', { dock: true } ) ],
			links: [ link( 'p', 'q' ) ],
			groups: [],
		} );
		expect(
			model.movable.map( ( { body, peers } ) => [
				body.id,
				ids( peers ),
			] )
		).toEqual( [
			[ 'p', [ 'p', 'q' ] ],
			[ 'q', [ 'p', 'q' ] ],
		] );
	} );

	it( 'keeps a hull movable whose node asks to dock, since a grouped node does not', () => {
		const model = buildModel( {
			nodes: [ node( 'p' ), node( 'q', { group: 'g', dock: true } ) ],
			links: [ link( 'p', 'q' ) ],
			groups: [ group( 'g' ) ],
		} );
		expect( model.movable.map( ( { body } ) => body.id ).sort() ).toEqual( [
			'group:g',
			'p',
			'q',
		] );
	} );

	it( 'movable and its peers leave out a center node and its hulls', () => {
		const model = buildModel( {
			nodes: [
				node( 'p' ),
				node( 'q' ),
				node( 'hub', { center: true } ),
				node( 'r', { group: 'g/in' } ),
				node( 'mid', { center: true, group: 'g/in' } ),
				node( 's', { group: 'g' } ),
				node( 't', { group: 'h' } ),
			],
			links: [
				link( 'p', 'hub' ),
				link( 'q', 'r' ),
				link( 'mid', 't' ),
				link( 's', 't' ),
			],
			groups: [ group( 'g' ), group( 'g/in', 'g' ), group( 'h' ) ],
		} );
		const { movable } = model;
		expect( movable.map( ( { body } ) => body.id ).sort() ).toEqual( [
			'group:h',
			'p',
			'q',
			'r',
			's',
			't',
		] );
		const peersOf = ( id ) =>
			ids( movable.find( ( { body } ) => id === body.id ).peers );
		expect( peersOf( 'p' ) ).toEqual( [ 'p', 'q' ] );
		expect( peersOf( 'group:h' ) ).toEqual( [ 'group:h' ] );
		expect( peersOf( 'r' ) ).toEqual( [ 'r' ] );
	} );

	it( 'siblings of one type share one list of peers', () => {
		const model = buildModel( {
			nodes: [ node( 'p' ), node( 'q' ), node( 'r', { group: 'g' } ) ],
			links: [ link( 'p', 'q' ), link( 'q', 'r' ) ],
			groups: [ group( 'g' ) ],
		} );
		const peersOf = ( id ) =>
			model.movable.find( ( { body } ) => id === body.id ).peers;

		expect( ids( peersOf( 'p' ) ) ).toEqual( [ 'p', 'q' ] );
		expect( peersOf( 'q' ) ).toBe( peersOf( 'p' ) );
		expect( ids( peersOf( 'group:g' ) ) ).toEqual( [ 'group:g' ] );
	} );

	it( 'an empty graph builds an empty model', () => {
		const model = buildModel( { nodes: [], links: [], groups: [] } );

		expect( model.leaves ).toEqual( [] );
		expect( model.branches ).toEqual( [] );
		expect( model.links ).toEqual( [] );
		expect( model.pulls ).toEqual( [] );
		expect( model.spans ).toEqual( [] );
		expect( model.movable ).toEqual( [] );
		expect( model.siblings ).toEqual( [ [] ] );
		expect( model.byId.size ).toBe( 0 );
	} );
} );
