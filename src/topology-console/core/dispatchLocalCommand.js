import { resolveSkin, formatSkinList } from './skinCommands';

/**
 * Apply a `parsed.kind === 'local'` REPL builtin (clear/print/status/debug_level/
 * show_parse/set_skin/list_skins) — the no-SSE, no-attached-worker dispatch shared
 * by the debug overlay and the topology console. Pure: effects flow through the
 * injected `append` (one transcript entry) / `clear` (wipe transcript) /
 * `debugLevelRef` (mutable) / `setSkin` (apply a skin slug).
 *
 * @param {Object}   args
 * @param {Object}   args.parsed         Shell.parse result.
 * @param {Function} args.append         Append one transcript entry.
 * @param {Function} args.clear          Clear the transcript.
 * @param {Object}   args.debugLevelRef  Ref holding the current debug level.
 * @param {Function} [args.onDebugLevel] Called with the new level when debug_level changes (persistence [87]).
 * @param {Function} [args.setSkin]      Apply a resolved skin slug (set_skin).
 * @param {Array}    [args.skins]        THEMES registry for set_skin/list_skins.
 * @param {string}   [args.currentSkin]  Active skin slug, marked by list_skins.
 * @return {boolean} True when a local command was handled; false otherwise.
 */
export function dispatchLocalCommand( {
	parsed,
	append,
	clear,
	debugLevelRef,
	onDebugLevel = () => {},
	setSkin = () => {},
	skins = [],
	currentSkin = '',
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
		onDebugLevel( debugLevelRef.current );
		append( {
			kind: 'info',
			text: `debug_level: ${ debugLevelRef.current }`,
		} );
	} else if ( 'print' === parsed.name ) {
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
	} else if ( 'list_skins' === parsed.name ) {
		for ( const line of formatSkinList( skins, currentSkin ) ) {
			append( { kind: 'recv', text: line } );
		}
	} else if ( 'set_skin' === parsed.name ) {
		const slug = resolveSkin( parsed.skin, skins );
		if ( null === slug ) {
			append( {
				kind: 'error',
				text: `set_skin: unknown skin '${ parsed.skin }' (try list_skins)`,
			} );
		} else {
			setSkin( slug );
			const label = skins.find( ( s ) => s.slug === slug )?.label ?? slug;
			append( { kind: 'info', text: `skin: ${ label }` } );
		}
	}
	return true;
}
