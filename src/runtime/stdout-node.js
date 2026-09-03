/**
 * Stdout: the browser's bare terminal sink. It coerces a message VALUE to a
 * string and hands it to the stream the host owns, adding nothing — no
 * newline, no framing, no branch on message type — so whatever a Dumper or an
 * interpreter reply already rendered arrives unchanged. Rendering belongs
 * upstream: put a Dumper in front to turn a struct into a line.
 *
 * Port of PHP `Stdout_Node`. The browser's "stream" is whatever the host hands
 * over: an object with `write( text )`. The debug overlay and the topology
 * console both hand over the Dumper's `appendText`, which cuts those bytes into
 * transcript lines.
 *
 * Shell builtins fill this node directly, so their output BYPASSES `_output` —
 * the Dumper renders Messages, and `print` is text, not a Message to render.
 *
 * `fill()` is a terminal: it writes instead of forwarding and never chains to
 * `Node.fill()`, so it reads no sink and the producer cannot observe what the
 * write did (ADR-13).
 */

import { Node } from './node';
import { VALUE } from './message';

/**
 * Coerce a mixed Message field the way PHP's `(string)` cast does: null and
 * undefined give the empty string, an array gives `Array`, an object goes
 * through its `toString`, and a scalar gives its string form.
 *
 * The PHP node reads its VALUE through `Core::as_string()`, which answers ''
 * for every non-scalar, so the two ports agree on scalars alone. Neither
 * prints anything a reader can use for a struct — that is the Dumper's job.
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
	 * Take ownership of the output stream. Both consoles hand over the Dumper's
	 * `appendText`, and tests hand over a collector. No stream writes nowhere
	 * rather than throwing, so a node mounted ahead of its host stays harmless.
	 *
	 * @param {?{write?: (text: string) => void}} stdout Stream to write to.
	 */
	constructor( stdout = null ) {
		super();
		this.stdout = stdout;
	}

	/**
	 * Write the message VALUE and stop. Every message counts, including one
	 * whose VALUE renders to nothing, so `ls -c` reports what ARRIVED.
	 *
	 * @param {Array} message Positional Message; VALUE is the text.
	 */
	fill( message ) {
		this.counter++;
		this.write( coerceString( message[ VALUE ] ) );
	}

	/**
	 * Write seam: the one call on the data path, and the only one a subclass
	 * has to intercept. PHP's `TTY_Out_Node` overrides it to wipe and redraw
	 * around a live prompt, which is why the coercion and the counter sit in
	 * `fill()` — an override inherits both instead of repeating them.
	 *
	 * @param {string} text Bytes to write, exactly as they should appear.
	 */
	write( text ) {
		this.stdout?.write?.( text );
	}

	/**
	 * Console-palette entry. `Hidden` keeps the class out of the catalog: a
	 * terminal writer is wired by the REPL host, never dragged onto a canvas.
	 * `has_target` is false because `fill()` writes rather than forwards, so
	 * the canvas draws no out-port; the omitted `accepts_fill` defaults to
	 * true, which is the in-port.
	 *
	 * @return {Object} The node schema.
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
