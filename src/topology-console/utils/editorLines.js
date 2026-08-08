/**
 * editorLines — turning an Inspector edit into the TSL line that expresses it.
 *
 * The Inspector hands back a whole positional array with one slot changed. The
 * draft holds raw SPANS, quote characters intact, because the quote type
 * carries interpolation semantics. So only the slot the operator actually
 * edited is a plain value needing quotes; re-quoting the rest would add a
 * layer of quoting on every edit.
 *
 * Holes matter as much as values: positional slots are indexed, so an unset
 * earlier argument has to be written, not skipped, or the edited value lands
 * in the wrong position.
 */

import { serializeDraftArg, tokenize } from '../../runtime/shell-node';
import { applyDefaults, trimTrailingEmpties } from './tslArgs';

/**
 * Schema defaults fill an unset EARLIER slot. An empty token would not do:
 * PHP's `parse_schema_args` tests `isset()`, and `''` is set, so the declared
 * default is skipped and an int argument coerces to 0.
 *
 * @param {string} id      Node name.
 * @param {Array}  args    The Inspector's positional array (may be sparse).
 * @param {Array}  current The node's existing arguments, as spans.
 * @param {Array}  spec    Schema arg list (each entry may carry `default`).
 * @return {string} A `set_arguments` statement.
 */
export function setArgumentsLine( id, args, current = [], spec = null ) {
	const filled = trimTrailingEmpties( applyDefaults( args, spec ) );
	const tokens = [];
	for ( let i = 0; i < filled.length; i++ ) {
		const value = filled[ i ];
		// Untouched: the Inspector renders tokenized, so compare the VALUE.
		const span = current[ i ];
		if (
			undefined !== value &&
			undefined !== span &&
			value === tokenize( String( span ) ).join( ' ' )
		) {
			tokens.push( span );
			continue;
		}
		tokens.push( serializeDraftArg( value ?? '' ) );
	}
	return [ 'set_arguments', id, ...tokens ].join( ' ' );
}

/**
 * Whether a verb may be offered as CONFIGURATION in the topology editor.
 *
 * The editor renders each configurable verb as a checkbox, and ticking it
 * serializes `cmd <node>:config <verb>` into the .tsl — so the verb runs on
 * every worker boot, forever. That is right for a setting and wrong for an
 * action: `purge` would discard every in-flight request on each restart.
 * A verb declaring `action` stays a verb, invocable on a live node from the
 * runtime panel and the REPL; it is only withheld from the persisted set.
 * `hidden` is the older, stronger flag — schema plumbing, shown nowhere.
 *
 * @param {Object} spec A node_schema `commands[]` entry.
 * @return {boolean} True when the verb belongs in the config editor.
 */
export function isConfigurableVerb( spec ) {
	return ! spec.hidden && ! spec.action;
}

/**
 * Whether a verb on this class is written bare or through `:config`.
 *
 * What the FILE said wins — that is what the operator wrote. A verb the
 * Inspector just added has no recorded form, so the class decides, exactly as
 * the emitted line used to.
 *
 * @param {Object} invocation The verb invocation.
 * @param {Object} schema     The class's catalog entry.
 * @return {boolean} True when the verb routes through the config sidecar.
 */
export function verbUsesConfig( invocation, schema ) {
	if ( undefined !== invocation.viaConfig ) {
		return invocation.viaConfig;
	}
	return ! schema?.is_interpreter;
}

/**
 * A verb invocation's arguments, defaults filled and trailing empties dropped.
 *
 * The Inspector's toggle seeds one empty slot per declared argument. Written
 * out bare, those are SET as far as PHP's `parse_schema_args` is concerned, so
 * the declared default is skipped and an int argument coerces to 0 — the same
 * trap `setArgumentsLine` closes for constructor arguments.
 *
 * @param {Array} args The invocation's arguments.
 * @param {Array} spec The verb's schema arg list.
 * @return {Array} Arguments as they should be written.
 */
export function verbInvocationArgs( args, spec ) {
	// A schema default may be a number; invocation args are spans.
	return trimTrailingEmpties( applyDefaults( args ?? [], spec ) ).map(
		( a ) => String( a )
	);
}
