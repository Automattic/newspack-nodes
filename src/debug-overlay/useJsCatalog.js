import { useEffect, useState } from '@wordpress/element';
import { CommandInterpreter } from '../runtime/command_interpreter';

/**
 * Build the overlay's class catalog from the JS-side
 * `CommandInterpreter.includeNodes` registry — the only set `make_node`
 * can actually instantiate in this realm. The HTTP `classes.list` verb
 * returns the PHP substrate's catalog (Aggregator_CI, Partition, Topic,
 * Performance_CI, …), which dragged into the overlay would no-op since
 * none of those classes exist in the JS runtime.
 *
 * Returns the same shape `useClassCatalog` does so GraphView / Palette
 * consume it interchangeably: `{ classes, formatters, loading, error }`,
 * with each class an `{ shell_name, category, description }`.
 *
 * @return {{ classes: Array, formatters: Array, loading: boolean, error: null }} The JS catalog in the same shape useClassCatalog produces.
 */
export function useJsCatalog() {
	const [ classes ] = useState( () => {
		const table = CommandInterpreter.includeNodes || {};
		return Object.keys( table )
			.filter( ( name ) => name !== 'Hook' && name !== 'Router' )
			.sort()
			.map( ( name ) => ( {
				shell_name: name,
				category: 'Available',
				description: '',
			} ) );
	} );
	// Stable identity for the React tree on re-renders.
	useEffect( () => {}, [] );
	return { classes, formatters: [], loading: false, error: null };
}
