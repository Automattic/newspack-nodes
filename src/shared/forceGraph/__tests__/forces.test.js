/**
 * Tests for the force graph's placement and forces: pure layout math over a
 * model, run here on small seeded fixtures.
 */

import { buildModel } from '../model';
import {
	CHARGE,
	chargeOf,
	forceClamp,
	forceCohesion,
	forceDock,
	forceSiblings,
	placeNodes,
	updateBoxes,
} from '../forces';

const node = ( id, extra = {} ) => ( { id, label: id, ...extra } );
const group = ( id, parent = null ) => ( { id, parent } );
const build = ( nodes, groups = [], links = [] ) =>
	buildModel( { nodes, links, groups } );

/**
 * Put leaves at [ x, y ] pairs, in node order, at rest.
 * @param {import('../model').Model} model Model to move.
 * @param {number[][]}               spots Positions.
 */
const at = ( model, spots ) =>
	model.leaves.forEach( ( leaf, i ) => {
		[ leaf.x, leaf.y ] = spots[ i ];
		leaf.vx = 0;
		leaf.vy = 0;
	} );

describe( 'chargeOf', () => {
	it( 'repels as d3_visualizer.html does: -2 by a log scale of 5 to 100 over 1 + the rate', () => {
		expect( chargeOf( 0 ) ).toBeCloseTo( -10 );
		expect( chargeOf( 9 ) ).toBeCloseTo( -200 );
		expect( chargeOf( 99 ) ).toBeCloseTo( -390 );
	} );

	it( 'gives a graph without rates a charge of its own, -1000, the rate scale having nothing to read', () => {
		expect( CHARGE ).toBe( -1000 );
	} );
} );

describe( 'placeNodes', () => {
	const fixture = () =>
		build(
			[
				node( 'a', { group: 'g' } ),
				node( 'b', { group: 'g' } ),
				node( 'c', { group: 'h' } ),
				node( 'd' ),
			],
			[ group( 'g' ), group( 'h' ) ]
		);
	const size = { width: 1234, height: 777 };

	it( 'is deterministic', () => {
		const one = fixture();
		const two = fixture();
		placeNodes( one, size );
		placeNodes( two, size );

		expect( one.leaves.map( ( l ) => [ l.x, l.y ] ) ).toEqual(
			two.leaves.map( ( l ) => [ l.x, l.y ] )
		);
		expect( one.leaves[ 0 ].x ).not.toBe( one.leaves[ 3 ].x );
	} );

	it( 'rests every leaf and fits the branch boxes to them', () => {
		const model = fixture();
		model.leaves.forEach( ( leaf ) => {
			leaf.vx = 7;
			leaf.vy = -7;
		} );
		placeNodes( model, size );

		expect( model.leaves.every( ( l ) => 0 === l.vx && 0 === l.vy ) ).toBe(
			true
		);
		expect( model.leaves.every( ( l ) => Number.isFinite( l.x ) ) ).toBe(
			true
		);
		const [ g ] = model.branches;
		expect( g.boxMinX ).toBeLessThan( model.leaves[ 0 ].x );
		expect( Number.isFinite( g.radius ) ).toBe( true );
	} );
} );

describe( 'placement after forces', () => {
	it( 'places a reset model as a fresh one, however often it ticked', () => {
		const fixture = () =>
			build(
				[
					node( 'a', { group: 'g' } ),
					node( 'b', { group: 'g' } ),
					node( 'c', { group: 'h' } ),
					node( 'd' ),
				],
				[ group( 'g' ), group( 'h' ) ]
			);
		const size = { width: 1234, height: 777 };
		const ticked = fixture();
		placeNodes( ticked, size );
		const force = forceSiblings( ticked );
		for ( let i = 0; i < 50; i++ ) {
			updateBoxes( ticked );
			force();
			ticked.leaves.forEach( ( l ) => {
				l.x += l.vx * ( i % 7 );
				l.y -= l.vy;
			} );
		}
		placeNodes( ticked, size );
		const fresh = fixture();
		placeNodes( fresh, size );

		expect( ticked.leaves.map( ( l ) => [ l.x, l.y ] ) ).toEqual(
			fresh.leaves.map( ( l ) => [ l.x, l.y ] )
		);
	} );
} );

