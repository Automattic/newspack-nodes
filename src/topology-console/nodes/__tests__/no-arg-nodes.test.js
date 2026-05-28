/**
 * No-arg node-schema parity tests — these console nodes already have no
 * positional config, but Task 10 of the arguments() Tachikoma-parity refactor
 * requires every console node to expose a `nodeSchema()` with an explicit
 * `arguments: []` array so the schema-driven dump_config / palette catalog
 * machinery has a uniform contract to query.
 */

import { Metadata } from '../metadata';
import { Uptime } from '../uptime';
import { Completion } from '../completion';
import { Heartbeat } from '../heartbeat';
import { Shell } from '../shell';

describe.each( [
	[ 'Metadata', Metadata ],
	[ 'Uptime', Uptime ],
	[ 'Completion', Completion ],
	[ 'Heartbeat', Heartbeat ],
	[ 'Shell', Shell ],
] )( '%s', ( _name, Cls ) => {
	it( 'constructs with no positional args', () => {
		const n = new Cls();
		expect( n ).toBeInstanceOf( Cls );
	} );

	it( 'declares nodeSchema() with an empty arguments array', () => {
		const schema = Cls.nodeSchema();
		expect( schema ).toBeDefined();
		expect( schema.arguments ).toEqual( [] );
	} );
} );
