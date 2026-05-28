/**
 * The console extends CommandInterpreter.includeNodes (Tachikoma's
 * include_nodes) so `make_node` can resolve the console's own node classes.
 */

import '../includeConsoleNodes';
import { CommandInterpreter } from '../../runtime/command_interpreter';
import { Core } from '../../runtime/core';
import { Metadata } from '../nodes/metadata';

beforeEach( () => Core.reset() );

describe( 'includeConsoleNodes', () => {
	it( 'make_node resolves a console node class registered via the side-effect import', () => {
		const ci = new CommandInterpreter();
		ci.setName( '_command_interpreter' );
		ci.dispatch( 'make_node', 'Metadata mymeta' );
		const node = Core.node( 'mymeta' );
		expect( node ).toBeInstanceOf( Metadata );
		expect( node.sink ).toBe( ci );
	} );
} );
