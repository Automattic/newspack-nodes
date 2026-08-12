import { useState } from '@wordpress/element';
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { TeeNode } from '../../runtime/tee-node';

const NO_FORMATTERS = [];

// PHP derives both flags from the CLASS (Classes_CI), not the schema.
const derivedFrom = ( base, cls ) =>
	'function' === typeof cls && ( cls === base || base.isPrototypeOf( cls ) );

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
 * has_target, fans_out, is_interpreter }`. The port flags are read from each
 * node's `nodeSchema()` (the JS port of PHP `node_schema()`); SchematicCanvas
 * draws the in/out ports from them. Both default to `true` when the schema
 * omits them — matching PHP `Node::node_schema()`'s base default and the
 * canvas's own `?? true` fallback. `fans_out` and `is_interpreter` are derived
 * from the class, as PHP derives them, because a consumer reading them
 * `undefined` takes the same branch as an explicit false.
 *
 * @return {{ classes: Array, formatters: Array, loading: boolean, error: null }} The JS catalog in the same shape useClassCatalog produces.
 */
export function useJsCatalog() {
	const [ catalog ] = useState( () => {
		const table = CommandInterpreterNode.includeNodes || {};
		const classes = Object.keys( table )
			.map( ( name ) => ( {
				name,
				cls: table[ name ],
				schema: table[ name ]?.nodeSchema?.() || {},
			} ) )
			// Skip Hidden/empty/flagged classes (mirrors PHP Classes_CI).
			.filter( ( { schema } ) => {
				const category = schema.category ?? '';
				return (
					'Hidden' !== category && '' !== category && ! schema.hidden
				);
			} )
			.map( ( { name, cls, schema } ) => ( {
				shell_name: name,
				category: schema.category,
				description: schema.description ?? '',
				accepts_fill: schema.accepts_fill ?? true,
				has_target: schema.has_target ?? true,
				// Fan-out (target LIST) → multi-chip editor + tail.
				fans_out: derivedFrom( TeeNode, cls ),
				// Interpreter node → bare target, else <name>:config.
				is_interpreter: derivedFrom( CommandInterpreterNode, cls ),
				// Ctor args drive ADD modal (mirrors PHP Classes_CI).
				arguments: schema.arguments ?? [],
			} ) )
			// Match PHP usort: order by [category, shell_name].
			.sort(
				( a, b ) =>
					a.category.localeCompare( b.category ) ||
					a.shell_name.localeCompare( b.shell_name )
			);
		return {
			classes,
			formatters: NO_FORMATTERS,
			loading: false,
			error: null,
		};
	} );
	return catalog;
}
