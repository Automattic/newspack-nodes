/**
 * Regression: tab completion must survive Reset Graph.
 *
 * useDebugRepl rebuilds `_completion` (a fresh CompletionNode) on every
 * graph-generation bump. The DebugOverlay subscribes to its published
 * candidates via `useNodeState( _completion, 'candidates' )`, which re-binds
 * only when the resolved node instance changes between renders. If the rebuild
 * doesn't force a re-render, the subscription stays bound to the removed old
 * node and every Tab afterwards fires at a node nobody is listening to —
 * completion silently dies after the first Reset Graph.
 */

import { render, act } from '@testing-library/react';
import { useMemo } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { ShellNode } from '../../runtime/shell-node';
import { useDebugRepl } from '../useDebugRepl';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';

beforeEach( () => Core.reset() );

function Harness() {
	const shell = useMemo( () => {
		const s = new ShellNode();
		s.path = '';
		s.sink = Core.node( names.COMMAND_INTERPRETER );
		return s;
	}, [] );
	useDebugRepl( true, shell );
	const completion = useNodeState( names.COMPLETION, 'candidates' );
	return <div>{ completion ? String( completion.seq ) : 'none' }</div>;
}

// React (useNodeState) listeners on a node's candidates — proof of binding.
function reactListenerCount( node ) {
	return Object.keys( node?.registrations?.candidates || {} ).filter( ( k ) =>
		k.startsWith( 'react/' )
	).length;
}

it( 'tab completion survives Reset Graph: useNodeState re-binds to the rebuilt _completion', () => {
	mountExospine();
	render( <Harness /> );

	// Initial mount: the subscription bound to the freshly-mounted _completion.
	const first = Core.node( names.COMPLETION );
	expect( first ).not.toBeNull();
	expect( reactListenerCount( first ) ).toBeGreaterThan( 0 );

	// Reset Graph: useDebugRepl rebuilds _completion as a new instance.
	act( () => Core.bumpGraphGeneration() );
	const second = Core.node( names.COMPLETION );
	expect( second ).not.toBe( first ); // a real rebuild happened

	// The subscription MUST follow the swap onto the new node.
	expect( reactListenerCount( second ) ).toBeGreaterThan( 0 );
} );