describe( 'updateBoxes', () => {
	it( 'boxes the leaves with the hull padding and weights the mass', () => {
		const model = build(
			[
				node( 'a', { group: 'g' } ),
				node( 'b', { group: 'g' } ),
				node( 'c', { group: 'g' } ),
			],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 100, 200 ],
			[ 300, 260 ],
			[ 400, 300 ],
		] );
		updateBoxes( model );
		const [ g ] = model.branches;

		expect( [ g.boxMinX, g.boxMaxX, g.boxMinY, g.boxMaxY ] ).toEqual( [
			20, 480, 138, 362,
		] );
		expect( [ g.x, g.y ] ).toEqual( [ 250, 250 ] );
		expect( g.radius ).toBeCloseTo( Math.hypot( 230, 112 ) );
		expect( g.massX ).toBeCloseTo( 800 / 3 );
		expect( g.massY ).toBeCloseTo( 760 / 3 );
	} );

	it( 'boxes a sized node by its whole rect', () => {
		const model = build(
			[ node( 'a', { group: 'g', size: 60 } ) ],
			[ group( 'g' ) ]
		);
		at( model, [ [ 300, 200 ] ] );
		updateBoxes( model );
		const [ g ] = model.branches;

		expect( [ g.boxMinX, g.boxMaxX, g.boxMinY, g.boxMaxY ] ).toEqual( [
			190, 410, 65, 335,
		] );
	} );

	it( 'reads a nested branch through its own box, deepest first', () => {
		const model = build(
			[ node( 'a', { group: 'in' } ), node( 'b', { group: 'out' } ) ],
			[ group( 'out' ), group( 'in', 'out' ) ]
		);
		at( model, [
			[ 100, 100 ],
			[ 500, 100 ],
		] );
		updateBoxes( model );
		const [ inner, outer ] = model.branches;

		expect( inner.boxMinX ).toBe( 20 );
		expect( outer.boxMinX ).toBe( 20 );
		expect( outer.boxMaxX ).toBe( 580 );
		expect( outer.massX ).toBeCloseTo( 300 );
	} );
} );

describe( 'forceCohesion', () => {
	it( 'pulls a leaf toward its branch by alpha times 0.1', () => {
		const model = build(
			[ node( 'a', { group: 'g' } ), node( 'b', { group: 'g' } ) ],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 900, 500 ],
			[ 1100, 500 ],
		] );
		updateBoxes( model );
		forceCohesion( model )( 0.4 );

		expect( model.leaves[ 0 ].vx ).toBeCloseTo( 4 );
		expect( model.leaves[ 1 ].vx ).toBeCloseTo( -4 );
		expect( model.leaves[ 0 ].vy ).toBeCloseTo( 0 );
	} );

	it( 'diminishes each higher ancestor by 0.9', () => {
		const model = build(
			[ node( 'a', { group: 'in1' } ), node( 'b', { group: 'in2' } ) ],
			[ group( 'out' ), group( 'in1', 'out' ), group( 'in2', 'out' ) ]
		);
		at( model, [
			[ 900, 500 ],
			[ 1300, 500 ],
		] );
		updateBoxes( model );
		forceCohesion( model )( 0.5 );

		expect( model.leaves[ 0 ].vx ).toBeCloseTo( 9 );
		expect( model.leaves[ 1 ].vx ).toBeCloseTo( -9 );
	} );

	it( 'pulls no leaf toward the canvas, however far out it stands', () => {
		const model = build( [ node( 'a' ) ] );
		at( model, [ [ 4321, 2468 ] ] );
		forceCohesion( model )( 0.3 );

		expect( [ model.leaves[ 0 ].vx, model.leaves[ 0 ].vy ] ).toEqual( [
			0, 0,
		] );
	} );
} );

