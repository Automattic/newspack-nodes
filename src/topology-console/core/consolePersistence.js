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
import { Core } from '../../runtime/core';
import { REDACTED } from '../../runtime/node';
import { readStorage, writeStorage } from '../../shared/utils/storage';

const NS = 'newspack-nodes:console:';
const TRANSCRIPT_KEY = `${ NS }transcript`;
// Separate key so hub worker-realm and overlay transcripts never clobber.
const HUB_TRANSCRIPT_KEY = `${ NS }hub-transcript`;
const HISTORY_KEY = `${ NS }history`;
const DEBUG_LEVEL_KEY = `${ NS }debug-level`;
const DEBUG_STATE_KEY = `${ NS }debug-state`;

// The transcript's own cap is Dumper's TRANSCRIPT_MAX, so a restore agrees.
const MAX_PERSISTED_HISTORY = 100;

function readArray( key ) {
	const raw = readStorage( key );
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
	const n = parseInt( readStorage( key ) ?? '', 10 );
	return Number.isFinite( n ) ? n : 0;
}

// All three token shapes in ONE pass: chained passes ate each other.
const ARG_TOKEN =
	/(['"])(--[\w.-]+=)(?:\\.|(?!\1)[^\\])*\1|(--[\w.-]+=)('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\S*)/g;

const JSON_PAIR = /("[\w.-]+"\s*:\s*)"(?:\\.|[^"\\])*"/g;

/**
 * Mask credential values in a console line. Two shapes carry them: a
 * `--auth_password=…` argument token (what the Vault UI sends, what the REPL
 * echoes verbatim, and what the history recalls), and a `"password":"…"` pair
 * inside a rendered command payload. The name survives so the line still
 * reads; only the value goes.
 *
 * A value ends where its QUOTING says it ends, not at the first space. A
 * passphrase makes `Node::serialize_args()` quote the whole token —
 * `'--auth_password=correct horse battery'` — and an earlier value matcher
 * that stopped at whitespace left everything past the first word sitting in
 * localStorage beside the redaction marker. Both quote characters appear:
 * serialize_args emits single quotes, the JSON payload shape double. The
 * masked line stays quoted as it arrived, so history recalls it replayable.
 *
 * @param {string} text A console line.
 * @return {string} The line with credential values masked.
 */
function redactSecrets( text ) {
	if ( 'string' !== typeof text ) {
		return text;
	}
	const secret = ( name ) => Core.isSecretProperty( name );
	return text
		.replace( ARG_TOKEN, ( all, quote, wrapped, lead, value ) => {
			if ( wrapped ) {
				return secret( wrapped )
					? `${ quote }${ wrapped }${ REDACTED }${ quote }`
					: all;
			}
			if ( ! secret( lead ) ) {
				return all;
			}
			const q = /^['"]/.test( value ) ? value[ 0 ] : '';
			return `${ lead }${ q }${ REDACTED }${ q }`;
		} )
		.replace( JSON_PAIR, ( all, lead ) =>
			secret( lead ) ? `${ lead }"${ REDACTED }"` : all
		);
}

function saveTranscriptTo( key, entries ) {
	const safe = ( entries || [] )
		.slice( -TRANSCRIPT_MAX )
		.map( ( e ) =>
			e && 'string' === typeof e.text
				? { ...e, text: redactSecrets( e.text ) }
				: e
		);
	writeStorage( key, JSON.stringify( safe ) );
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
 * Persist the debug overlay's transcript, newest TRANSCRIPT_MAX
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
 * Persist the REPL's command history, newest MAX_PERSISTED_HISTORY lines only,
 * masked the same way the transcript is — the typed line and its transcript
 * echo are the same keystroke, so one of the two masked was no mask at all.
 *
 * @param {string[]} entries Command lines, oldest first.
 */
export function saveHistory( entries ) {
	writeStorage(
		HISTORY_KEY,
		JSON.stringify(
			( entries || [] )
				.slice( -MAX_PERSISTED_HISTORY )
				.map( redactSecrets )
		)
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
	writeStorage( DEBUG_LEVEL_KEY, String( Number( level ) || 0 ) );
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
	writeStorage( DEBUG_STATE_KEY, String( Number( state ) || 0 ) );
}
