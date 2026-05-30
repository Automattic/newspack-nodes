import { useEffect, useState } from '@wordpress/element';
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';

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
 * with each class an `{ shell_name, category, description, accepts_fill,
 * has_target }`. The port flags are read from each node's `nodeSchema()`
 * (the JS port of PHP `node_schema()`); SchematicCanvas draws the in/out
 * ports from them. Both default to `true` when the schema omits them —
 * matching PHP `Node::node_schema()`'s base default and the canvas's own
 * `?? true` fallback.
 *
 * @return {{ classes: Array, formatters: Array, loading: boolean, error: null }} The JS catalog in the same shape useClassCatalog produces.
 */
export function useJsCatalog() {
	const [ classes ] = useState( () => {
		const table = CommandInterpreterNode.includeNodes || {};
		return Object.keys( table )
			.filter(
				( name ) =>
					name !== 'Hook' &&
					name !== 'Router' &&
					name !== 'CommandInterpreter'
			)
			.sort()
			.map( ( name ) => {
				const schema = table[ name ]?.nodeSchema?.() || {};
				return {
					shell_name: name,
					category: 'Available',
					description: '',
					accepts_fill: schema.accepts_fill ?? true,
					has_target: schema.has_target ?? true,
				};
			} );
	} );
	// Stable identity for the React tree on re-renders.
	useEffect( () => {}, [] );
	return { classes, formatters: [], loading: false, error: null };
}
