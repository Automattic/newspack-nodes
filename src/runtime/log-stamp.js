/**
 * log-stamp — the one JS reader of the stamp a log frame's FROM opens with,
 * the twin of PHP `Log_Discovery::dir_from_stamp()`, held to it by
 * `tests/fixtures/log-stamps.json`.
 *
 * `Log_Discovery::stamp_for()` writes a `logs` dir bare and an `offsets` or
 * `deadletter` dir as `{group}/{dir}`, a registry source is `sources/{name}`,
 * a spoke's log in the hub's probe channel is `remote/{vault_id}:{kind}`, and
 * a log dir named like any of those prefixes is refused, so a stamp opening
 * with one always takes a second segment.
 */

/** `Log_Discovery::SOURCES_PREFIX`: a registry source's stamp is `sources/<name>`. */
const SOURCES_PREFIX = 'sources';

/** `Log_Discovery::REMOTE_PREFIX`: a spoke's log is `remote/<vault_id>:<kind>`. */
const REMOTE_PREFIX = 'remote';

/** `Log_Discovery::STAMP_PREFIXES`, the names no bare stamp may be. */
const STAMP_PREFIXES = new Set( [
	'logs',
	'offsets',
	'deadletter',
	SOURCES_PREFIX,
	REMOTE_PREFIX,
] );

/**
 * Split a FROM into the reader stamp and the segments after it.
 *
 * @param {?string} from A frame's FROM, stamp first.
 * @return {{dir:string,rest:Array<string>}} The stamp, `{group}/{dir}` or
 *   `{dir}`, and the remaining path segments.
 */
export function splitStamp( from ) {
	const parts = String( from ?? '' ).split( '/' );
	const width = STAMP_PREFIXES.has( parts[ 0 ] ) && parts[ 1 ] ? 2 : 1;
	return {
		dir: parts.slice( 0, width ).join( '/' ),
		rest: parts.slice( width ),
	};
}

/**
 * The spoke and the kind a remote log's name carries, the twin of PHP
 * `Log_Discovery::remote_of()`, held to it by `tests/fixtures/log-remotes.json`;
 * null for any name `remote_for()` did not write, a local stamp included.
 *
 * @param {?string} name A probe record's SOURCE.
 * @return {?{vaultId:string,kind:string}} The spoke's Vault id and the log's kind.
 */
export function remoteOf( name ) {
	const prefix = `${ REMOTE_PREFIX }/`;
	const rest = String( name ?? '' );
	if ( ! rest.startsWith( prefix ) || rest.includes( '/', prefix.length ) ) {
		return null;
	}
	const colon = rest.indexOf( ':', prefix.length );
	const vaultId = rest.slice( prefix.length, colon );
	const kind = rest.slice( colon + 1 );
	return -1 === colon || '' === vaultId || '' === kind
		? null
		: { vaultId, kind };
}
