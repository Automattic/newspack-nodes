/**
 * Tests for what follows a changed graph: how a model's shape differs from
 * the one before it, what a model of the same shape takes over, where a new
 * model's leaves start, and whether a leaf crowds a sibling.
 */

import { buildModel } from '../model';
import { updateBoxes } from '../forces';
import { carry, compare, crowds, refresh } from '../follow';

const node = ( id, extra = {} ) => ( { id, label: id, ...extra } );
const group = ( id, parent = null ) => ( { id, parent } );
const link = ( source, target, extra = {} ) => ( { source, target, ...extra } );
const build = ( nodes, links = [], groups = [] ) =>
	buildModel( { nodes, links, groups } );

const SIZE = { width: 1313, height: 777 };
const leaf = ( model, id ) => model.byId.get( id );
const spot = ( { x, y } ) => [ x, y ];

/**
 * Put leaves at [ x, y ] pairs, in node order.
 * @param {import('../model').Model} model Model to move.
 * @param {number[][]}               spots Positions.
 * @return {import('../model').Model} The model.
 */
const at = ( model, spots ) => {
	model.leaves.forEach( ( one, i ) => {
		[ one.x, one.y ] = spots[ i ];
	} );
	updateBoxes( model );
	return model;
};

const ABCD = [ node( 'a' ), node( 'b' ), node( 'c' ), node( 'd' ) ];
const AB_BC = [ link( 'a', 'b' ), link( 'b', 'c' ) ];
const SPOTS = [
	[ 117, 211 ],
	[ 413, 223 ],
	[ 719, 227 ],
	[ 1031, 229 ],
];
const four = () => at( build( ABCD, AB_BC ), SPOTS );

describe( 'compare', () => {
	const of = ( was, next ) => compare( was, next );
	const same = { same: true, sameSurvivors: true };
	const kept = { same: false, sameSurvivors: true };
	const changed = { same: false, sameSurvivors: false };

	it( 'finds one shape in any order, whatever the text and the width', () => {
		const next = build(
			[
				node( 'd', { label: 'a longer label' } ),
				node( 'c', { className: 'lit' } ),
				node( 'b', { size: 31 } ),
				node( 'a' ),
			],
			[ link( 'b', 'c' ), link( 'a', 'b' ), link( 'a', 'gone' ) ],
			[ group( 'bare' ) ]
		);
		expect( of( four(), next ) ).toEqual( same );
	} );

	it( 'finds the survivors of a removal and an addition as they were', () => {
		const [ a, b, c, d ] = ABCD;
		expect( of( four(), build( [ a, b, c ], AB_BC ) ) ).toEqual( kept );
		expect( of( build( [ a, b, c ], AB_BC ), four() ) ).toEqual( kept );
		expect( of( four(), build( [ a, b, d, node( 'e' ) ], [] ) ) ).toEqual(
			changed
		);
		expect(
			of(
				four(),
				build( [ a, c, d, node( 'e' ) ], [ link( 'e', 'a' ) ] )
			)
		).toEqual( kept );
	} );

	it.each( [
		[ 'added', [ ...AB_BC, link( 'a', 'd' ) ] ],
		[ 'removed', AB_BC.slice( 1 ) ],
		[ 'parallel', [ ...AB_BC, link( 'a', 'b' ) ] ],
		[ 'turned', [ link( 'b', 'a' ), link( 'b', 'c' ) ] ],
		[ 'from elsewhere', [ link( 'd', 'b' ), link( 'b', 'c' ) ] ],
		[ 'to elsewhere', [ link( 'a', 'd' ), link( 'b', 'c' ) ] ],
	] )( 'finds a link %s', ( _name, links ) => {
		expect( of( four(), build( ABCD, links ) ) ).toEqual( changed );
	} );

	it( 'finds a link that turns loose, or no longer is', () => {
		const loose = [
			link( 'a', 'b', { loose: true } ),
			link( 'b', 'c', { loose: false } ),
		];
		expect( of( four(), build( ABCD, loose ) ) ).toEqual( changed );
		expect( of( build( ABCD, loose ), four() ) ).toEqual( changed );
		expect( of( build( ABCD, loose ), build( ABCD, loose ) ) ).toEqual(
			same
		);
		const [ , tight ] = loose;
		expect(
			of( four(), build( ABCD, [ link( 'a', 'b' ), tight ] ) )
		).toEqual( same );
	} );

	it( 'finds a node that changes groups', () => {
		const homes = ( home ) =>
			build(
				[
					node( 'a', { group: home } ),
					node( 'b', { group: 'g' } ),
					node( 'c', { group: 'h' } ),
				],
				[],
				[ group( 'g' ), group( 'h' ) ]
			);
		expect( of( homes( 'g' ), homes( 'h' ) ) ).toEqual( changed );
		expect( of( homes( 'g' ), homes( null ) ) ).toEqual( changed );
	} );

	const tree = ( parent, extra = [] ) =>
		build(
			[
				node( 'a', { group: 'g' } ),
				node( 'b', { group: 'h' } ),
				node( 'c', { group: 'i' } ),
				...extra,
			],
			[],
			[ group( 'g' ), group( 'h', parent ), group( 'i' ) ]
		);

	it.each( [
		[ 'alone', [] ],
		[ 'beside a removal', [ node( 'd' ) ] ],
	] )( 'finds a regrouped group %s', ( _name, extra ) => {
		expect( of( tree( 'g', extra ), tree( 'i' ) ) ).toEqual( changed );
		expect( of( tree( null, extra ), tree( 'i' ) ) ).toEqual( changed );
		expect( of( tree( 'g', extra ), tree( null ) ) ).toEqual( changed );
	} );

	const wrapped = ( parent, extra = [] ) =>
		build(
			[
				node( 'a', { group: 'w/a' } ),
				node( 'b', { group: 'w/b' } ),
				...extra,
			],
			[],
			[ group( 'w' ), group( 'w/a', parent ), group( 'w/b', parent ) ]
		);

	it( 'finds a hull put round survivors, beside a removal', () => {
		const was = wrapped( null, [ node( 'd' ) ] );
		expect( of( was, wrapped( 'w' ) ) ).toEqual( changed );
	} );

	it( 'finds a hull that only goes a change of shape alone', () => {
		expect( of( wrapped( 'w' ), wrapped( null ) ) ).toEqual( kept );
	} );

	it( 'excuses a hull a removal dissolves, and its return forms', () => {
		const whole = wrapped( 'w' );
		const part = build(
			[ node( 'a', { group: 'w/a' } ) ],
			[],
			[ group( 'w' ), group( 'w/a', 'w' ), group( 'w/b', 'w' ) ]
		);
		expect( leaf( part, 'a' ).parent.parent ).toBe( null );
		expect( of( whole, part ) ).toEqual( kept );
		expect( of( part, whole ) ).toEqual( kept );
	} );
} );

