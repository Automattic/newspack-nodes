/**
 * The source registry: what each source name declares in this bundle, and
 * the live sources one `SourcesProvider` holds, with how many readers hold
 * each.
 *
 * Declarations stay with the bundle that made them, because every bundle
 * inlines its own copy of this module: a bundle reads the sources it
 * declared, and a second bundle declaring a name of its own never collides.
 *
 * A key is the source's name plus the stable JSON of its params, so equal
 * params share one live source and different params never do. Each live
 * source names its nodes under a prefix of its own, `<name>:<n>`, so the
 * late answer to one key lands on that key's nodes and nowhere else (ADR-7).
 * The ordinal alone is page-wide, because `Core`'s node names are.
 */

import { Core } from '@newspack-nodes/runtime';

/** Window key holding each page graph's count of live sources made. */
const ORDINALS_KEY = '__newspackNodesSourceOrdinals';

/**
 * This bundle's declarations, by name.
 *
 * @type {Map<string, Object>}
 */
const declared = new Map();

/**
 * One live source: a declaration read under one set of params.
 *
 * @typedef  {Object}  Entry
 * @property {string}  key     Name and stable params, its identity.
 * @property {Object}  decl    What its name declares.
 * @property {Object}  params  What it was asked with.
 * @property {string}  prefix  Names its nodes, unique on the page.
 * @property {Sources} sources The provider's sources it lives among.
 * @property {number}  holders The readers holding it.
 * @property {?Object} state   Its last published `{ model, error, loading, stale }`.
 */

/**
 * One provider's live sources and the listeners told of every change.
 *
 * @typedef  {Object}             Sources
 * @property {Map<string, Entry>} entries   Live sources by key.
 * @property {Set<() => void>}    listeners Told after every change.
 * @property {number}             version   Moves when a source gains its
 *                                          first reader or loses its last.
 */

/** The kinds a field may declare: a figure, a series map, a line, a column. */
const FIELD_KINDS = [ 'value', 'series', 'line', 'rows' ];

/**
 * Whether two declarations' fields read alike: the same keys, each with the
 * same label, kind and formatters.
 *
 * @param {Object<string,Object>} a One's fields.
 * @param {Object<string,Object>} b The other's.
 * @return {boolean} Whether they do.
 */
function sameFields( a = {}, b = {} ) {
	const keys = Object.keys( a );
	return (
		keys.length === Object.keys( b ).length &&
		keys.every(
			( key ) =>
				Object.hasOwn( b, key ) &&
				[ 'label', 'kind', 'format', 'formatFor' ].every(
					( part ) => a[ key ][ part ] === b[ key ][ part ]
				)
		)
	);
}

/**
 * Whether two declarations name the same values: `params` by their JSON,
 * `fields` field by field, and every other key by identity.
 *
 * @param {Object} a One.
 * @param {Object} b The other.
 * @return {boolean} Whether they do.
 */
function sameDeclaration( a, b ) {
	const keys = Object.keys( a );
	return (
		keys.length === Object.keys( b ).length &&
		keys.every( ( key ) => {
			if ( 'params' === key ) {
				return stableJson( a.params ) === stableJson( b.params );
			}
			if ( 'fields' === key ) {
				return sameFields( a.fields, b.fields );
			}
			return a[ key ] === b[ key ];
		} )
	);
}

/**
 * Declare a source under a name this bundle's blocks read it by.
 *
 * The same declaration again is taken, and the first stands; a different
 * one under a name already declared throws, because two readers of one name
 * would each get the other's data.
 *
 * Any kind may add `fields`, `{ key: { label, kind, format?, formatFor? } }`,
 * the fields of its model a block shows, each by its label. A field's
 * `kind` names the blocks that show it: `value`, a figure a stat tile shows;
 * `series`, a series map a time chart draws; `line`, a list of numbers a
 * sparkline draws; `rows`, a column of the rows a table or a log stream
 * lists. `format( value )` answers what a block shows, and a chart field's
 * `formatFor( peak )` the axis formatter for the peak drawn. `params` names
 * the page-state keys a block reads its params from, each param named as its
 * key, and `label` the words a block's inspector names the source by, its
 * name when it declares none. Two fields of one kind may not share a label,
 * because a block's inspector finds a field by its label.
 *
 * @param {string} name A name holding no `/`, which would split its node paths.
 * @param {Object} decl `{ kind: 'poll', group, ci, command, args, transform?,
 *                      intervalMs }`, `{ kind: 'command', group, ci, command,
 *                      args }` or `{ kind: 'stream', subscribe, viewClass,
 *                      mode }`; `args` and `subscribe` read the params.
 * @throws {TypeError} On a name holding `/`, one declared otherwise, a
 *                     field declaring no kind it knows, or two fields of one
 *                     kind sharing a label.
 */
export function registerSource( name, decl ) {
	if ( 'string' !== typeof name || '' === name || name.includes( '/' ) ) {
		throw new TypeError( `a source name holds no '/': '${ name }'` );
	}
	const labelled = new Map();
	for ( const [ key, field ] of Object.entries( decl.fields ?? {} ) ) {
		const twin = labelled.get( `${ field.kind } ${ field.label }` );
		if ( twin ) {
			throw new TypeError(
				`${ name } fields '${ twin }' and '${ key }' are both labelled '${ field.label }'`
			);
		}
		labelled.set( `${ field.kind } ${ field.label }`, key );
		if ( ! FIELD_KINDS.includes( field.kind ) ) {
			throw new TypeError(
				`${ name } field '${ key }' declares no kind of ${ FIELD_KINDS.slice(
					0,
					-1
				).join( ', ' ) } or ${ FIELD_KINDS.at( -1 ) }`
			);
		}
	}
	const prior = declared.get( name );
	if ( prior ) {
		if ( ! sameDeclaration( prior, decl ) ) {
			throw new TypeError( `source '${ name }' is already declared` );
		}
		return;
	}
	declared.set( name, decl );
}

