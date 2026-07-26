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
export const MAX_PERSISTED_TRANSCRIPT = TRANSCRIPT_MAX;
export const MAX_PERSISTED_HISTORY = 100;

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
 * @param {string} text A transcript line.
 * @return {string} The line with credential values masked.
 */
export function redactSecrets( text ) {
	if ( 'string' !== typeof text ) {
		return text;
	}
	const secret = ( name ) =>
		SECRET_NAME_PATTERNS.some( ( n ) => name.toLowerCase().includes( n ) );
	return text
		.replace( /(--[\w.-]+=)("?)([^\s"]*)\2/g, ( all, lead, quote ) =>
			secret( lead ) ? `${ lead }${ quote }${ REDACTED }${ quote }` : all
		)
		.replace( /("[\w.-]+"\s*:\s*)"([^"]*)"/g, ( all, lead ) =>
			secret( lead ) ? `${ lead }"${ REDACTED }"` : all
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

export function loadTranscript() {
	return readArray( TRANSCRIPT_KEY );
}

export function saveTranscript( entries ) {
	saveTranscriptTo( TRANSCRIPT_KEY, entries );
}

export function loadHubTranscript() {
	return readArray( HUB_TRANSCRIPT_KEY );
}

export function saveHubTranscript( entries ) {
	saveTranscriptTo( HUB_TRANSCRIPT_KEY, entries );
}

export function loadHistory() {
	return readArray( HISTORY_KEY );
}

export function saveHistory( entries ) {
	write(
		HISTORY_KEY,
		JSON.stringify( ( entries || [] ).slice( -MAX_PERSISTED_HISTORY ) )
	);
}

export function loadDebugLevel() {
	return readInt( DEBUG_LEVEL_KEY );
}

export function saveDebugLevel( level ) {
	write( DEBUG_LEVEL_KEY, String( Number( level ) || 0 ) );
}

export function loadDebugState() {
	return readInt( DEBUG_STATE_KEY );
}

export function saveDebugState( state ) {
	write( DEBUG_STATE_KEY, String( Number( state ) || 0 ) );
}
