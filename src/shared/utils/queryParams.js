/**
 * The `?param=` deep-link surface the admin dashboards read and write.
 *
 * Helpers rather than a `URLSearchParams` at each call site, because a
 * write has to preserve every OTHER param: a tab host clearing `?log=` and a
 * picker setting `?source=` run in the same page, and either one rebuilding
 * the query from what it alone knows drops the other's state.
 *
 * Beside them stands the bar store, one per bundle and keyed by param, which
 * `useQueryParamState` and page state read through: a reader opens a param
 * with a codec and subscribes, and every `setQueryParams` tells the param's
 * readers, so every writer reaches every reader. A param holds what the bar
 * holds, read through its codec; on Back, a param that pushes is read again
 * and one that does not writes its live value back over the restored entry.
 * A view that must not be left yet holds a Back through `holdPop`, which takes
 * the page back to the entry it shows before any reader hears of the one landed
 * on. The store stamps each entry's place in the session history under
 * `newspackNodesBar` in `history.state`, with a token minted once per
 * document, so a hold can go back without writing and an entry stamped
 * before a reload reads as unknown.
 * Params are opened per bundle, but the pop bookkeeping belongs to the page: every
 * bundle's copy of this module shares one record under `__newspackNodesBar`
 * on `window`, holding the shown place, the vetoes and the one popstate
 * listener, which publishes a pop to every copy's readers.
 *
 * Canonical in newspack-nodes, consumed through the `@newspack-nodes/shared`
 * alias.
 */

/**
 * Read a query param from the current URL.
 *
 * A context with no `window` yields null instead of throwing, so call sites
 * carry no guard of their own.
 *
 * @param {string} name Param name.
 * @return {string|null} The value, or null when absent or unreadable.
 */
export function getQueryParam( name ) {
	try {
		return new URLSearchParams( window.location.search ).get( name );
	} catch ( _e ) {
		return null;
	}
}

/**
 * Read every value of a repeated query param, in the order the URL holds them.
 *
 * @param {string} name Param name.
 * @return {string[]} The values; empty when absent or unreadable.
 */
export function getQueryParams( name ) {
	try {
		return new URLSearchParams( window.location.search ).getAll( name );
	} catch ( _e ) {
		return [];
	}
}

/**
 * Set or remove a query param, leaving every other param and the fragment
 * untouched. `setQueryParams` with one entry; see it for the write rules.
 *
 * @param {string}      name  Param name.
 * @param {string|null} value New value; null or '' removes the param.
 */
export function setQueryParam( name, value ) {
	setQueryParams( { [ name ]: value } );
}

/**
 * Set or remove several query params in one history write, leaving every other
 * param and the fragment untouched.
 *
 * The write goes through `history.replaceState` by default: picking a tab or
 * a filter is a state change, not a navigation, so it must neither reload the
 * page nor leave a Back-button entry behind every click. `push` makes it a
 * navigation instead, for a view Back should return to. An empty value removes
 * the param instead of writing `?log=`, which keeps a bare link meaning
 * "whatever this dashboard opens on". A list writes the param once per entry,
 * `?chip=a&chip=b`, so a value may hold any character. An empty entry is
 * skipped, as an empty value is, so a list of none removes the param; a list
 * the URL already holds is left where it stands. A write that would leave the
 * URL as it is makes no history call at all, so a repeated write never stacks
 * entries. While a held Back's return is in flight, the write builds on the
 * shown URL and makes no history call; the return writes it onto the shown
 * entry when it lands.
 *
 * @param {Object<string, ?(string|string[])>} params         Param names to new
 *                                                            values; null, ''
 *                                                            or [] removes one,
 *                                                            and a list skips ''.
 * @param {Object}                             [options]      Options.
 * @param {boolean}                            [options.push] Push a history entry rather
 *                                                            than replace the current one.
 */
