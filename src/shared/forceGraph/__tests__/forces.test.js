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

const canvas = { width: 2000, height: 1000 };

describe( 'chargeOf', () => {
	it( 'repels by the log of the rate, idle or not', () => {
		expect( chargeOf( 0 ) ).toBeCloseTo( -1500 );
		expect( chargeOf( 9 ) ).toBeCloseTo( -3000 );
		expect( chargeOf( 999 ) ).toBeCloseTo( -6000 );
	} );

	it( 'is stronger than the fixed charge of a graph without rates', () => {
		expect( CHARGE ).toBe( -1000 );
		expect( chargeOf( 0 ) ).toBeLessThan( CHARGE );
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
		const outer = model.byId.get( 'group:out' );
		const inner = model.byId.get( 'group:in' );

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
		forceCohesion( model, canvas )( 0.4 );

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
		forceCohesion( model, canvas )( 0.5 );

		expect( model.leaves[ 0 ].vx ).toBeCloseTo( 9 );
		expect( model.leaves[ 1 ].vx ).toBeCloseTo( -9 );
	} );

	it( 'fades a pull toward the canvas center in past 500 units', () => {
		const model = build( [ node( 'a' ) ] );
		at( model, [ [ 1750, 500 ] ] );
		forceCohesion( model, canvas )( 0.3 );

		expect( model.leaves[ 0 ].vx ).toBeCloseTo( -11.25 );

		at( model, [ [ 2000, 500 ] ] );
		forceCohesion( model, canvas )( 0.3 );

		expect( model.leaves[ 0 ].vx ).toBeCloseTo( -30 );
	} );
} );

describe( 'forceSiblings', () => {
	const pair = ( gap ) => {
		const model = build( [ node( 'a' ), node( 'b' ) ] );
		at( model, [
			[ 100, 40 ],
			[ 100 + gap, 40 ],
		] );
		forceSiblings( model )( 0.9 );
		return model.leaves;
	};

	it( 'parts siblings by the nearest exit, half each', () => {
		const [ a, b ] = pair( 50 );

		expect( a.vx ).toBe( -17 );
		expect( b.vx ).toBe( 17 );
		expect( a.vy ).toBe( 0 );
		expect( b.vy ).toBe( 0 );
	} );

	it( 'parts along y when that exit is nearer', () => {
		const model = build( [ node( 'a' ), node( 'b' ) ] );
		at( model, [
			[ 100, 40 ],
			[ 110, 60 ],
		] );
		forceSiblings( model )( 0 );
		const [ a, b ] = model.leaves;

		expect( a.vx ).toBe( 0 );
		expect( a.vy ).toBe( -( 12 + 12 - 20 + 24 ) / 2 );
		expect( b.vy ).toBe( 14 );
	} );

	it( 'parts toward the left when that exit is nearest', () => {
		const model = build( [ node( 'a', { size: 100 } ), node( 'b' ) ] );
		at( model, [
			[ 100, 100 ],
			[ 35, 100 ],
		] );
		forceSiblings( model )( 0 );
		const [ a, b ] = model.leaves;

		expect( [ a.vx, b.vx ] ).toEqual( [ 44.5, -44.5 ] );
		expect( [ a.vy, b.vy ] ).toEqual( [ 0, 0 ] );
	} );

	it( 'stops pushing at the gap', () => {
		const [ a, b ] = pair( 84 );

		expect( [ a.vx, a.vy, b.vx, b.vy ] ).toEqual( [ 0, 0, 0, 0 ] );
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
