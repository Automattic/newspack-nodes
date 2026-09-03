/**
 * The palette catalog for the graph running in the BROWSER.
 *
 * The HTTP `classes list` verb answers with the PHP substrate's catalog — the
 * classes a WORKER can build. That is the right catalog for editing a topology
 * and for driving a worker over SSE, and `useClassCatalog` serves it. It is the
 * wrong one for the local browser graph and the debug overlay, where
 * `make_node` resolves through `CommandInterpreterNode.includeNodes` and can
 * instantiate nothing outside it. This hook builds a catalog from that table
 * instead, in the shape the same palette, canvas and Inspector already read.
 */

import { useState } from '@wordpress/element';
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { TeeNode } from '../../runtime/tee-node';

/** @typedef {import('../../runtime/command-interpreter-node').NodeClass} NodeClass */

/**
 * The formatter names a `formatter`-typed argument may offer — none, because
 * the browser runtime keeps no registry for PHP's `Formatters::list_names()` to
 * mirror. Shared at module scope, so every caller sees one array identity and a
 * memo over `formatters` never invalidates.
 *
 * @type {string[]}
 */
const NO_FORMATTERS = [];

/**
 * True when `cls` is `base` itself or extends it.
 *
 * `fans_out` and `is_interpreter` are read from the CLASS, as PHP's
 * `Classes_CI` reads them, because no schema declares either. Leaving them off
 * an entry is not a neutral omission: a consumer reading `undefined` takes the
 * branch an explicit false takes, and `draft-interpreter-node` then wires a Tee
 * single-target and drops every edge past the first.
 *
 * @param {NodeClass} base The class to test against.
 * @param {unknown}   cls  A candidate from `includeNodes`, which a plugin
 *                         writes into and so may hold anything.
 * @return {boolean} True when `cls` derives from `base`.
 */
const derivedFrom = ( base, cls ) =>
	'function' === typeof cls && ( cls === base || base.isPrototypeOf( cls ) );

/**
 * The classes the browser's own `make_node` can build, as one palette catalog.
 *
 * Each entry is `{shell_name, category, description, accepts_fill, has_target,
 * fans_out, is_interpreter, arguments}`. The port flags come from the class's
 * `nodeSchema()` — the JS port of PHP `node_schema()` — and SchematicCanvas
 * draws the in and out ports from them; both default to true when the schema
 * omits them, matching PHP `Node::node_schema()`'s base default and the
 * canvas's own `?? true`. `arguments` is what the ADD modal renders constructor
 * fields from.
 *
 * Membership and order mirror `Classes_CI::cmd_list()`: a class is offered only
 * when its schema declares a category that is neither empty nor `Hidden` and
 * raises no `hidden` flag, sorted by `[category, shell_name]`.
 *
 * The table is read once, at first render. `includeNodes` is a per-bundle
 * static each bundle fills at import time (ADR-16), so it is complete before
 * React runs, and a write landing later stays invisible until a remount.
 *
 * Nothing is requested, so `loading` is false and `error` null from the start.
 * Those two and `classes` / `formatters` are every field a consumer reads,
 * which is what lets the console and the overlay swap this catalog for
 * `useClassCatalog`'s the moment a `cwd` points them at a remote graph.
 *
 * @return {{ classes: Array, formatters: Array, loading: boolean, error: null }} The JS catalog in the shape useClassCatalog's consumers read.
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
			// Skip a Hidden category, no category at all, or the hidden flag.
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
				// A fan-out target is a LIST; the editor renders chips.
				fans_out: derivedFrom( TeeNode, cls ),
				// An interpreter is addressed directly; others go via :config.
				is_interpreter: derivedFrom( CommandInterpreterNode, cls ),
				// The ADD modal renders a field per declared ctor argument.
				arguments: schema.arguments ?? [],
			} ) )
			// The [category, shell_name] order PHP's usort produces.
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
