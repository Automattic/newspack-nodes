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

/** `Log_Discovery::READER_GROUPS`: the roots a broker reader's dir sits under. */
const READER_GROUPS = [ 'offsets', 'deadletter' ];

/** `Log_Discovery::SOURCES_PREFIX`: a registry entry is `sources:<name>`. */
const SOURCES_PREFIX = 'sources';

/** `Log_Discovery::STAMP_PREFIXES`: what may precede a stamp's first `:`. */
const STAMP_PREFIXES = [ ...READER_GROUPS, SOURCES_PREFIX ];

/**
 * `Log_Discovery::MAX_STAMP_BYTES`: NAME_MAX, the longest dir name. A stamp
 * either check admits is ASCII, so its `length` counts its bytes.
 */
const MAX_STAMP_BYTES = 255;

/** `Log_Sources::NAME_PATTERN`: a log's or a source's name. */
const NAME_PATTERN = /^[a-z0-9_-][a-z0-9_.-]*$/;

/** `Log_Discovery::ROOT_PATTERN`: a broker root's name. */
const ROOT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

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

/**
 * A stamp's group and the rest, as PHP `Log_Discovery::split()` cuts it: at
 * its first `:` when one of `STAMP_PREFIXES` precedes it, else a `logs` name
 * whole.
 *
 * @param {string} stamp A stamp, or a subscription glob.
 * @return {[string,string]} The group, then the rest.
 */
function split( stamp ) {
	const at = stamp.indexOf( ':' );
	return -1 !== at && STAMP_PREFIXES.includes( stamp.slice( 0, at ) )
		? [ stamp.slice( 0, at ), stamp.slice( at + 1 ) ]
		: [ 'logs', stamp ];
}

/**
 * Whether a string fits `MAX_STAMP_BYTES` and matches `pattern` with no
 * `..` in it: a name, as `Log_Sources::is_valid_name()` reads one, or a
 * broker root.
 *
 * @param {string} name    A candidate name.
 * @param {RegExp} pattern The pattern it must match whole.
 * @return {boolean} True when it names one dir.
 */
function fits( name, pattern ) {
	return (
		name.length <= MAX_STAMP_BYTES &&
		! name.includes( '..' ) &&
		pattern.test( name )
	);
}

/**
 * Whether a string is a stamp a record may carry, as PHP
 * `Log_Discovery::is_stamp()` reads one: a `logs` or `sources:` name, or
 * under a reader group such a name or a broker reader's `<root>:<stamp>`,
 * each part within `MAX_STAMP_BYTES` and the whole too.
 *
 * @param {string} stamp A candidate stamp.
 * @return {boolean} True when it names one dir and nothing above it.
 */
function isStamp( stamp ) {
	const [ group, rest ] = split( stamp );
	const at = READER_GROUPS.includes( group ) ? rest.indexOf( ':' ) : -1;
	if ( -1 !== at ) {
		return (
			fits( rest.slice( 0, at ), ROOT_PATTERN ) &&
			fitsADirName( rest.slice( at + 1 ) )
		);
	}
	return stamp.length <= MAX_STAMP_BYTES && fits( rest, NAME_PATTERN );
}

/**
 * Whether a stamp may name a dir of its own, as PHP
 * `Log_Discovery::fits_a_dir_name()` reads one: a stamp within
 * `MAX_STAMP_BYTES` whole, as a broker reader's dir, named the stamp it
 * reads, must be.
 *
 * @param {string} stamp A candidate stamp.
 * @return {boolean} True when it may name a dir.
 */
export function fitsADirName( stamp ) {
	return stamp.length <= MAX_STAMP_BYTES && isStamp( stamp );
}

/**
 * Whether a spoke would open a subscription, as PHP
 * `Log_Discovery::is_subscription()` reads one: a stamp, or a glob whose
 * rest is one name once each `*` stands for a name character, opening with
 * no `*` and none under `sources:`.
 *
 * @param {string} sub A candidate subscription.
 * @return {boolean} True when the spoke would resolve it.
 */
export function isSubscription( sub ) {
	if ( ! isGlob( sub ) ) {
		return isStamp( sub );
	}
	const [ group, rest ] = split( sub );
	return (
		sub.length <= MAX_STAMP_BYTES &&
		SOURCES_PREFIX !== group &&
		! rest.startsWith( '*' ) &&
		fits( rest.replaceAll( '*', 'a' ), NAME_PATTERN )
	);
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