describe( 'refresh', () => {
	const was = () =>
		at(
			build(
				[
					node( 'a', { group: 'g' } ),
					node( 'b', { group: 'g' } ),
					node( 'c' ),
				],
				[ link( 'a', 'b' ), link( 'a', 'b' ), link( 'b', 'c' ) ],
				[ group( 'g' ) ]
			),
			SPOTS
		);

	it( 'hands over the host data, parallel links each their own', () => {
		const model = was();
		const nodes = [
			node( 'c', { className: 'warm' } ),
			node( 'b', { group: 'g', className: 'lit' } ),
			node( 'a', { group: 'g', label: 'z' } ),
		];
		const links = [
			link( 'b', 'c', { weight: 5 } ),
			link( 'a', 'b', { weight: 6 } ),
			link( 'a', 'b', { weight: 7 } ),
		];
		const groups = [ { ...group( 'g' ), label: 'Gee' } ];

		expect( refresh( model, build( nodes, links, groups ) ) ).toEqual( [] );
		expect( leaf( model, 'a' ).node ).toBe( nodes[ 2 ] );
		expect( leaf( model, 'b' ).node ).toBe( nodes[ 1 ] );
		expect( model.links.map( ( one ) => one.link.weight ) ).toEqual( [
			6, 7, 5,
		] );
		expect( model.branches[ 0 ].group ).toBe( groups[ 0 ] );
		expect( model.leaves.map( spot ) ).toEqual( SPOTS.slice( 0, 3 ) );
	} );

	it( 'hands a loose link its own, whichever comes first', () => {
		const pair = ( weight ) => [
			link( 'a', 'b', { loose: true, weight } ),
			link( 'a', 'b', { weight: weight + 1 } ),
		];
		const model = at( build( ABCD, pair( 11 ) ), SPOTS );

		refresh( model, build( ABCD, pair( 23 ).reverse() ) );
		expect( model.links.map( ( one ) => one.link.weight ) ).toEqual( [
			23, 24,
		] );
		expect( model.pulls[ 0 ].link.weight ).toBe( 24 );
	} );

	it( 'hands over the extents and answers the leaves they changed', () => {
		const model = was();
		const next = build(
			[
				node( 'a', { group: 'g', label: 'a longer label' } ),
				node( 'b', { group: 'g', size: 13 } ),
				node( 'c' ),
			],
			[ link( 'a', 'b' ), link( 'a', 'b' ), link( 'b', 'c' ) ],
			[ group( 'g' ) ]
		);
		const [ a, b ] = [ leaf( model, 'a' ), leaf( model, 'b' ) ];
		expect( refresh( model, next ) ).toEqual( [ a, b ] );
		expect( [ a.halfW, a.halfH ] ).toEqual( [ 57, 12 ] );
		expect( a.radius ).toBe( Math.hypot( 57, 12 ) );
		expect( [ b.halfW, b.halfH ] ).toEqual( [ 30, 38 ] );
		expect( b.radius ).toBe( Math.hypot( 30, 38 ) );
	} );
} );