export function setQueryParams( params, { push = false } = {} ) {
	const record = bar();
	const { pathname, search, hash } = shownLocation( record );
	const query = new URLSearchParams( search );
	for ( const [ name, value ] of Object.entries( params ) ) {
		if ( Array.isArray( value ) ) {
			const entries = value.filter( ( entry ) => '' !== entry );
			const held = query.getAll( name );
			if ( JSON.stringify( entries ) !== JSON.stringify( held ) ) {
				query.delete( name );
				entries.forEach( ( entry ) => query.append( name, entry ) );
			}
		} else if ( null === value || '' === value ) {
			query.delete( name );
		} else {
			query.set( name, value );
		}
	}
	const next = query.toString();
	const url = `${ pathname }${ next ? `?${ next }` : '' }${ hash }`;
	const moved = url !== `${ pathname }${ search }${ hash }`;
	if ( returning( record ) ) {
		record.shownUrl = url;
	} else {
		if ( moved && push ) {
			const at = indexOf( window.history.state );
			window.history.pushState(
				null === at ? null : stampOf( record, at + 1 ),
				'',
				url
			);
		} else if ( moved ) {
			window.history.replaceState( window.history.state, '', url );
		}
		record.shownUrl = barUrl();
		record.shownIndex = indexOf( window.history.state );
	}
	if ( ! moved ) {
		return;
	}
	for ( const name of Object.keys( params ) ) {
		const entry = opened.get( name );
		if ( entry?.written && 0 < entry.listeners.size && readBar( entry ) ) {
			announce( entry );
		}
	}
}

/**
 * How one param reads and writes. `parse` reads an absent param too, as null
 * or, for a list, [], and `format` says what the bar omits.
 *
 * @typedef  {Object}                                 ParamCodec
 * @property {boolean}                                [list] One `?name=` per item.
 * @property {(raw: ?(string|string[])) => *}         parse  The value of the param.
 * @property {(value: *) => ?(string|Array<?string>)} format The bar's value for a value;
 *                                                           null or '' omits it.
 * @property {boolean}                                [push] Whether a change is a Back
 *                                                           entry.
 */

/**
 * One param a reader opened.
 *
 * @typedef  {Object}          OpenParam
 * @property {string}          name      The param.
 * @property {ParamCodec}      codec     The codec of the reader that last opened it.
 * @property {*}               value     What the bar holds, read through the codec.
 * @property {?string}         raw       The bar's param as last read, as JSON.
 * @property {boolean}         written   Whether the bar names it; false holds it off.
 * @property {Set<() => void>} listeners Its subscribed readers.
 */

/**
 * Each param a reader opened in this bundle, by name.
 *
 * @type {Map<string, OpenParam>}
 */
const opened = new Map();

/** This copy's readers and vetoes; the first enlists its publisher. */
let subscribed = 0;

/** The `history.state` key each entry's place in the session history rides. */
const BAR_INDEX = 'newspackNodesBar';

/** Window key holding the one pop record every copy of this module shares. */
const GLOBAL_KEY = '__newspackNodesBar';

/**
 * The traversal the store is making: where the last pop landed, and where
 * each landing is re-aimed until one lands there.
 *
 * @typedef  {Object}  Traversal
 * @property {number}  at        The place the last pop landed on.
 * @property {number}  target    The place it ends on.
 * @property {boolean} publishes Whether landing there publishes the entry.
 */

/**
 * The page's one pop record. Each bundle inlines this module, and the session
 * history belongs to the page, so every copy reads and writes this one.
 *
 * @typedef  {Object}                   BarRecord
 * @property {string}                   doc        This document's token, which
 *                                                 every stamp it writes carries.
 * @property {string}                   shownUrl   The URL the page shows, which
 *                                                 a held Back puts back.
 * @property {?number}                  shownIndex The shown entry's place, or
 *                                                 null where it carries none.
 * @property {?Traversal}               traversal  The traversal in flight.
 * @property {Set<PopVeto>}             vetoes     Each veto `holdPop` registered.
 * @property {Set<() => void>}          publishers Each copy's `publishPop`,
 *                                                 while it has readers or vetoes.
 * @property {?(() => void)}            listener   The one popstate listener.
 * @property {Object<string, Function>} guards     Leave guards, by surface.
 */

/**
 * Read the page's pop record, creating it on first touch.
 *
 * @return {BarRecord} The record.
 */
function bar() {
	window[ GLOBAL_KEY ] ??= {
		// randomUUID is secure-context only; a plain-HTTP admin lacks it.
		doc: `${ Date.now() }-${ Math.random().toString( 36 ).slice( 2 ) }`,
		shownUrl: '',
		shownIndex: null,
		traversal: null,
		vetoes: new Set(),
		publishers: new Set(),
		listener: null,
		guards: {},
	};
	return window[ GLOBAL_KEY ];
}

/**
 * The place an entry's state stamps, or null for an entry this document never
 * stamped: one another document stamped before a reload is unknown here.
 *
 * @param {*} state The entry's `history.state`.
 * @return {?number} Its place.
 */
