/**
 * localStorage persistence for the console's session state [87]: the recent
 * transcript, command history, debug_level, and the browser's debug_state.
 *
 * Every accessor is try/catch-guarded so private-mode / disabled / quota-full
 * storage degrades to in-memory defaults rather than throwing, and corrupt
 * stored values fall back to the same defaults. Shared by the topology console
 * (ReplFooter history) and the debug overlay (transcript / debug_level /
 * debug_state), so it lives in topology-console/core where both can import it.
 */

import { TRANSCRIPT_MAX } from '../../runtime/dumper-node';

const NS = 'newspack-nodes:console:';
const TRANSCRIPT_KEY = `${ NS }transcript`;
// Separate key so hub worker-realm and overlay transcripts never clobber.
const HUB_TRANSCRIPT_KEY = `${ NS }hub-transcript`;
const HISTORY_KEY = `${ NS }history`;
const DEBUG_LEVEL_KEY = `${ NS }debug-level`;
const DEBUG_STATE_KEY = `${ NS }debug-state`;

// Recent-only caps; transcript reuses Dumper TRANSCRIPT_MAX so restore agrees.
const MAX_PERSISTED_TRANSCRIPT = TRANSCRIPT_MAX;
const MAX_PERSISTED_HISTORY = 100;

function read( key ) {
	try {
		return typeof window === 'undefined'
			? null
			: window.localStorage.getItem( key );
	} catch ( e ) {
		return null;
	}
}

function write( key, value ) {
	try {
		if ( typeof window !== 'undefined' ) {
			window.localStorage.setItem( key, value );
		}
	} catch ( e ) {
		// Storage unavailable / full — persistence is best-effort, never fatal.
	}
}

function readArray( key ) {
	const raw = read( key );
	if ( null === raw ) {
		return [];
	}
	try {
		const value = JSON.parse( raw );
		return Array.isArray( value ) ? value : [];
	} catch ( e ) {
		return [];
	}
}

function readInt( key ) {
	const n = parseInt( read( key ) ?? '', 10 );
	return Number.isFinite( n ) ? n : 0;
}

// Mirrors PHP Core::SECRET_NAME_PATTERNS; keep the two lists in step.
const SECRET_NAME_PATTERNS = [
	'password',
	'passwd',
	'secret',
	'token',
	'credential',
	'api_key',
	'apikey',
	'private_key',
];

const REDACTED = '<redacted>';

/**
 * Mask credential values in a transcript line. Two shapes carry them: a
 * `--auth_password=…` argument token (what the Vault UI sends, and what the
 * REPL echoes verbatim), and a `"password":"…"` pair inside a rendered command
 * payload. The name survives so the line still reads; only the value goes.
 *
 * A value ends where its QUOTING says it ends, not at the first space. A
 * passphrase makes `Node::serialize_args()` quote the whole token —
 * `'--auth_password=correct horse battery'` — and an earlier value matcher
 * that stopped at whitespace left everything past the first word sitting in
 * localStorage beside the redaction marker. Both quote characters appear:
 * serialize_args emits single quotes, the JSON payload shape double.
 *
 * @param {string} text A transcript line.
 * @return {string} The line with credential values masked.
 */
