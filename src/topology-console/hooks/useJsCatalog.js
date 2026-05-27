import { useEffect, useState } from '@wordpress/element';
import { CommandInterpreter } from '../../runtime/command_interpreter';

/**
 * Build a class catalog from the JS-side `CommandInterpreter.includeNodes`
 * registry — the only set `make_node` can actually instantiate in the
 * browser's Core. The HTTP `classes.list` verb returns the PHP substrate's
 * catalog (Aggregator_CI, Partition, Topic, Performance_CI, …) which is
 * what `useClassCatalog` exposes; that's right for editing a topology
 * (PHP workers) and for talking to a worker over SSE, but wrong for the
 * LOCAL browser graph and for the debug overlay (both run JS-side).
 *
 * Returns the same shape `useClassCatalog` does so GraphView / Palette
 * consume them interchangeably: `{ classes, formatters, loading, error }`,
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
