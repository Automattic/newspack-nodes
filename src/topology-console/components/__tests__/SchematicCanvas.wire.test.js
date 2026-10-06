/**
 * The wire the canvas draws is the wire the layout's judge measures: a card's
 * clearance from a long wire, as `drawnCost` reads it, switches exactly where
 * the path `SchematicCanvas` renders holds the card's width.
 */

import SchematicCanvas, { NODE_H, NODE_W } from '../SchematicCanvas';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';
import {
	drawnCost,
	X_PAD,
	X_STEP,
	Y_PAD,
	Y_STEP,
} from '../../utils/autoLayout';

/**
 * The rendered wire's path, as its four cubic points.
 *
 * @param {Object<string,{x: number, y: number}>} positions Top-left of each card.
 * @return {Array<[number, number]>} Start, both controls, end.
 */
function drawnPath( positions ) {
	const ids = Object.keys( positions );
	const { container } = renderWithCatalog(
		<SchematicCanvas
			parsed={ {
				nodes: ids.map( ( id ) => ( { id } ) ),
				edges: [ { from: 's', to: 't' } ],
			} }
			selectedId={ null }
			onSelect={ () => {} }
			onDeselect={ () => {} }
			hoveredId={ null }
			onHover={ () => {} }
			rateRef={ { current: new Map() } }
		/>,
		{
			positionOverrides: positions,
			onPositionChange: () => {},
			viewport: null,
			onViewportChange: () => {},
		}
	);
	const d = container
		.querySelector( '.topology-edge--active' )
		.getAttribute( 'd' );
	const nums = d.match( /-?\d+(\.\d+)?/g ).map( Number );
	return [ 0, 2, 4, 6 ].map( ( i ) => [ nums[ i ], nums[ i + 1 ] ] );
}

/**
 * The y a cubic reaches where it crosses canvas x, by bisection on t.
 *
 * @param {Array<[number, number]>} pts The cubic's four points.
 * @param {number}                  x   Canvas x.
 * @return {number} The curve's y there.
 */
function yAtX( pts, x ) {
	const at = ( t, k ) =>
		pts[ 0 ][ k ] * ( 1 - t ) ** 3 +
		3 * pts[ 1 ][ k ] * t * ( 1 - t ) ** 2 +
		3 * pts[ 2 ][ k ] * t * t * ( 1 - t ) +
		pts[ 3 ][ k ] * t ** 3;
	let [ lo, hi ] = [ 0, 1 ];
	for ( let i = 0; i < 60; i++ ) {
		const mid = ( lo + hi ) / 2;
		[ lo, hi ] = at( mid, 0 ) < x ? [ mid, hi ] : [ lo, mid ];
	}
	return at( lo, 1 );
}

describe( 'SchematicCanvas — the drawn wire is the judged wire', () => {
	it( 'puts a card on a rising wire exactly where the rendered path holds its width', () => {
		// Two columns on and seven rows down: a rise the curve bends through.
		const s = { x: X_PAD, y: Y_PAD };
		const t = { x: X_PAD + 2 * X_STEP, y: Y_PAD + 7 * Y_STEP };
		const pts = drawnPath( { s, t } );
		const left = X_PAD + X_STEP;
		// The path runs through port centres, half a card below a top-left.
		const bottom =
			Math.max( yAtX( pts, left ), yAtX( pts, left + NODE_W ) ) -
			NODE_H / 2;
		const clearance = Y_STEP / 2;
		const verdict = ( y ) =>
			drawnCost( { s, t, m: { x: left, y } }, [ { from: 's', to: 't' } ] )
				.over;
		expect( verdict( bottom + clearance - 1 ) ).toEqual( [ 's→t over m' ] );
		expect( verdict( bottom + clearance + 1 ) ).toEqual( [] );
	} );
} );
