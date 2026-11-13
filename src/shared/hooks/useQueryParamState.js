/**
 * useQueryParamState — dashboard state the address bar names.
 *
 * The URL twin of `usePersistedState`: the same restore and encode pair, with
 * `?param=` in place of localStorage, so a copied link reopens the same view.
 * The value is what the bar holds, read through `restore`: every hook reads
 * the bundle's one bar store in `utils/queryParams`, which page state reads
 * too, so two readers of one param see one value and a direct
 * `setQueryParams` reaches them both. The store cleans the bar on mount,
 * dropping a value `restore` rejected and a default written out, and every
 * write goes through `setQueryParams`' replaceState, because a filter is state
 * rather than navigation and earns no Back entry of its own.
 * `useQueryParamList` is the twin for a list, written as one repeated
 * `?param=` per item. Every hook here takes a last `{ written }` option that
 * holds its value off the bar while the view it belongs to is shut, so a
 * caller never hand-writes a gated encoder, and a `push` option that makes the
 * value navigation instead: each change after mount pushes a Back entry, and
 * Back or Forward restores the value the landed entry names.
 *
 * A page can still push entries of its own — a `?url=`-style navigation — and
 * each carries the filters current when it was pushed. The view keeps its
 * filters across Back and Forward, so the store writes the live value back
 * over the restored entry rather than let the bar name a view that is not on
 * screen.
 *
 * Canonical in newspack-nodes, consumed through the `@newspack-nodes/shared`
 * alias.
 */

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from '@wordpress/element';
import {
	openParam,
	peekParam,
	setParam,
	setParamWritten,
	subscribeParam,
} from '../utils/queryParams';

/**
 * Where a slot's value lives, and how it is read and written there.
 *
 * @typedef  {Object}                                        SlotHome
 * @property {(slot: *, listener: () => void) => () => void} subscribe Subscribes a reader.
 * @property {(slot: *) => *}                                read      What the slot holds.
 * @property {(slot: *, value: *) => *}                      peek      What it would hold once
 *                                                                     set to a value.
 * @property {(slot: *, value: *) => void}                   set       Sets it, telling every
 *                                                                     reader.
 */

/**
 * A param of the bundle's bar store.
 *
 * @type {SlotHome}
 */
export const BAR = {
	subscribe: subscribeParam,
	read: ( entry ) => entry.value,
	peek: peekParam,
	set: setParam,
};

/** No set waiting to land. */
const NONE = Symbol( 'none' );

/**
 * A slot's value and its setter, with React state's contract: a set may run
 * during the setter's own render, and lands with the commit it renders in.
 * The setting component shows what the slot will hold at once; the set
 * reaches the slot, and every other reader of it, in the commit's passive
 * effects, after a layout effect's navigation, so a set made beside one is
 * written into the entry it opened. A set still waiting when the setter
 * unmounts lands as it goes.
 *
 * @param {SlotHome} home Where the slot lives.
 * @param {*}        slot The slot.
 * @return {[*, (next: *) => void]} The value and its setter, taking a value
 *   or a function of the value shown.
 */
export function useSlot( home, slot ) {
	const pending = useRef( NONE );
	const [ waiting, setWaiting ] = useState( NONE );
	const held = useSyncExternalStore(
		useCallback(
			( listener ) => home.subscribe( slot, listener ),
			[ home, slot ]
		),
		() => home.read( slot )
	);
	useEffect( () => {
		if ( NONE !== waiting ) {
			if ( waiting === pending.current ) {
				pending.current = NONE;
			}
			home.set( slot, waiting );
			setWaiting( ( current ) =>
				current === waiting ? NONE : current
			);
		}
	}, [ home, slot, waiting ] );
	useEffect(
		() => () => {
			if ( NONE !== pending.current ) {
				home.set( slot, pending.current );
			}
		},
		[ home, slot ]
	);
	const set = useCallback(
		( next ) => {
			const prior = pending.current;
			pending.current =
				'function' === typeof next
					? next(
							NONE === prior
								? home.read( slot )
								: home.peek( slot, prior )
					  )
					: next;
			setWaiting( pending.current );
		},
		[ home, slot ]
	);
	return [ NONE === waiting ? held : home.peek( slot, waiting ), set ];
}

/**
 * Own a value mirrored into `?param=`.
 *
 * @template T
 * @param {string}                              param     Query-string parameter
 *                                                        name.
 * @param {(raw: ?string) => T}                 restore   Decode and validate the
 *                                                        param's value; receives
 *                                                        null when absent.
 * @param {(value: T) => ?string}               encode    The param's value; null
 *                                                        or '' omits it.
 * @param {{written?: boolean, push?: boolean}} [options] `written` false holds
 *                                                        the value off the bar,
 *                                                        true by default; `push`
 *                                                        makes each change a
 *                                                        Back entry, false by
 *                                                        default.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and its setter.
 */
