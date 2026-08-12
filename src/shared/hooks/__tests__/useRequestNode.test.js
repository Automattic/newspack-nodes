/**
 * useRequestNode — mounts one `Request` node per concern on the backbone.
 *
 * It routes THROUGH `_shell` — the permanent observe-only Tap every command
 * passes — so a `connect _shell` in the REPL sees a save or a delete the same
 * way it sees a typed one. That hop is a TARGET path rather than a bespoke
 * sink, because `target` already reaches it exactly as the Fetchers do
 * (`_shell/_http/topologies`); re-pointing the sink bought nothing the routing
 * did not already give.
 */

import { renderHook } from '@testing-library/react';
import { Core, mountExospine } from '@newspack-nodes/runtime';
import names from '../../../runtime/reserved-node-names.json';
import useRequestNode, { ensureRequestNode } from '../useRequestNode';

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

it( 'sinks into the interpreter and routes through _shell by target', () => {
	renderHook( () => useRequestNode( 'topologies:save', 'topologies' ) );

	const node = Core.node( 'topologies:save' );
	expect( node ).not.toBeNull();
	expect( node.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
	expect( node.target ).toBe(
		`${ names.CONSOLE_TAP }/${ names.HTTP }/topologies`
	);
} );

it( 'addresses the bare egress when no console Tap is mounted', () => {
	// Off the console the Tap does not exist; a target naming it would not
	// resolve, so the path drops the hop rather than pointing at nothing.
	renderHook( () => useRequestNode( 'topologies:save', 'topologies' ) );
	Core.node( names.CONSOLE_TAP )?.removeNode();
	Core.node( 'topologies:save' )?.removeNode();

	const node = ensureRequestNode( 'vault:probe', 'vault' );

	expect( node.target ).toBe( `${ names.HTTP }/vault` );
} );

// Reset Graph tears the interpreter down under a node mounted at click time;
// adopting it again without re-pointing hands back a node sunk into the dead
// one, and the command goes nowhere.
it( 'ensureRequestNode re-points an adopted node at the LIVE interpreter', () => {
	const first = mountExospine();
	ensureRequestNode( 'aggregator:probe:spoke-91', 'aggregator' );
	const stale = Core.node( names.COMMAND_INTERPRETER );
	first.teardown();
	const second = mountExospine();

	const node = ensureRequestNode( 'aggregator:probe:spoke-91', 'aggregator' );

	expect( node.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
	expect( node.sink ).not.toBe( stale );
	expect( node.target ).toBe(
		`${ names.CONSOLE_TAP }/${ names.HTTP }/aggregator`
	);
	second.teardown();
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

// Two hooks legitimately want the same concern — the console's topology seed
// and the canonical-node read both ask `topologies get`. Whichever unmounted
// first used to take the node with it, and the other's next request died with
// "is not mounted", or its in-flight one with "was removed".
it( 'keeps the node while ANY consumer still holds it', () => {
	const first = renderHook( () =>
		useRequestNode( 'topologies:get', 'topologies' )
	);
	const second = renderHook( () =>
		useRequestNode( 'topologies:get', 'topologies' )
	);

	first.unmount();
	expect( Core.node( 'topologies:get' ) ).not.toBeNull();

	second.unmount();
	expect( Core.node( 'topologies:get' ) ).toBeNull();
} );

it( 'a disabled consumer does not unmount one an enabled consumer holds', () => {
	const holder = renderHook( () =>
		useRequestNode( 'topologies:get', 'topologies' )
	);
	// The console flips to edit mode: its copy goes, the read's stays.
	const { rerender } = renderHook(
		( { enabled } ) =>
			useRequestNode( 'topologies:get', 'topologies', enabled ),
		{ initialProps: { enabled: true } }
	);

	rerender( { enabled: false } );

	expect( Core.node( 'topologies:get' ) ).not.toBeNull();
	holder.unmount();
} );

/**
 * The overlay's `useVaults` claimed `vault:list`, which is also the Vault
 * page's `VaultListView`. Whoever mounted second decided the symptom: the
 * page's `makeNode` threw a name collision, while this hook silently ADOPTED
 * the view and issued `vault list` through it. Adoption exists so two hooks
 * can share ONE concern — not so they can share a name across classes.
 */
test( 'refuses to adopt a node of some other class', () => {
	const { teardown } = mountExospine();
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	interpreter.makeNode( 'Tee', 'vault:list' );

	// The throw escapes through render, so React logs it too.
	const spy = jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	expect( () =>
		renderHook( () => useRequestNode( 'vault:list', 'vault' ) )
	).toThrow( 'useRequestNode: vault:list is already a TeeNode' );
	spy.mockRestore();
	teardown();
} );