describe( 'forceSiblings', () => {
	// A hull of one node beside a lone node, the lone node `dx`, `dy` away.
	const beside = ( dx, dy, extra = {} ) => {
		const model = build(
			[ node( 'a', { group: 'g', ...extra } ), node( 'b' ) ],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 100, 100 ],
			[ 100 + dx, 100 + dy ],
		] );
		updateBoxes( model );
		forceSiblings( model )( 0.9 );
		const [ a, b ] = model.leaves;
		return { a, b, g: model.branches[ 0 ] };
	};

	it( 'leaves two nodes to d3’s collision', () => {
		const model = build( [ node( 'a' ), node( 'b' ) ] );
		at( model, [
			[ 100, 40 ],
			[ 101, 41 ],
		] );
		forceSiblings( model )( 0.9 );

		expect( model.leaves.map( ( l ) => [ l.vx, l.vy ] ).flat() ).toEqual( [
			0, 0, 0, 0,
		] );
	} );

	it( 'parts a hull from a node by the nearest exit, half each', () => {
		const { a, b, g } = beside( 100, 0 );
		const kick = ( g.boxMaxX - b.boxMinX + 24 ) / 2;

		expect( [ a.vx, b.vx ] ).toEqual( [ -kick, kick ] );
		expect( [ a.vy, b.vy ] ).toEqual( [ 0, 0 ] );
	} );

	it( 'parts along y when that exit is nearer', () => {
		const { a, b, g } = beside( 0, 80 );
		const kick = ( g.boxMaxY - b.boxMinY + 24 ) / 2;

		expect( [ a.vx, b.vx ] ).toEqual( [ 0, 0 ] );
		expect( [ a.vy, b.vy ] ).toEqual( [ -kick, kick ] );
	} );

	it( 'parts toward the left when that exit is nearest', () => {
		const { a, b, g } = beside( -100, 0 );
		const kick = ( b.boxMaxX - g.boxMinX + 24 ) / 2;

		expect( [ a.vx, b.vx ] ).toEqual( [ kick, -kick ] );
		expect( [ a.vy, b.vy ] ).toEqual( [ 0, 0 ] );
	} );

	it( 'stops pushing at the gap', () => {
		const { g, b } = beside( 0, 0 );
		const model = build(
			[ node( 'a', { group: 'g' } ), node( 'b' ) ],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 100, 100 ],
			[ g.boxMaxX + 24 + b.halfW, 100 ],
		] );
		updateBoxes( model );
		forceSiblings( model )( 0 );

		expect( model.leaves.map( ( l ) => [ l.vx, l.vy ] ).flat() ).toEqual( [
			0, 0, 0, 0,
		] );
	} );

	it( 'pushes a sibling wholly inside another out', () => {
		const model = build(
			[
				node( 'a', { group: 'g' } ),
				node( 'b', { group: 'g' } ),
				node( 'c' ),
			],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 100, 100 ],
			[ 400, 100 ],
			[ 250, 100 ],
		] );
		updateBoxes( model );
		forceSiblings( model )( 0 );
		const [ a, b, c ] = model.leaves;

		expect( 0 !== c.vx || 0 !== c.vy ).toBe( true );
		expect( [ a.vy, b.vy, c.vy ] ).toEqual( [ -49, -49, 49 ] );
	} );

	it( 'never pushes a parent against its own child', () => {
		const model = build(
			[ node( 'a', { group: 'g' } ), node( 'b', { group: 'g' } ) ],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 100, 100 ],
			[ 300, 100 ],
		] );
		updateBoxes( model );
		forceSiblings( model )( 0 );

		expect( model.leaves.map( ( l ) => [ l.vx, l.vy ] ).flat() ).toEqual( [
			0, 0, 0, 0,
		] );
	} );
} );

describe( 'forceClamp', () => {
	it( 'cuts a velocity over 100 to 100', () => {
		const model = build( [ node( 'a' ) ] );
		model.leaves[ 0 ].vx = 90;
		model.leaves[ 0 ].vy = 120;
		forceClamp( model )();

		expect( model.leaves[ 0 ].vx ).toBeCloseTo( 60 );
		expect( model.leaves[ 0 ].vy ).toBeCloseTo( 80 );
	} );

	it( 'leaves a velocity under 100 untouched', () => {
		const model = build( [ node( 'a' ) ] );
		model.leaves[ 0 ].vx = 30;
		model.leaves[ 0 ].vy = 40;
		forceClamp( model )();

		expect( [ model.leaves[ 0 ].vx, model.leaves[ 0 ].vy ] ).toEqual( [
			30, 40,
		] );
	} );
} );

