/**
 * useRequestNode — mounts one `Request` node per concern on the backbone.
 *
 * The node sinks into `_shell`, the permanent observe-only Tap every command
 * routes through, so a `connect _shell` in the REPL sees a save or a delete the
 * same way it sees a typed one.
 */

import { renderHook } from '@testing-library/react';
import { Core, mountExospine } from '@newspack-nodes/runtime';
import names from '../../../runtime/reserved-node-names.json';
import useRequestNode from '../useRequestNode';

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

it( 'sinks into the _shell Tap, not past it into the interpreter', () => {
	renderHook( () => useRequestNode( 'topologies:save', 'topologies' ) );

	const node = Core.node( 'topologies:save' );
	expect( node ).not.toBeNull();
	expect( node.sink ).toBe( Core.node( names.CONSOLE_TAP ) );
	expect( node.target ).toBe( `${ names.HTTP }/topologies` );
} );

it( 'raises a backbone when there is none, and puts it away again', () => {
	const { unmount } = renderHook( () =>
		useRequestNode( 'topologies:save', 'topologies' )
	);
	expect( Core.node( names.ROUTER ) ).not.toBeNull();

	unmount();
	expect( Core.node( 'topologies:save' ) ).toBeNull();
	expect( Core.node( names.ROUTER ) ).toBeNull();
} );

it( 'leaves an owned backbone standing when it unmounts', () => {
	const owner = mountExospine();
	const { unmount } = renderHook( () =>
		useRequestNode( 'topologies:save', 'topologies' )
	);

	unmount();
	expect( Core.node( names.ROUTER ) ).not.toBeNull();
	owner.teardown();
} );

it( 'does not mount when disabled', () => {
	renderHook( () =>
		useRequestNode( 'topologies:save', 'topologies', false )
	);
	expect( Core.node( 'topologies:save' ) ).toBeNull();
	expect( Core.node( names.ROUTER ) ).toBeNull();
} );
