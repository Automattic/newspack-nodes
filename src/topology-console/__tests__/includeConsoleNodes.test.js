/**
 * The console extends CommandInterpreter.includeNodes (Tachikoma's
 * include_nodes) so `make_node` can resolve the console's own node classes.
 */

import '../includeConsoleNodes';
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { Core } from '../../runtime/core';
import { MetadataNode } from '../../runtime/metadata-node';
import { RemoteIpcNode } from '../../runtime/remote-ipc-node';

beforeEach( () => Core.reset() );

describe( 'includeConsoleNodes', () => {
	it( 'make_node resolves a console node class registered via the side-effect import', () => {
		const interpreter = new CommandInterpreterNode();
		interpreter.name = '_command_interpreter';
		interpreter.dispatch( 'make_node', 'Metadata mymeta' );
		const node = Core.node( 'mymeta' );
		expect( node ).toBeInstanceOf( MetadataNode );
		expect( node.sink ).toBe( interpreter );
	} );

	it( 'make_node resolves RemoteIpc (the per-worker command channel)', () => {
		const interpreter = new CommandInterpreterNode();
		interpreter.name = '_command_interpreter';
		interpreter.dispatch( 'make_node', 'RemoteIpc aggregator.p0' );
		expect( Core.node( 'aggregator.p0' ) ).toBeInstanceOf( RemoteIpcNode );
	} );
} );
