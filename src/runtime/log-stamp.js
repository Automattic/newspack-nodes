/**
 * log-stamp — the JS readers of a log stamp, each the twin of a
 * `Log_Discovery` reader and held to it by a shared fixture.
 *
 * `Log_Discovery::stamp_for()` writes a `logs` dir bare, an `offsets` or
 * `deadletter` dir as `{group}:{dir}`, a broker reader's dir as
 * `{group}:{root}:{stamp}`, and a registry source as `sources:{name}`, so a
 * stamp is always one `/` segment.
 */

/** `Log_Discovery::REMOTE_PREFIX`: a spoke's log is `remote:<vault_id>:<stamp>`. */
const REMOTE_PREFIX = 'remote';

/**
 * Split a streamed record's FROM into its stamp and the trail after it. The
 * stamp is the first segment by position alone: every segment after it is a
 * node name, which may hold `:` and look like a stamp.
 *
 * @param {?string} from A frame's FROM as it arrived, stamp first.
 * @return {{dir:string,rest:Array<string>}} The stamp, and the remaining
 *   path segments.
 */
export function splitStamp( from ) {
	const [ dir, ...rest ] = String( from ?? '' ).split( '/' );
	return { dir, rest };
}

/**
 * Whether a subscription is a glob, a `*` anywhere in it, as PHP
 * `Log_Discovery::is_glob()` reads it.
 *
 * @param {string} sub A subscription, as `subscribe` lists it.
 * @return {boolean} True when the subscription is a glob.
 */
export function isGlob( sub ) {
	return sub.includes( '*' );
}

/** Each glob subscription `carries()` has met, compiled once. */
const GLOBS = new Map();

/**
 * Whether a subscription brings records stamped `stamp`: its own name
 * exactly, or a glob whose `*` matches within one stamp part, so no glob
 * carries a broker reader's stamp. Every other character is literal, as in
 * PHP `Log_Discovery::carries()`, which
 * `tests/fixtures/subscription-carries.json` holds it to.
 *
 * @param {string} sub   A subscription, as `subscribe` lists it.
 * @param {string} stamp A record's stamp, as `splitStamp()` reads it.
 * @return {boolean} True when the subscription carries the stamp.
 */
function carries( sub, stamp ) {
	if ( ! isGlob( sub ) ) {
		return sub === stamp;
	}
	let glob = GLOBS.get( sub );
	if ( ! glob ) {
		const pattern = sub
			.split( '*' )
			.map( ( part ) => part.replace( /[.+?^${}()|[\]\\]/g, '\\$&' ) )
			.join( '[^/:]*' );
		glob = new RegExp( `^${ pattern }$` );
		GLOBS.set( sub, glob );
	}
	return glob.test( stamp );
}

/**
 * Whether any of a stream's subscriptions carries `stamp`.
 *
 * @param {string[]} subscribe The subscriptions, as `subscribe` lists them.
 * @param {string}   stamp     A record's stamp, as `splitStamp()` reads it.
 * @return {boolean} True when one of them carries the stamp.
 */
export function anyCarries( subscribe, stamp ) {
	return subscribe.some( ( sub ) => carries( sub, stamp ) );
}

/**
 * The spoke and the stamp a remote log's name carries, the twin of PHP
 * `Log_Discovery::remote_of()`, held to it by `tests/fixtures/log-remotes.json`;
 * null for any name `remote_for()` did not write, a local stamp included.
 *
 * @param {?string} name A probe record's SOURCE.
 * @return {?{vaultId:string,stamp:string}} The spoke's Vault id and its stamp.
 */
export function remoteOf( name ) {
	const text = String( name ?? '' );
	const [ prefix, vaultId, ...parts ] = text.split( ':' );
	const stamp = parts.join( ':' );
	return REMOTE_PREFIX !== prefix ||
		! vaultId ||
		! stamp ||
		text.includes( '/' )
		? null
		: { vaultId, stamp };
}
