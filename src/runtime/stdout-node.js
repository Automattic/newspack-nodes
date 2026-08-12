/**
 * Stdout: bare terminal sink — writes a message VALUE to its stream.
 *
 * Port of PHP `Stdout_Node`. The browser's "stream" is whatever the host hands
 * over: an object with `write( text )`. Shell builtins fill this directly so
 * their output BYPASSES `_output` — the Dumper renders Messages, and `print`
 * is text, not a Message to render.
 */

import { Node } from './node';
import { VALUE } from './message';

/**
 * Coerce a mixed Message field to string, reproducing PHP's `(string)` cast
 * (null→'', scalar→its string form, array→'Array'). Mirrors
 * `Stdout_Node::coerce_string` so both ends print the same thing.
 *
 * @param {*} v Raw Message field.
 * @return {string} Printable text.
 */
function coerceString( v ) {
	if ( 'string' === typeof v ) {
		return v;
	}
	if ( null === v || undefined === v ) {
		return '';
	}
	if ( Array.isArray( v ) ) {
		return 'Array';
	}
	if ( 'object' === typeof v ) {
		return 'function' === typeof v.toString ? String( v ) : '';
	}
	return String( v );
}

/**
 * The `_stdout` node: writes a Message VALUE to the stream the host owns.
 */
export class StdoutNode extends Node {
	/**
	 * @param {Object|null} stdout Stream with `write( text )`; the host assigns
	 *                             the transcript writer, tests a collector.
	 */
	constructor( stdout = null ) {
		super();
		this.stdout = stdout;
	}

	/**
	 * @param {Array} message Positional Message; VALUE is the text.
	 */
	fill( message ) {
		this.counter++;
		this.write( coerceString( message[ VALUE ] ) );
	}

	/**
	 * Write seam. Hands the text to the owned stream. A terminal-aware
	 * subclass overrides this, as PHP's TTY_Out_Node does.
	 *
	 * @param {string} text Text to emit.
	 */
	write( text ) {
		this.stdout?.write?.( text );
	}

	/**
	 * @return {Object} Palette/introspection schema; hidden, and not buildable.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Bare terminal sink — writes a message VALUE to its stream.',
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
