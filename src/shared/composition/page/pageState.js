/**
 * Declared page state: the keys a composed page's blocks read and write
 * through `usePageState()`, so a breakdown bar sets a filter a chart reads
 * with no wiring between the two.
 *
 * A page declares its keys once with `definePageState()`, in a module that
 * both its reader and its editor entries import, as a page's source
 * declarations live: every bundle inlines its own copy of this module, so a
 * bundle reads only the keys its own modules declare.
 *
 * A key with a `query` is what the address bar holds, read through the
 * bundle's one bar store in `utils/queryParams`, which `useQueryParamState`
 * reads too: every reader of the param on the page sees one value, whatever
 * blocks or providers are mounted and whoever wrote the bar, so a deep link
 * opened on a layout without its writer still works. The store cleans the
 * bar on load and answers Back as the key's `push` says. A key whose default
 * is a list reflects as one param per item, `?chip=a&chip=b`. The store holds
 * one entry per param, read through the codec of the reader that opened it
 * last, so a key and a `useQueryParamState` hook on one param share it and
 * must spell the param alike; the store cannot refuse a mismatch, because a
 * hook builds a fresh codec every render. A key without
 * a `query` lives in its provider and holds what its writers set only while
 * a mounted block declares it writes it, `usePageState( key, { writes: true
 * } )`, and its default otherwise, so a curator removing the only writer
 * returns every reader to the default.
 *
 * `ComposedLayout` and `mountComposedEditor` render the provider; a page of
 * its own wraps its tree in the `PageStateProvider` `definePageState()`
 * returns. A provider inside another reuses the outer one's state.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from '@wordpress/element';
import { announce, openParam } from '../../utils/queryParams';
import { BAR, useSlot } from '../../hooks/useQueryParamState';

/**
 * One key's declaration.
 *
 * @typedef  {Object}                               PageStateKey
 * @property {*}                                    default  What the key holds with
 *                                                           nothing setting it; a list
 *                                                           makes the key a list.
 * @property {string}                               [query]  The address-bar param it
 *                                                           reflects to.
 * @property {(raw: string|string[]) => *}          [parse]  The value of the bar's
 *                                                           param, when present.
 * @property {(value: *) => (string|string[]|null)} [format] The bar's param for a value
 *                                                           other than the default.
 * @property {boolean}                              [push]   Whether a set is a Back
 *                                                           entry.
 */

/**
 * One key without a `query` in one provider.
 *
 * @typedef  {Object}          HeldKey
 * @property {*}               default   What it holds with no writer standing.
 * @property {*}               value     What its writers set.
 * @property {number}          writers   The mounted blocks declaring they write it.
 * @property {Set<() => void>} listeners Its readers.
 */

/**
 * This bundle's declarations by key, each with its bar codec, null for a key
 * without a `query`.
 *
 * @type {Map<string, {decl: PageStateKey, codec: ?import('../../utils/queryParams').ParamCodec}>}
 */
const declared = new Map();

/**
 * The key each declared address-bar param reflects.
 *
 * @type {Map<string, string>}
 */
const reflected = new Map();

/**
 * A value as it is.
 *
 * @param {*} value The value.
 * @return {*} It.
 */
const identity = ( value ) => value;

/** @type {import('react').Context<?Map<string, HeldKey>>} */
const PageStateContext = createContext( null );

/**
 * Whether two declarations name the same values, field by field.
 *
 * @param {Object} a One.
 * @param {Object} b The other.
 * @return {boolean} Whether they do.
 */
function sameDeclaration( a, b ) {
	const keys = Object.keys( a );
	return (
		keys.length === Object.keys( b ).length &&
		keys.every( ( key ) => a[ key ] === b[ key ] )
	);
}

/**
 * Declare one key.
 *
 * @param {string}       key  The key.
 * @param {PageStateKey} decl Its declaration.
 * @throws {TypeError} On a key with no default, one declared otherwise, or a
 *                     param another key reflects.
 */
function declare( key, decl ) {
	if ( ! Object.hasOwn( decl, 'default' ) ) {
		throw new TypeError( `page state '${ key }' declares no default` );
	}
	const prior = declared.get( key );
	if ( prior ) {
		if ( ! sameDeclaration( prior.decl, decl ) ) {
			throw new TypeError( `page state '${ key }' is already declared` );
		}
		return;
	}
	if ( decl.query ) {
		const holder = reflected.get( decl.query );
		if ( holder ) {
			throw new TypeError(
				`page state '${ key }' reflects to ?${ decl.query }=, which '${ holder }' holds`
			);
		}
		reflected.set( decl.query, key );
	}
	declared.set( key, { decl, codec: decl.query ? codecOf( decl ) : null } );
}

/**
 * A key's bar codec, its default folded in: an absent param reads as the
 * default, and the default is left off the bar.
 *
 * @param {PageStateKey} decl The key's declaration.
 * @return {import('../../utils/queryParams').ParamCodec} The codec.
 */
function codecOf( decl ) {
	const list = Array.isArray( decl.default );
	const parse = decl.parse ?? identity;
	const format = decl.format ?? ( list ? identity : String );
	const spelled = JSON.stringify( decl.default );
	return {
		list,
		parse: ( raw ) =>
			( list ? 0 === raw.length : null === raw )
				? decl.default
				: parse( raw ),
		format: ( value ) =>
			JSON.stringify( value ) === spelled ? null : format( value ),
		push: !! decl.push,
	};
}

