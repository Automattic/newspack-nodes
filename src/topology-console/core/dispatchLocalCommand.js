/**
 * Apply a `parsed.kind === 'local'` REPL builtin (clear/echo/status/debug_level/
 * show_parse) — the no-SSE, no-worker-pivot dispatch shared by the debug overlay
 * and the topology console. Pure: effects flow through the injected `append`
 * (one transcript entry) / `clear` (wipe transcript) / `debugLevelRef` (mutable).
 *
 * @param {Object}   args
 * @param {Object}   args.parsed        Shell.parse result.
 * @param {Function} args.append        Append one transcript entry.
 * @param {Function} args.clear         Clear the transcript.
 * @param {Object}   args.debugLevelRef Ref holding the current debug level.
 * @return {boolean} True when a local command was handled; false otherwise.
 */
export function dispatchLocalCommand( {
	parsed,
	append,
	clear,
	debugLevelRef,
} ) {
	if ( 'local' !== parsed.kind ) {
		return false;
	}
	if ( 'clear' === parsed.name ) {
		clear();
	} else if ( 'debug_level' === parsed.name ) {
		// Substrate Shell semantics: no-arg toggles 0/1, numeric clamps 0..2.
		if ( null === parsed.level ) {
			debugLevelRef.current = debugLevelRef.current > 0 ? 0 : 1;
		} else {
			debugLevelRef.current = Math.max( 0, Math.min( 2, parsed.level ) );
		}
		append( {
			kind: 'info',
			text: `debug_level: ${ debugLevelRef.current }`,
		} );
	} else if ( 'echo' === parsed.name ) {
		append( { kind: 'recv', text: parsed.text } );
	} else if ( 'status' === parsed.name ) {
		for ( const line of parsed.lines ) {
			append( { kind: 'recv', text: line } );
		}
	} else if ( 'show_parse' === parsed.name ) {
		append( {
			kind: 'info',
			text: `show_parse: ${ parsed.on ? 'on' : 'off' }`,
		} );
	}
	return true;
}
