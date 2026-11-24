/**
 * installSvgBox gives every svg one box: its size, its place in the window and
 * the map from the window to it agree, and the restore leaves jsdom as it was.
 */

import { pointer } from 'd3';
import { installSvgBox } from '../svgBox';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = () => document.createElementNS( SVG_NS, 'svg' );

let box;
afterEach( () => box.restore() );

test( 'an svg measures the box, before it is made or after', () => {
	const early = svg();
	box = installSvgBox( 1313, 777 );

	for ( const el of [ early, svg() ] ) {
		expect( [ el.clientWidth, el.clientHeight ] ).toEqual( [ 1313, 777 ] );
		expect( el.getBoundingClientRect() ).toEqual( {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 1313,
			height: 777,
			right: 1313,
			bottom: 777,
		} );
	}
} );

test( 'setSize moves the box alone, and a place stays', () => {
	box = installSvgBox( 1313, 777, { left: 31, top: 17 } );
	const el = svg();
	box.setSize( 901, 555 );

	expect( [ el.clientWidth, el.clientHeight ] ).toEqual( [ 901, 555 ] );
	expect( el.getBoundingClientRect() ).toEqual( {
		x: 31,
		y: 17,
		left: 31,
		top: 17,
		width: 901,
		height: 555,
		right: 932,
		bottom: 572,
	} );
} );

test( 'a point of the window maps into the box', () => {
	box = installSvgBox( 1313, 777, { left: 31, top: 17 } );
	const el = svg();
	const point = el.createSVGPoint();
	Object.assign( point, { x: 531, y: 217 } );
	const { x, y } = point.matrixTransform( el.getScreenCTM().inverse() );

	expect( [ x, y ] ).toEqual( [ 500, 200 ] );
	expect( pointer( { clientX: 531, clientY: 217 }, el ) ).toEqual( [
		500, 200,
	] );
} );

test( 'a point takes a whole matrix, and none leaves it in place', () => {
	box = installSvgBox( 1313, 777 );
	const point = svg().createSVGPoint();
	Object.assign( point, { x: 3, y: 5 } );

	expect( [ point.x, point.y ] ).toEqual( [ 3, 5 ] );
	expect(
		point.matrixTransform( { a: 2, b: 7, c: 11, d: 13, e: 17, f: 19 } )
	).toEqual( { x: 78, y: 105 } );
} );

test( 'another element has no box', () => {
	box = installSvgBox( 1313, 777 );
	const g = document.createElementNS( SVG_NS, 'g' );

	expect( g.clientWidth ).toBe( 0 );
	expect( g.getBoundingClientRect().width ).toBe( 0 );
} );

test( 'restore leaves jsdom as it was', () => {
	const names = () =>
		Object.getOwnPropertyNames( window.SVGSVGElement.prototype ).sort();
	const before = names();
	box = installSvgBox( 1313, 777 );
	expect( names() ).not.toEqual( before );
	box.restore();

	expect( names() ).toEqual( before );
	const el = svg();
	expect( el.clientWidth ).toBe( 0 );
	expect( el.getBoundingClientRect().width ).toBe( 0 );
} );