/**
 * A provider's key without a `query`, at its default until a writer sets it.
 *
 * @param {Map<string, HeldKey>} keys The provider's keys.
 * @param {string}               key  A declared key.
 * @return {HeldKey} It.
 */
function heldKey( keys, key ) {
	if ( ! keys.has( key ) ) {
		const { default: initial } = declared.get( key ).decl;
		keys.set( key, {
			default: initial,
			value: initial,
			writers: 0,
			listeners: new Set(),
		} );
	}
	return keys.get( key );
}

/**
 * What a held key shows: what its writers set while one stands.
 *
 * @param {HeldKey} held The key.
 * @return {*} The value.
 */
const heldValue = ( held ) => ( 0 < held.writers ? held.value : held.default );

/**
 * Count a block that writes a held key while it stands. The last one leaving
 * resets the key once the commit ends, so a writer remounting in the same
 * commit, as StrictMode's does, keeps what it set.
 *
 * @param {HeldKey} held The key.
 * @return {() => void} Lets the writer go.
 */
function holdWriter( held ) {
	held.writers += 1;
	announce( held );
	return () => {
		held.writers -= 1;
		announce( held );
		queueMicrotask( () => {
			if ( 0 === held.writers ) {
				held.value = held.default;
			}
		} );
	};
}

/**
 * A provider's keys without a `query`, read and written as `useSlot` reads
 * and writes a slot.
 *
 * @type {import('../../hooks/useQueryParamState').SlotHome}
 */
const IN_PROVIDER = {
	subscribe: ( held, listener ) => {
		held.listeners.add( listener );
		return () => held.listeners.delete( listener );
	},
	read: heldValue,
	peek: ( held, value ) => value,
	set: ( held, value ) => {
		held.value = value;
		announce( held );
	},
};

/**
 * Holds the page state of the tree beneath it.
 *
 * @param {{children: *}} props The tree reading page state.
 * @return {import('react').ReactElement} The tree.
 */
function OwnPageState( { children } ) {
	const [ keys ] = useState( () => new Map() );
	return (
		<PageStateContext.Provider value={ keys }>
			{ children }
		</PageStateContext.Provider>
	);
}

/**
 * The page state of the tree beneath it: the state of a provider already
 * above it, so every layout on a page reads one value per key, or else its
 * own.
 *
 * @param {{children: *}} props The tree reading page state.
 * @return {import('react').ReactElement} The tree, under its own state when
 *   this is the outermost provider.
 */
export function PageStateProvider( { children } ) {
	if ( useContext( PageStateContext ) ) {
		return children;
	}
	return <OwnPageState>{ children }</OwnPageState>;
}

/**
 * Declare a page's state keys in this bundle.
 *
 * The same declaration again, field for field, is taken; a different one
 * under a key already declared throws, as does a key with no default or one
 * reflecting to a param another key reflects to.
 *
 * @param {Object<string, PageStateKey>} keys Key => declaration.
 * @return {typeof PageStateProvider} The provider, for a page of its own.
 * @throws {TypeError} On a declaration this bundle cannot take.
 */
export function definePageState( keys ) {
	for ( const [ key, decl ] of Object.entries( keys ) ) {
		declare( key, decl );
	}
	return PageStateProvider;
}

/**
 * Read a declared key, and set it when this block declares it writes it.
 *
 * @param {string}             key       A key this bundle declared.
 * @param {{writes?: boolean}} [options] `writes` declares this block
 *                                       writes the key while mounted.
 * @return {[*, (next: *) => void]} The value every reader of the key sees,
 *   and its setter, taking a value or a function of the value shown.
 * @throws {Error} Outside a provider, or on an undeclared key.
 */
export function usePageState( key, { writes = false } = {} ) {
	const keys = useContext( PageStateContext );
	if ( ! keys ) {
		throw new Error(
			`usePageState( '${ key }' ) reads through a PageStateProvider above it: a composed page's ComposedLayout renders one, and a page of its own wraps its tree in the provider definePageState() returns`
		);
	}
	if ( ! declared.has( key ) ) {
		throw new Error(
			`page state '${ key }' is not declared: declare it in definePageState( { '${ key }': { default } } ), in a module both the page's reader and editor entries import`
		);
	}
	const { codec } = declared.get( key );
	const held = codec ? null : heldKey( keys, key );
	useEffect(
		() => ( writes && held ? holdWriter( held ) : undefined ),
		[ held, writes ]
	);
	const [ value, setSlot ] = useSlot(
		held ? IN_PROVIDER : BAR,
		held ?? openParam( declared.get( key ).decl.query, codec )
	);
	const set = useCallback(
		( next ) => {
			if ( ! writes ) {
				throw new Error(
					`usePageState( '${ key }' ) cannot set a key it did not declare it writes: read it with usePageState( '${ key }', { writes: true } ), so the key holds its default once no such block stands`
				);
			}
			setSlot( next );
		},
		[ setSlot, key, writes ]
	);
	return [ value, set ];
}
