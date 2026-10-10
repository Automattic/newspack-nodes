/**
 * log-stamp — the one JS reader of the stamp a log frame's FROM opens with,
 * the twin of PHP `Log_Discovery::dir_from_stamp()`, held to it by
 * `tests/fixtures/log-stamps.json`.
 *
 * `Log_Discovery::stamp_for()` writes a `logs` dir bare and an `offsets` or
 * `deadletter` dir as `{group}/{dir}`, a registry source is `sources/{name}`,
 * and a log dir named like any of those prefixes is refused, so a stamp
 * opening with one always takes a second segment. It also reads the broker
 * grammar beside the stamp: a `<stamp>:<target>` pair (`splitPair()`).
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
 * exactly, or a glob whose `*` matches within one path segment. Every other
 * character is literal, as in PHP `Log_Discovery::carries()`, which
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
			.join( '[^/]*' );
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

/**
 * The kind a stamp's reader takes, the twin of PHP `Log_Discovery::kind_of()`,
 * held to it by `tests/fixtures/log-kinds.json`: the stamp with each `/`
 * spelled `:`, because the Router splits a TO on `/`. A link names the Tee it
 * builds for a stamp `<link>:<kind>`.
 *
 * @param {string} stamp A record's stamp.
 * @return {string} The kind.
 */
export function kindOf( stamp ) {
	return stamp.replaceAll( '/', ':' );
}

/**
 * Split a `<source>:<target>` pair at its first colon outside `<…>`, so a
 * `<ns:key>` token in the source stays whole; a token with no such colon is
 * all source. The twin of PHP `Remote_Broker_Node::split_pair()`, held to it
 * by `tests/fixtures/pair-split.json`; it validates nothing.
 *
 * @param {string} token One pair token.
 * @return {{source:string,target:string}} The two halves.
 */
export function splitPair( token ) {
	let depth = 0;
	for ( let at = 0; at < token.length; at++ ) {
		const char = token[ at ];
		if ( '<' === char ) {
			depth++;
		} else if ( '>' === char && depth > 0 ) {
			depth--;
		} else if ( ':' === char && 0 === depth ) {
			return {
				source: token.slice( 0, at ),
				target: token.slice( at + 1 ),
			};
		}
	}
	return { source: token, target: '' };
}