describe( 'forceDock', () => {
	/** The space a docked leaf keeps from the next and from the rest. */
	const GAP = 24;

	it( 'pins the docked leaves in a row under the rest, centred on them', () => {
		const model = build( [
			node( 'a', { size: 10 } ),
			node( 'b', { size: 10 } ),
			node( 'c', { size: 10, dock: true } ),
			node( 'd', { size: 10, dock: true } ),
		] );
		at( model, [
			[ -700, 0 ],
			[ 900, 300 ],
			[ 5, 5 ],
			[ 7, 7 ],
		] );
		forceDock( model )();
		const [ a, b, c, d ] = model.leaves;
		const step = 2 * c.halfW + GAP;
		const middle = ( a.x - a.halfW + b.x + b.halfW ) / 2;
		expect( c.fy ).toBe( b.y + b.halfH + GAP + c.halfH );
		expect( d.fy ).toBe( c.fy );
		expect( d.fx - c.fx ).toBe( step );
		expect( ( c.fx + d.fx ) / 2 ).toBe( middle );
		expect( [ a.fx, a.fy, b.fx, b.fy ] ).toEqual( [
			undefined,
			undefined,
			undefined,
			undefined,
		] );
	} );

	it( 'wraps a row wider than the rest into rows under one another', () => {
		const model = build( [
			node( 'a', { size: 10 } ),
			node( 'c', { size: 10, dock: true } ),
			node( 'd', { size: 10, dock: true } ),
			node( 'e', { size: 10, dock: true } ),
		] );
		at( model, [
			[ 40, 80 ],
			[ 0, 0 ],
			[ 0, 0 ],
			[ 0, 0 ],
		] );
		forceDock( model )();
		const [ a, c, d, e ] = model.leaves;
		const rise = 2 * c.halfH + GAP;
		expect( [ c.fx, d.fx, e.fx ] ).toEqual( [ a.x, a.x, a.x ] );
		expect( [ d.fy - c.fy, e.fy - d.fy ] ).toEqual( [ rise, rise ] );
		expect( c.fy ).toBe( a.y + a.halfH + GAP + c.halfH );
	} );

	it( 'spaces the row by the extents the leaves hold at each tick', () => {
		const model = build( [
			node( 'a', { size: 10 } ),
			node( 'c', { size: 10, dock: true } ),
			node( 'd', { size: 10, dock: true } ),
		] );
		at( model, [
			[ 0, 0 ],
			[ 0, 0 ],
			[ 0, 0 ],
		] );
		model.leaves[ 0 ].halfW = 900;
		const dock = forceDock( model );
		dock();
		const [ , c, d ] = model.leaves;
		c.halfW = 77;
		dock();
		expect( d.fx - c.fx ).toBe( 2 * 77 + GAP );
	} );

	it( 'docks no centred node and no node in a group', () => {
		const model = build(
			[
				node( 'a', { size: 10 } ),
				node( 'b', { size: 10, dock: true, center: true } ),
				node( 'c', { size: 10, dock: true, group: 'g' } ),
			],
			[ group( 'g' ) ]
		);
		at( model, [
			[ 0, 0 ],
			[ 3, 3 ],
			[ 9, 9 ],
		] );
		forceDock( model )();
		expect( model.leaves.map( ( { fx, fy } ) => [ fx, fy ] ) ).toEqual( [
			[ undefined, undefined ],
			[ undefined, undefined ],
			[ undefined, undefined ],
		] );
	} );

	it( 'rows them about the origin when nothing else stands', () => {
		const model = build( [
			node( 'c', { size: 10, dock: true } ),
			node( 'd', { size: 10, dock: true } ),
		] );
		forceDock( model )();
		const [ c, d ] = model.leaves;
		expect( [ c.fx + d.fx, c.fy, d.fy ] ).toEqual( [
			0,
			c.halfH,
			c.halfH,
		] );
	} );
} );
