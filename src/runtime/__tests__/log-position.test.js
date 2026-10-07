/**
 * formatPosition and parsePosition — the one JS writer and the one JS reader
 * of a read position, held to PHP `Log_Position::format()` and `parse()` by
 * one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { formatPosition, parseCrumb, parsePosition } from '../log-position';

const fixture = JSON.parse(
	readFileSync(
		join( __dirname, '../../../tests/fixtures/log-positions.json' ),
		'utf8'
	)
);

describe( 'formatPosition parity with Log_Position::format()', () => {
	it.each( fixture.format )(
		'%s',
		( _label, segment, offset, length, position ) => {
			expect( formatPosition( segment, offset, length ) ).toBe(
				position
			);
		}
	);
} );

describe( 'parsePosition parity with Log_Position::parse()', () => {
	it.each( fixture.parse )( '%s', ( _label, position, expected ) => {
		expect( parsePosition( position ) ).toEqual( expected );
	} );
} );

describe( 'parseCrumb parity with Log_Position::crumb()', () => {
	it.each( fixture.crumb )( '%s', ( _label, id, expected ) => {
		expect( parseCrumb( id ) ).toEqual( expected );
	} );
} );
