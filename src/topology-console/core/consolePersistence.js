/**
 * localStorage persistence for the console's session state [87]: the debug
 * overlay's transcript, the topology console's hub transcript, the REPL command
 * history, `debug_level`, and the interpreter's `debug_state`.
 *
 * Every read and write goes through `readStorage` / `writeStorage`, so
 * private-mode, disabled or quota-full storage degrades to in-memory defaults
 * rather than throwing, and a corrupt stored value falls back to those same
 * defaults. Credential values are masked on the way IN: what a browser stores
 * has no expiry, and the server never hands a stored password back
 * (`Vault_CI_Node::public_shape` strips it).
 *
 * Both REPLs share this module — the topology console for the hub transcript
 * and ReplFooter's history, the debug overlay for the transcript, the debug
 * level and the debug state — so it lives in `topology-console/core`, where
 * each can import it.
 */

import { TRANSCRIPT_MAX } from '../../runtime/dumper-node';
import { Core } from '../../runtime/core';
import { REDACTED } from '../../runtime/node';
import { readStorage, writeStorage } from '../../shared/utils/storage';

/** Namespace prefix on every key this module owns. */
const NS = 'newspack-nodes:console:';

/** Where the debug overlay's transcript is stored. */
const TRANSCRIPT_KEY = `${ NS }transcript`;

/**
 * Where the topology console's hub transcript is stored. Its own key, so the
 * worker-realm lines and the overlay's transcript never clobber each other.
 */
const HUB_TRANSCRIPT_KEY = `${ NS }hub-transcript`;

/** Where the REPL's command history is stored. */
const HISTORY_KEY = `${ NS }history`;

/** Where the transcript's rendering verbosity is stored. */
const DEBUG_LEVEL_KEY = `${ NS }debug-level`;

/** Where the interpreter's `debug_state` is stored. */
const DEBUG_STATE_KEY = `${ NS }debug-state`;

/**
 * Most command lines a persisted history keeps. A transcript takes its cap from
 * Dumper's `TRANSCRIPT_MAX` instead, so a restored transcript holds exactly
 * what the live ring would.
 */
const MAX_PERSISTED_HISTORY = 100;

/**
 * Read a JSON array from storage.
 *
 * Absent, unreadable, unparseable and non-array values all answer with an empty
 * array — a caller restoring a transcript or a history has one
 * nothing-to-restore branch for the four.
 *
 * @param {string} key Storage key.
 * @return {Array} The stored array, empty when there is nothing usable.
 */
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

/**
 * Read an integer from storage.
 *
 * @param {string} key Storage key.
 * @return {number} The stored integer, 0 when unset or unparseable.
 */
function readInt( key ) {
	const n = parseInt( readStorage( key ) ?? '', 10 );
	return Number.isFinite( n ) ? n : 0;
}

/**
 * Matches an argument token in each of the three shapes a value arrives in:
 * the whole token quoted (`'--k=a b'`), the value quoted (`--k="a b"`), and a
 * bare value running to the next space. One alternation covers all three
 * because a second pass re-matches the redaction the first one wrote and eats
 * its closing quote.
 */
const ARG_TOKEN =
	/(['"])(--[\w.-]+=)(?:\\.|(?!\1)[^\\])*\1|(--[\w.-]+=)('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\S*)/g;

/** Matches a `"name": "value"` pair inside a rendered JSON command payload. */
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
 * `'--auth_password=correct horse battery'` — so a matcher stopping at
 * whitespace leaves everything past the first word sitting in localStorage
 * beside the redaction marker. Both quote characters appear: serialize_args
 * emits single quotes, the JSON payload shape double. The masked line stays
 * quoted as it arrived, so history recalls it replayable.
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

/**
 * Persist a transcript under one key: the newest `TRANSCRIPT_MAX` entries, each
 * line masked. An entry whose `text` is not a string is stored as it arrived.
 *
 * @param {string} key     Storage key.
 * @param {Array}  entries Stamped transcript entries, oldest first.
 */
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
 * to `DumperNode.restore()`, which takes the entries as already stamped.
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
 * echo are the same keystroke, so masking one without the other masks nothing.
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
