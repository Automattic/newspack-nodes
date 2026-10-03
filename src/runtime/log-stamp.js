/**
 * log-stamp — the one JS reader of the reader stamp a log frame's FROM opens
 * with, the twin of PHP `SSE_Out_Node::dir_from_stamp()`, held to it by
 * `tests/fixtures/log-stamps.json`.
 *
 * `SSE_Out_Node::stamp_for()` writes a `logs` dir bare and an `offsets` or
 * `deadletter` dir as `{group}/{dir}`, so only those two groups take a second
 * segment; a log dir that happens to be named `logs` is one segment.
 */

/** The `Log_Discovery::GROUPS` roots a stamp keeps its prefix under. */
const GROUP_PREFIXES = new Set( [ 'offsets', 'deadletter' ] );

/**
 * Split a FROM into the reader stamp and the segments after it.
 *
 * @param {?string} from A frame's FROM, stamp first.
 * @return {{dir:string,rest:Array<string>}} The stamp, `{group}/{dir}` or
 *   `{dir}`, and the remaining path segments.
 */
export function splitStamp( from ) {
	const parts = String( from ?? '' ).split( '/' );
	const width = GROUP_PREFIXES.has( parts[ 0 ] ) && parts[ 1 ] ? 2 : 1;
	return {
		dir: parts.slice( 0, width ).join( '/' ),
		rest: parts.slice( width ),
	};
}
