/**
 * No-arg node-schema parity tests — these console nodes already have no
 * positional config, but Task 10 of the arguments() Tachikoma-parity refactor
 * requires every console node to expose a `nodeSchema()` with an explicit
 * `arguments: []` array so the schema-driven dump_config / palette catalog
 * machinery has a uniform contract to query.
 */

import { MetadataNode } from '../metadata-node';
import { UptimeNode } from '../uptime-node';
import { CompletionNode } from '../completion-node';
import { HeartbeatNode } from '../heartbeat-node';
import { ShellNode } from '../shell-node';

describe.each( [
	[ 'Metadata', MetadataNode ],
	[ 'Uptime', UptimeNode ],
	[ 'Completion', CompletionNode ],
	[ 'Heartbeat', HeartbeatNode ],
	[ 'Shell', ShellNode ],
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
