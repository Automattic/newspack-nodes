import { useState, useEffect } from '@wordpress/element';
import { mountExospine } from './exospine';

// Build the node graph in a useState lazy-initializer, before children render.
export function useNodeGraph( build ) {
	const [ spine ] = useState( () => mountExospine( build ) );
	useEffect( () => spine.teardown, [ spine ] );
	return spine;
}