export function useQueryParamState( param, restore, encode, options ) {
	return useMirroredParam( param, false, restore, encode, options );
}

/**
 * Own a value mirrored into a repeated `?param=a&param=b`, one entry per item,
 * so an item may hold any character.
 *
 * @template T
 * @param {string}                              param     Query-string parameter
 *                                                        name.
 * @param {(raw: string[]) => T}                restore   Decode and validate
 *                                                        every value the param
 *                                                        holds; receives []
 *                                                        when absent.
 * @param {(value: T) => string[]}              encode    The param's values; []
 *                                                        omits it.
 * @param {{written?: boolean, push?: boolean}} [options] `written` false holds
 *                                                        the list off the bar,
 *                                                        true by default; `push`
 *                                                        makes each change a
 *                                                        Back entry, false by
 *                                                        default.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and its setter.
 */
export function useQueryParamList( param, restore, encode, options ) {
	return useMirroredParam( param, true, restore, encode, options );
}

/**
 * Own a value the bar mirrors, through the bundle's one bar store: `restore`
 * and `encode` are the param's codec, `restore` reading an absent param and
 * `encode` saying what the bar omits, so every reader of the param, and
 * every `setQueryParams`, shares one value. The store cleans the bar on mount, writes each set back and
 * reads it off the bar again, and answers Back as `push` says.
 *
 * `written` false holds the value off the bar, for state whose view is shut:
 * it is kept as ever, the bar names nothing in its place, and names it again
 * once `written` turns true.
 *
 * @template T
 * @param {string}                           param             Param name.
 * @param {boolean}                          list              Whether the
 *                                                             param is one
 *                                                             `?param=` per
 *                                                             item.
 * @param {(raw: *) => T}                    restore           Decode and
 *                                                             validate a read.
 * @param {(value: T) => ?(string|string[])} encode            The bar's value.
 * @param {Object}                           [options]         Options.
 * @param {boolean}                          [options.written] Whether the bar
 *                                                             names the value;
 *                                                             true by default.
 * @param {boolean}                          [options.push]    Whether a change
 *                                                             is a Back entry;
 *                                                             false by default.
 * @return {[T, (next: T|((value: T) => T)) => void]}
 *   The value and its setter.
 */
function useMirroredParam(
	param,
	list,
	restore,
	encode,
	{ written = true, push = false } = {}
) {
	const entry = openParam( param, {
		list,
		parse: restore,
		format: encode,
		push,
	} );
	useEffect( () => setParamWritten( entry, written ), [ entry, written ] );
	return useSlot( BAR, entry );
}

/**
 * Own a choice from a list, the shape of every dropdown and sort key.
 *
 * `values` is the validation whitelist, so a link naming a choice a fixed list
 * does not offer opens on `fallback`. A list that arrives with a reply passes
 * null until then, and the link is trusted meanwhile: the hook answers its
 * value at once, and drops it, bar and all, if the landed list lacks it. An
 * empty list judges nothing — a refused or empty reply is not a verdict — so
 * it is trusted the same way.
 *
 * `written` false holds the choice off the bar, as `useQueryParamState`
 * does, and the choice is still validated.
 *
 * @param {string}    param             Query-string parameter name.
 * @param {?string[]} values            Every choice the control offers; null
 *                                      or empty while the list has not loaded.
 * @param {string}    fallback          The default, which the bar leaves out.
 * @param {Object}    [options]         Options.
 * @param {boolean}   [options.written] Whether the bar names the choice;
 *                                      true by default.
 * @return {[string, import('react').Dispatch<import('react').SetStateAction<string>>]}
 *   The choice and its setter.
 */
export function useQueryParamChoice( param, values, fallback, options ) {
	const [ choice, setChoice ] = useQueryParamState(
		param,
		( raw ) => raw ?? fallback,
		( value ) => ( value === fallback ? null : value ),
		options
	);
	const shown =
		! values?.length || values.includes( choice ) ? choice : fallback;

	useEffect( () => {
		if ( shown !== choice ) {
			setChoice( shown );
		}
	}, [ shown, choice, setChoice ] );

	return [ shown, setChoice ];
}

/**
 * Own an off-by-default toggle, written `?param=1` while on.
 *
 * @param {string}  param             Query-string parameter name.
 * @param {Object}  [options]         Options.
 * @param {boolean} [options.written] Whether the bar names the toggle, as
 *                                    `useQueryParamState` reads it; true by
 *                                    default.
 * @return {[boolean, import('react').Dispatch<import('react').SetStateAction<boolean>>]}
 *   Whether it is on, and its setter.
 */
export function useQueryParamFlag( param, options ) {
	return useQueryParamState(
		param,
		( raw ) => '1' === raw,
		( on ) => ( on ? '1' : null ),
		options
	);
}
