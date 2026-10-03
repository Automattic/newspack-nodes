/**
 * log-stamp — the one JS reader of the reader stamp a log frame's FROM opens
 * with, the twin of PHP `SSE_Out_Node::dir_from_stamp()`, held to it by
 * `tests/fixtures/log-stamps.json`.
 *
 * `SSE_Out_Node::stamp_for()` writes a `logs` dir bare and an `offsets` or
 * `deadletter` dir as `{group}/{dir}`, and refuses a log dir named like a
 * group, so a stamp opening with a group name always takes a second segment.
 */

/** `Log_Discovery::GROUPS`, the names no bare stamp may be. */
const GROUPS = new Set( [ 'logs', 'offsets', 'deadletter' ] );

/**
 * Split a FROM into the reader stamp and the segments after it.
 *
 * @param {?string} from A frame's FROM, stamp first.
 * @return {{dir:string,rest:Array<string>}} The stamp, `{group}/{dir}` or
 *   `{dir}`, and the remaining path segments.
 */
export function splitStamp( from ) {
	const parts = String( from ?? '' ).split( '/' );
	const width = GROUPS.has( parts[ 0 ] ) && parts[ 1 ] ? 2 : 1;
	return {
		dir: parts.slice( 0, width ).join( '/' ),
		rest: parts.slice( width ),
	};
}