/**
 * Every source this bundle declares, as `[ name, declaration ]`.
 *
 * @return {Array<[string, Object]>} They, in declared order.
 */
export const declaredSources = () => [ ...declared.entries() ];

/**
 * What this bundle declares under `name`.
 *
 * @param {string} name A source.
 * @return {Object} Its declaration.
 * @throws {TypeError} When this bundle declares no `name`.
 */
export function sourceDeclaration( name ) {
	const decl = declared.get( name );
	if ( ! decl ) {
		throw new TypeError( `no source is declared as '${ name }'` );
	}
	return decl;
}

/**
 * JSON with every object's keys sorted, so equal params spell one key.
 *
 * @param {*} value The params, or any part of them.
 * @return {string} The JSON.
 */
export function stableJson( value ) {
	if ( Array.isArray( value ) ) {
		return `[${ value.map( stableJson ).join( ',' ) }]`;
	}
	if ( value && 'object' === typeof value ) {
		return `{${ Object.keys( value )
			.sort()
			.map(
				( key ) =>
					`${ JSON.stringify( key ) }:${ stableJson( value[ key ] ) }`
			)
			.join( ',' ) }}`;
	}
	return JSON.stringify( value ) ?? 'null';
}

/**
 * The key a source read under `params` is held by.
 *
 * @param {string} name   The source.
 * @param {Object} params What it is read with.
 * @return {string} The key.
 */
export const sourceKey = ( name, params ) =>
	`${ name } ${ stableJson( params ) }`;

/**
 * The next prefix on the graph `Core` holds now, unique across every
 * provider and bundle on the page.
 *
 * @param {string} name The source.
 * @return {string} `<name>:<n>`.
 */
function nextPrefix( name ) {
	window[ ORDINALS_KEY ] ??= new WeakMap();
	const ordinals = window[ ORDINALS_KEY ];
	const made = ( ordinals.get( Core.registry ) ?? 0 ) + 1;
	ordinals.set( Core.registry, made );
	return `${ name }:${ made }`;
}

/**
 * A provider's live sources, none yet.
 *
 * @return {Sources} They.
 */
export const createSources = () => ( {
	entries: new Map(),
	listeners: new Set(),
	version: 0,
} );

/**
 * Tell every listener the provider's sources moved.
 *
 * @param {Sources} sources The provider's sources.
 */
const announce = ( sources ) =>
	sources.listeners.forEach( ( listener ) => listener() );

/**
 * Mark which sources hold a reader as moved, and say so.
 *
 * @param {Sources} sources The provider's sources.
 */
function moved( sources ) {
	sources.version += 1;
	announce( sources );
}

/**
 * Hold the live source of `name` read under `params`, making it on the
 * first hold.
 *
 * @param {Sources} sources The provider's sources.
 * @param {string}  name    A source this bundle declared.
 * @param {Object}  params  What it is read with.
 * @return {Entry} The live source.
 * @throws {TypeError} When this bundle declares no `name`.
 */
export function acquire( sources, name, params ) {
	const decl = sourceDeclaration( name );
	const key = sourceKey( name, params );
	let entry = sources.entries.get( key );
	if ( ! entry ) {
		entry = {
			key,
			decl,
			params,
			prefix: nextPrefix( name ),
			sources,
			holders: 0,
			state: null,
		};
		sources.entries.set( key, entry );
	}
	entry.holders += 1;
	if ( 1 === entry.holders ) {
		moved( entry.sources );
	}
	return entry;
}

/**
 * Let go of a live source. The last release only marks it unheld, so a
 * reader remounting in the same commit holds it again; `settle()` removes
 * it once its host has gone.
 *
 * @param {Entry} entry The live source.
 */
export function release( entry ) {
	entry.holders -= 1;
	if ( 0 === entry.holders ) {
		moved( entry.sources );
	}
}

/**
 * Its host has unmounted: forget a source every reader released, or ask for a
 * host again for one a reader took back meanwhile.
 *
 * @param {Entry} entry The live source.
 */
export function settle( entry ) {
	if ( 0 < entry.holders ) {
		moved( entry.sources );
		return;
	}
	if ( entry.sources.entries.get( entry.key ) === entry ) {
		entry.sources.entries.delete( entry.key );
	}
}

/**
 * The sources a reader holds, each wanting a host.
 *
 * @param {Sources} sources The provider's sources.
 * @return {Entry[]} They.
 */
export const heldSources = ( sources ) =>
	[ ...sources.entries.values() ].filter( ( entry ) => 0 < entry.holders );

/**
 * Record what a live source now shows and tell its readers.
 *
 * @param {Entry}  entry The live source.
 * @param {Object} state `{ model, error, loading, stale }`.
 */
export function publish( entry, state ) {
	entry.state = state;
	announce( entry.sources );
}

/**
 * Listen for any change to a provider's sources.
 *
 * @param {Sources}    sources  The provider's sources.
 * @param {() => void} listener Told after each.
 * @return {() => void} Stops it.
 */
export function subscribe( sources, listener ) {
	sources.listeners.add( listener );
	return () => sources.listeners.delete( listener );
}