function redactSecrets( text ) {
	if ( 'string' !== typeof text ) {
		return text;
	}
	const secret = ( name ) =>
		SECRET_NAME_PATTERNS.some( ( n ) => name.toLowerCase().includes( n ) );
	return (
		text
			// Whole token quoted by serialize_args: '--key=value with spaces'.
			.replace(
				/(['"])(--[\w.-]+=)(?:\\.|(?!\1)[^\\])*\1/g,
				( all, quote, lead ) =>
					secret( lead )
						? `${ quote }${ lead }${ REDACTED }${ quote }`
						: all
			)
			// Value quoted on its own: --key="value with spaces".
			.replace(
				/(--[\w.-]+=)(['"])(?:\\.|(?!\2)[^\\])*\2/g,
				( all, lead, quote ) =>
					secret( lead )
						? `${ lead }${ quote }${ REDACTED }${ quote }`
						: all
			)
			// Bare token: --key=value, ending at whitespace.
			.replace( /(--[\w.-]+=)\S*/g, ( all, lead ) =>
				secret( lead ) ? `${ lead }${ REDACTED }` : all
			)
			.replace( /("[\w.-]+"\s*:\s*)"(?:\\.|[^"\\])*"/g, ( all, lead ) =>
				secret( lead ) ? `${ lead }"${ REDACTED }"` : all
			)
	);
}

function saveTranscriptTo( key, entries ) {
	const safe = ( entries || [] )
		.slice( -MAX_PERSISTED_TRANSCRIPT )
		.map( ( e ) =>
			e && 'string' === typeof e.text
				? { ...e, text: redactSecrets( e.text ) }
				: e
		);
	write( key, JSON.stringify( safe ) );
}

/**
 * Restore the debug overlay's transcript from the last session. Feed the result
 * to `Dumper_Node.restore()`, which takes the entries as already stamped.
 *
 * @return {Object[]} Stamped transcript entries, oldest first; empty when
 *                    nothing is stored, storage is unavailable, or the stored
 *                    value is corrupt.
 */
export function loadTranscript() {
	return readArray( TRANSCRIPT_KEY );
}

/**
 * Persist the debug overlay's transcript, newest MAX_PERSISTED_TRANSCRIPT
 * entries only, with credential values masked.
 *
 * @param {Object[]} entries Stamped transcript entries, oldest first.
 */
export function saveTranscript( entries ) {
	saveTranscriptTo( TRANSCRIPT_KEY, entries );
}

/**
 * Restore the topology console's hub transcript — the worker-realm lines, kept
 * under their own key so the overlay's transcript never clobbers them.
 *
 * @return {Object[]} Stamped transcript entries, oldest first; empty when
 *                    nothing is stored or the stored value is corrupt.
 */
export function loadHubTranscript() {
	return readArray( HUB_TRANSCRIPT_KEY );
}

/**
 * Persist the topology console's hub transcript under its own key, capped and
 * redacted the same way the overlay transcript is.
 *
 * @param {Object[]} entries Stamped transcript entries, oldest first.
 */
export function saveHubTranscript( entries ) {
	saveTranscriptTo( HUB_TRANSCRIPT_KEY, entries );
}

/**
 * Restore the REPL's command history — what ReplFooter's up/down arrows recall.
 *
 * @return {string[]} Command lines, oldest first; empty when nothing is stored
 *                    or the stored value is corrupt.
 */
export function loadHistory() {
	return readArray( HISTORY_KEY );
}

/**
 * Persist the REPL's command history, newest MAX_PERSISTED_HISTORY lines only.
 *
 * @param {string[]} entries Command lines, oldest first.
 */
export function saveHistory( entries ) {
	write(
		HISTORY_KEY,
		JSON.stringify( ( entries || [] ).slice( -MAX_PERSISTED_HISTORY ) )
	);
}

/**
 * Restore the transcript's rendering verbosity, so a reload keeps whatever the
 * user last selected.
 *
 * @return {number} The stored debug level, 0 when unset or unparseable.
 */
export function loadDebugLevel() {
	return readInt( DEBUG_LEVEL_KEY );
}

/**
 * Persist the transcript's rendering verbosity.
 *
 * @param {number} level Debug level; anything non-numeric stores 0.
 */
export function saveDebugLevel( level ) {
	write( DEBUG_LEVEL_KEY, String( Number( level ) || 0 ) );
}

/**
 * Restore the interpreter's `debug_state` — what the REPL's `trace` builtin
 * mutates — so tracing survives a reload.
 *
 * @return {number} The stored debug state, 0 when unset or unparseable.
 */
export function loadDebugState() {
	return readInt( DEBUG_STATE_KEY );
}

/**
 * Persist the interpreter's `debug_state`.
 *
 * @param {number} state Debug state; anything non-numeric stores 0.
 */
export function saveDebugState( state ) {
	write( DEBUG_STATE_KEY, String( Number( state ) || 0 ) );
}
