import { useState, useEffect } from '@wordpress/element';
import { mountExospine } from './exospine';

// Build the node graph BEFORE the component renders its children: the spine is
// constructed in a useState lazy-initializer (render-phase, idempotent), so the
// canvas only ever renders over a complete graph — never the partial-graph race
// a useEffect-built graph produced. Teardown rides a cleanup-only effect.
export function useNodeGraph( build ) {
	const [ spine ] = useState( () => mountExospine( build ) );
	useEffect( () => spine.teardown, [ spine ] );
	return spine;
}