function indexOf( state ) {
	const stamp =
		null !== state && 'object' === typeof state
			? state[ BAR_INDEX ]
			: undefined;
	return stamp?.doc === bar().doc && Number.isInteger( stamp.at )
		? stamp.at
		: null;
}

/**
 * The stamp of a place in this document.
 *
 * @param {BarRecord} record The page's pop record.
 * @param {number}    at     The place.
 * @return {Object} The `history.state` entry it rides in.
 */
const stampOf = ( record, at ) => ( {
	[ BAR_INDEX ]: { doc: record.doc, at },
} );

/**
 * Stamp the entry the page loaded on as the first place, unless another copy
 * of this module in this document already did, or its state is not an object
 * the stamp can join.
 */
function stampLanding() {
	if ( 'undefined' === typeof window ) {
		return;
	}
	const fresh = ! window[ GLOBAL_KEY ];
	const record = bar();
	const { state } = window.history;
	if (
		fresh &&
		null === indexOf( state ) &&
		( null === state || 'object' === typeof state )
	) {
		window.history.replaceState(
			{ ...state, ...stampOf( record, 0 ) },
			''
		);
	}
}

stampLanding();

/**
 * What a codec reads a param's bar value as.
 *
 * @param {ParamCodec}         codec The param's codec.
 * @param {?(string|string[])} raw   What the bar holds, or would.
 * @return {*} The value.
 */
function valueOf( codec, raw ) {
	return codec.parse( null === raw && codec.list ? [] : raw );
}

/**
 * Tell a slot's readers it moved: a param here, or page state's held key.
 *
 * @param {{listeners: Set<() => void>}} slot The slot.
 */
export const announce = ( slot ) =>
	slot.listeners.forEach( ( listener ) => listener() );

/**
 * Whether a held Back's return is in flight, so the page shows an entry the
 * bar does not hold.
 *
 * @param {BarRecord} record The page's pop record.
 * @return {boolean} Whether one is.
 */
const returning = ( record ) =>
	null !== record.traversal && ! record.traversal.publishes;

/**
 * Where the page shows: the shown URL while a return is in flight, the bar
 * otherwise.
 *
 * @param {BarRecord} record The page's pop record.
 * @return {{pathname: string, search: string, hash: string}} The location.
 */
const shownLocation = ( record ) =>
	returning( record )
		? new URL( record.shownUrl, window.location.href )
		: window.location;

/**
 * Read a param off the bar through its codec, when the bar moved since.
 *
 * @param {OpenParam} entry The param.
 * @return {boolean} Whether its value moved.
 */
function readBar( entry ) {
	const query = new URLSearchParams( shownLocation( bar() ).search );
	const raw = entry.codec.list
		? query.getAll( entry.name )
		: query.get( entry.name );
	const json = JSON.stringify( raw );
	if ( json === entry.raw ) {
		return false;
	}
	entry.raw = json;
	entry.value = valueOf( entry.codec, raw );
	return true;
}

/**
 * The bar's value for a value: only the non-empty strings of a list.
 *
 * @param {ParamCodec} codec The param's codec.
 * @param {*}          value The value.
 * @return {?(string|string[])} The bar's value, null to omit the param.
 */
function barFor( codec, value ) {
	const formatted = codec.format( value );
	if ( Array.isArray( formatted ) ) {
		return formatted.filter(
			( item ) => 'string' === typeof item && '' !== item
		);
	}
	return '' === formatted || undefined === formatted ? null : formatted;
}

/**
 * What the bar should hold for a param now: nothing while it is held off.
 *
 * @param {OpenParam} entry The param.
 * @return {?(string|string[])} The bar's value.
 */
const barOf = ( entry ) =>
	entry.written ? barFor( entry.codec, entry.value ) : null;

/**
 * Answers whether to hold a Back or Forward before any reader hears of it.
 * Only `true` holds; `proceed` finishes the held traversal later.
 *
 * @callback PopVeto
 * @param {URLSearchParams} incoming The params of the entry landed on.
 * @param {() => void}      proceed  Lands on that entry after all.
 * @return {boolean} Whether to hold.
 */