describe( 'carry', () => {
	const follow = ( was, next, seen = new Map() ) =>
		carry( was, next, seen, SIZE );

	it( 'keeps a survivor where it was, at its speed', () => {
		const was = four();
		Object.assign( leaf( was, 'b' ), { vx: 11, vy: -7 } );
		const next = build( ABCD.slice( 0, 3 ), AB_BC );
		expect( follow( was, next ) ).toEqual( {
			added: false,
			unsettled: [],
		} );
		expect( next.leaves.map( spot ) ).toEqual( SPOTS.slice( 0, 3 ) );
		const { vx, vy } = leaf( next, 'b' );
		expect( [ vx, vy ] ).toEqual( [ 11, -7 ] );
	} );

	it( 'returns a node to its last place, at rest and unsettled', () => {
		const seen = new Map();
		const was = four();
		Object.assign( leaf( was, 'd' ), { vx: 11, vy: -7 } );
		const less = build( ABCD.slice( 0, 3 ), AB_BC );
		follow( was, less, seen );
		const next = build( ABCD, AB_BC );
		const d = leaf( next, 'd' );
		expect( follow( less, next, seen ) ).toEqual( {
			added: false,
			unsettled: [ d ],
		} );
		expect( [ ...spot( d ), d.vx, d.vy ] ).toEqual( [ 1031, 229, 0, 0 ] );
	} );

	it( 'leaves a resized survivor unsettled', () => {
		const next = build(
			[ ...ABCD.slice( 0, 2 ), node( 'c', { size: 17 } ), node( 'd' ) ],
			AB_BC
		);
		expect( follow( four(), next ).unsettled ).toEqual( [
			leaf( next, 'c' ),
		] );
	} );

	it.each( [
		[ 'inward', [ 'e', 'f' ] ],
		[ 'outward', [ 'f', 'e' ] ],
	] )( 'starts a chain of new nodes listed %s', ( _name, ids ) => {
		const next = build(
			[ ...ABCD, ...ids.map( ( id ) => node( id ) ) ],
			[ ...AB_BC, link( 'f', 'e' ), link( 'e', 'c' ) ]
		);
		expect( follow( four(), next ).added ).toBe( true );
		expect( spot( leaf( next, 'e' ) ) ).toEqual( [ 779, 227 ] );
		expect( spot( leaf( next, 'f' ) ) ).toEqual( [ 839, 227 ] );
	} );

	it( 'starts a node flush beside the first of two neighbors', () => {
		const next = build(
			[ ...ABCD, node( 'e', { label: 'a longer label' } ) ],
			[ ...AB_BC, link( 'e', 'd' ), link( 'e', 'c' ) ]
		);
		follow( four(), next );
		expect( spot( leaf( next, 'e' ) ) ).toEqual( [ 1031 + 30 + 57, 229 ] );
	} );

	it( 'starts a pair linked only to each other from the canvas', () => {
		const next = build(
			[ ...ABCD, node( 'e' ), node( 'f' ) ],
			[ ...AB_BC, link( 'e', 'f' ) ]
		);
		follow( four(), next );
		expect( spot( leaf( next, 'e' ) ) ).toEqual( [ 656.5, 388.5 ] );
		expect( spot( leaf( next, 'f' ) ) ).toEqual( [ 716.5, 388.5 ] );
	} );

	it( 'starts a node without neighbors at its group, else its canvas', () => {
		const nodes = [
			node( 'a', { group: 'g' } ),
			node( 'b', { group: 'g' } ),
			node( 'c', { group: 'h' } ),
		];
		const groups = [ group( 'g' ), group( 'h' ), group( 'g/sub', 'g' ) ];
		const was = at( build( nodes, [], groups ), SPOTS );
		// The boxes lag a drag.
		Object.assign( leaf( was, 'b' ), { x: 517, y: 311 } );

		const next = build(
			[
				...nodes,
				node( 'in', { group: 'g' } ),
				node( 'deep', { group: 'g/sub' } ),
				node( 'out' ),
			],
			[],
			groups
		);
		follow( was, next );
		expect( spot( leaf( next, 'in' ) ) ).toEqual( [ 317, 261 ] );
		expect( spot( leaf( next, 'deep' ) ) ).toEqual( [ 317, 261 ] );
		expect( spot( leaf( next, 'out' ) ) ).toEqual( [ 656.5, 388.5 ] );
	} );
} );

