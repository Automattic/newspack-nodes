/**
 * Tests for what a host builds its graph with: a circle's size by its share
 * of the most on the canvas, and the lighting a selection gives the graph.
 */

import { circleSize, lightGraph } from '..';

describe( 'circleSize', () => {
	it( 'is 10, and 20 more by the square root of the value’s share', () => {
		expect( circleSize( 9, 16 ) ).toBe( 25 );
		expect( circleSize( 64, 64 ) ).toBe( 30 );
		expect( circleSize( 0, 81 ) ).toBe( 10 );
	} );

	it( 'is the least radius where nothing on the canvas has a value', () => {
		expect( circleSize( 0, 0 ) ).toBe( 10 );
	} );

	it( 'starts from a least radius its host names', () => {
		expect( circleSize( 9, 16, 24 ) ).toBe( 39 );
		expect( circleSize( 0, 0, 24 ) ).toBe( 24 );
	} );
} );

describe( 'lightGraph', () => {
	const graph = () => ( {
		nodes: [
			{ id: 'quay', label: 'Quay', className: 'is-teal' },
			{ id: 'mill', label: 'Mill' },
			{ id: 'weir', label: 'Weir', className: 'is-odd' },
			{ id: 'ford', label: 'Ford' },
		],
		links: [
			{ id: 'quay mill', source: 'quay', target: 'mill' },
			{
				id: 'weir quay',
				source: 'weir',
				target: 'quay',
				className: 'is-dotted',
			},
			{ id: 'mill ford', source: 'mill', target: 'ford' },
		],
	} );
	const classesOf = ( list ) =>
		Object.fromEntries(
			list.map( ( { id, className } ) => [ id, className ] )
		);

	it( 'leaves the graph as it is with nothing selected', () => {
		const held = graph();
		expect( lightGraph( held, null ) ).toBe( held );
	} );

	it( 'lights the node, its lines and what they reach, and dims the rest', () => {
		const lit = lightGraph( graph(), 'quay' );
		expect( classesOf( lit.nodes ) ).toEqual( {
			quay: 'is-teal is-lit',
			mill: 'is-lit',
			weir: 'is-odd is-lit',
			ford: 'is-dimmed',
		} );
		expect( classesOf( lit.links ) ).toEqual( {
			'quay mill': 'is-lit',
			'weir quay': 'is-dotted is-lit',
			'mill ford': 'is-dimmed',
		} );
		expect( Object.keys( lit ) ).toEqual( [ 'nodes', 'links' ] );
	} );

	it( 'lights a line from either of its ends, and keeps the rest', () => {
		const held = graph();
		const { nodes, links } = lightGraph( held, 'ford' );
		expect( classesOf( links ) ).toEqual( {
			'quay mill': 'is-dimmed',
			'weir quay': 'is-dotted is-dimmed',
			'mill ford': 'is-lit',
		} );
		expect( nodes[ 1 ] ).toEqual( {
			...held.nodes[ 1 ],
			className: 'is-lit',
		} );
		expect( links[ 2 ] ).toEqual( {
			...held.links[ 2 ],
			className: 'is-lit',
		} );
		expect( held.nodes[ 1 ].className ).toBeUndefined();
	} );
} );
