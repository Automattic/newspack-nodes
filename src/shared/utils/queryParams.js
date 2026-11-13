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
 * entries.
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
	const { pathname, search, hash } = window.location;
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
	if ( url === `${ pathname }${ search }${ hash }` ) {
		return;
	}
	if ( push ) {
		window.history.pushState( null, '', url );
	} else {
		window.history.replaceState( window.history.state, '', url );
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

/** Readers subscribed across every param; the first arms popstate. */
let subscribed = 0;

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
 * Read a param off the bar through its codec, when the bar moved since.
 *
 * @param {OpenParam} entry The param.
 * @return {boolean} Whether its value moved.
 */
function readBar( entry ) {
	const raw = entry.codec.list
		? getQueryParams( entry.name )
		: getQueryParam( entry.name );
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
 * Write every subscribed param that does not push back over the entry Back
 * or Forward restored, and read every one that pushes off it.
 */
function restoreOnPop() {
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
	subscribed += 1;
	if ( 1 === subscribed ) {
		window.addEventListener( 'popstate', restoreOnPop );
	}
	if ( 1 === entry.listeners.size ) {
		if ( entry.written && readBar( entry ) ) {
			announce( entry );
		}
		setQueryParams( { [ entry.name ]: barOf( entry ) } );
	}
	return () => {
		entry.listeners.delete( listener );
		subscribed -= 1;
		if ( 0 === subscribed ) {
			window.removeEventListener( 'popstate', restoreOnPop );
		}
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
