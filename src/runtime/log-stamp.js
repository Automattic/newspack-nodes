/**
 * log-stamp — the one JS reader of the stamp a log frame's FROM opens with,
 * the twin of PHP `Log_Discovery::dir_from_stamp()`, held to it by
 * `tests/fixtures/log-stamps.json`.
 *
 * `Log_Discovery::stamp_for()` writes a `logs` dir bare and an `offsets` or
 * `deadletter` dir as `{group}/{dir}`, a registry source is `sources/{name}`,
 * and a log dir named like any of those prefixes is refused, so a stamp
 * opening with one always takes a second segment.
 */

/** `Log_Discovery::SOURCES_PREFIX`: a registry source's stamp is `sources/<name>`. */
const SOURCES_PREFIX = 'sources';

/** `Log_Discovery::STAMP_PREFIXES`, the names no bare stamp may be. */
const STAMP_PREFIXES = new Set( [
	'logs',
	'offsets',
	'deadletter',
	SOURCES_PREFIX,
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
