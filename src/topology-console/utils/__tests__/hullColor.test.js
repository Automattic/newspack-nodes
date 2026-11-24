/**
 * A hull's color follows its include's name, so it holds still whatever the
 * other hulls do, and both canvases paint it alike.
 */
import { hullColorIndex } from '../hullColor';

describe( 'hullColorIndex', () => {
	it.each( [
		[ 'inner', 0 ],
		[ 'left', 1 ],
		[ 'harbor', 2 ],
		[ 'dairy', 3 ],
		[ 'mill', 4 ],
		[ 'orchard', 5 ],
	] )( 'gives %s one of the six colors', ( include, index ) => {
		expect( hullColorIndex( include ) ).toBe( index );
	} );
} );