describe( 'crowds', () => {
	it.each( [
		[ 'right of', 61, 0 ],
		[ 'left of', -61, 0 ],
		[ 'below', 0, 25 ],
		[ 'above', 0, -25 ],
	] )( 'clears a leaf just %s a sibling and no nearer', ( _name, dx, dy ) => {
		const beside = ( by ) =>
			at( build( [ node( 'a' ), node( 'b' ) ] ), [
				[ 413 + dx * by, 211 + dy * by ],
				[ 413, 211 ],
			] );
		const crowded = ( model ) => crowds( [ leaf( model, 'a' ) ], model );
		expect( crowded( beside( 1 ) ) ).toBe( false );
		expect( crowded( beside( 0.9 ) ) ).toBe( true );
	} );

	it( 'asks only for the leaves it is given', () => {
		const model = at( build( ABCD ), [
			[ 117, 211 ],
			[ 119, 211 ],
			[ 719, 227 ],
			[ 1031, 229 ],
		] );
		expect( crowds( [ leaf( model, 'c' ) ], model ) ).toBe( false );
		expect( crowds( [], model ) ).toBe( false );
		expect(
			crowds( [ leaf( model, 'c' ), leaf( model, 'a' ) ], model )
		).toBe( true );
	} );

	const hulls = ( spots ) => {
		const model = at(
			build(
				[
					node( 'a', { group: 'g' } ),
					node( 'b', { group: 'g' } ),
					node( 'c', { group: 'h' } ),
				],
				[],
				[ group( 'g' ), group( 'h' ) ]
			),
			SPOTS
		);
		// Boxes fitted elsewhere are stale.
		model.leaves.forEach( ( one, i ) => {
			[ one.x, one.y ] = spots[ i ];
		} );
		return crowds( [ leaf( model, 'a' ) ], model );
	};

	it( 'finds a hull the leaf stretches over a sibling hull', () => {
		const across = ( reach, y ) =>
			hulls( [
				[ 100, y ],
				[ reach, y ],
				[ 700, 400 ],
			] );
		expect( across( 539, 400 ) ).toBe( false );
		expect( across( 541, 400 ) ).toBe( true );
		expect( across( 541, 275 ) ).toBe( false );
		expect( across( 541, 277 ) ).toBe( true );
	} );

	it( 'holds a leaf to the hull of another, which its own hull pads', () => {
		const beside = ( x ) => {
			const model = at(
				build(
					[ node( 'a', { group: 'g' } ), node( 'c' ) ],
					[],
					[ group( 'g' ) ]
				),
				[
					[ 100, 400 ],
					[ x, 400 ],
				]
			);
			return [ 'a', 'c' ].map( ( id ) =>
				crowds( [ leaf( model, id ) ], model )
			);
		};
		expect( beside( 211 ) ).toEqual( [ false, false ] );
		expect( beside( 209 ) ).toEqual( [ true, true ] );
	} );
} );