/**
 * Hold a Back or Forward while a veto answers `true`: the store tells no
 * reader and goes back to the entry the page shows in one `history.go()`,
 * writing nothing, and its own return asks no veto. The veto's `proceed`
 * later goes to the entry landed on and publishes it, so every pushing param
 * it moved returns and the history stays as the user built it. Each pop
 * landing short of where the store aims is re-aimed from where it landed, and
 * one straying further than the pop before it asks the vetoes again, as a
 * user's Back or Forward does. An entry this document never stamped falls back
 * to writing the shown URL over the landed entry with a replace, and
 * `proceed` writes the landed URL back. One veto, in any bundle's copy of
 * this module, holds a pop for every copy's readers.
 *
 * @param {PopVeto} veto Asked on every Back or Forward while registered.
 * @return {() => void} Releases the veto.
 */
export function holdPop( veto ) {
	bar().vetoes.add( veto );
	countPopReader( 1 );
	return () => {
		bar().vetoes.delete( veto );
		countPopReader( -1 );
	};
}

/**
 * The page's leave guards by surface, kept on the pop record so every
 * bundle's copy of a guard module answers alike.
 *
 * @return {Object<string, Function>} Each surface's guard.
 */
export const leaveGuards = () => bar().guards;

/**
 * Count a reader or veto in or out, enlisting this copy's publisher on the
 * first and withdrawing it on the last.
 *
 * @param {1|-1} delta One in, or one out.
 */
function countPopReader( delta ) {
	subscribed += delta;
	if ( 1 === subscribed && 1 === delta ) {
		bar().publishers.add( publishPop );
	} else if ( 0 === subscribed ) {
		bar().publishers.delete( publishPop );
	}
	armPopstate( bar() );
}

/**
 * Arm the page's one popstate listener while any copy enlists, and disarm it
 * when the last copy leaves, forgetting any traversal in flight either way.
 *
 * @param {BarRecord} record The page's pop record.
 */
function armPopstate( record ) {
	const listening = 0 < record.publishers.size;
	if ( listening === ( null !== record.listener ) ) {
		return;
	}
	record.traversal = null;
	if ( listening ) {
		record.shownUrl = barUrl();
		record.shownIndex = indexOf( window.history.state );
		record.listener = restoreOnPop;
		window.addEventListener( 'popstate', restoreOnPop );
	} else {
		window.removeEventListener( 'popstate', record.listener );
		record.listener = null;
	}
}

/**
 * The URL the bar holds now.
 *
 * @return {string} Path, query and fragment.
 */
function barUrl() {
	const { pathname, search, hash } = window.location;
	return `${ pathname }${ search }${ hash }`;
}

/**
 * Re-aim a pop that lands short of the traversal in flight, finish one that
 * lands on its target, and ask every veto about any other; reads only the
 * page's record, whichever copy armed it.
 */
function restoreOnPop() {
	const record = bar();
	const { state } = window.history;
	const landed = indexOf( state );
	const { traversal } = record;
	record.traversal = null;
	if ( null !== landed && traversal ) {
		const { at, target, publishes } = traversal;
		// A go can drop or land late, so only a pop straying further asks.
		if (
			publishes ||
			Math.abs( target - landed ) <= Math.abs( target - at )
		) {
			aim( record, landed, target, publishes );
			return;
		}
	}
	askVetoes( record, state, landed );
}

/**
 * Ask every veto about the entry a user's Back or Forward landed on, then
 * hold it or let it through.
 *
 * @param {BarRecord} record The page's pop record.
 * @param {*}         state  The landed entry's `history.state`.
 * @param {?number}   landed The landed entry's place.
 */
function askVetoes( record, state, landed ) {
	const from = record.shownIndex;
	const traversable = null !== landed && null !== from && landed !== from;
	const url = barUrl();
	const incoming = new URLSearchParams( window.location.search );
	// Proceed passes the pop while asked, lands it once held, then nothing.
	let phase = 'asking';
	const proceed = () => {
		if ( 'asking' === phase ) {
			phase = 'proceeded';
		} else if ( 'held' === phase ) {
			phase = 'done';
			if ( record.traversal ) {
				Object.assign( record.traversal, {
					target: landed,
					publishes: true,
				} );
			} else if ( traversable ) {
				aim( record, from, landed, true );
			} else {
				window.history.replaceState( state, '', url );
				publish( record );
			}
		}
	};
	for ( const veto of record.vetoes ) {
		if ( true === veto( incoming, proceed ) && 'asking' === phase ) {
			phase = 'held';
			if ( traversable ) {
				aim( record, landed, from, false );
			} else {
				window.history.replaceState( state, '', record.shownUrl );
			}
			return;
		}
		if ( 'asking' !== phase ) {
			break;
		}
	}
	phase = 'done';
	publish( record );
}

/**
 * Aim a traversal from where the page stands at a place, or finish there:
 * publish the entry, or write back what the page wrote while it returned.
 *
 * @param {BarRecord} record    The page's pop record.
 * @param {number}    at        The place the page stands on.
 * @param {number}    target    The place to end on.
 * @param {boolean}   publishes Whether landing there publishes the entry.
 */
function aim( record, at, target, publishes ) {
	if ( at === target ) {
		if ( publishes ) {
			publish( record );
		} else if ( record.shownUrl !== barUrl() ) {
			window.history.replaceState(
				window.history.state,
				'',
				record.shownUrl
			);
		}
		return;
	}
	record.traversal = { at, target, publishes };
	window.history.go( target - at );
}

/**
 * Publish the entry landed on to every copy's readers.
 *
 * @param {BarRecord} record The page's pop record.
 */
function publish( record ) {
	record.publishers.forEach( ( publisher ) => publisher() );
}

/**
 * Write every subscribed param that does not push back over the entry Back
 * or Forward restored, and read every one that pushes off it.
 */
function publishPop() {
	/** @type {Object<string, ?(string|string[])>} */
	const live = {};
	for ( const entry of opened.values() ) {
		if ( 0 === entry.listeners.size ) {
			continue;
		}
		if ( ! entry.codec.push ) {
			live[ entry.name ] = barOf( entry );
		} else if ( readBar( entry ) ) {
			announce( entry );
		}
	}
	setQueryParams( live );
}

/**
 * Open a param for a reader, adopting its codec. A param whose readers have
 * all gone is read off the bar again, since the bar may have moved since.
 *
 * @param {string}     name  The param.
 * @param {ParamCodec} codec How it reads and writes.
 * @return {OpenParam} The param.
 */
export function openParam( name, codec ) {
	let entry = opened.get( name );
	if ( ! entry ) {
		entry = {
			name,
			codec,
			value: undefined,
			raw: null,
			written: true,
			listeners: new Set(),
		};
		opened.set( name, entry );
	}
	entry.codec = codec;
	if ( 0 === entry.listeners.size ) {
		entry.raw = null;
		entry.written = true;
		readBar( entry );
	}
	return entry;
}

/**
 * Subscribe a reader to a param. The param's first reader reads a written
 * param off the bar again, since it may have moved after the render that
 * opened it, then cleans the bar, dropping a value `parse` rejected and a
 * default written out.
 *
 * @param {OpenParam}  entry    The param.
 * @param {() => void} listener Told when it moves.
 * @return {() => void} Unsubscribes.
 */
export function subscribeParam( entry, listener ) {
	entry.listeners.add( listener );
	countPopReader( 1 );
	if ( 1 === entry.listeners.size ) {
		if ( entry.written && readBar( entry ) ) {
			announce( entry );
		}
		setQueryParams( { [ entry.name ]: barOf( entry ) } );
	}
	return () => {
		entry.listeners.delete( listener );
		countPopReader( -1 );
	};
}

/**
 * What a param would hold once set to a value: the value the bar reads it
 * back as, so the page shows what a reload would.
 *
 * @param {OpenParam} entry The param.
 * @param {*}         value The value set.
 * @return {*} The value read back.
 */
export const peekParam = ( entry, value ) =>
	valueOf( entry.codec, barFor( entry.codec, value ) );

/**
 * Set a param: written to the bar, pushed when its codec pushes, and read
 * back off it. A param held off the bar takes the value it would read back.
 *
 * @param {OpenParam} entry The param.
 * @param {*}         value The value.
 */
export function setParam( entry, value ) {
	if ( entry.written ) {
		setQueryParams(
			{ [ entry.name ]: barFor( entry.codec, value ) },
			{ push: !! entry.codec.push }
		);
		return;
	}
	entry.value = peekParam( entry, value );
	announce( entry );
}

/**
 * Name a param on the bar, or hold it off while the view it belongs to is
 * shut; a held param keeps its value.
 *
 * @param {OpenParam} entry   The param.
 * @param {boolean}   written Whether the bar names it.
 */
export function setParamWritten( entry, written ) {
	if ( written !== entry.written ) {
		entry.written = written;
		setQueryParams( { [ entry.name ]: barOf( entry ) } );
	}
}
