/**
 * DevTools tab registry — the one place a plugin declares an overlay or hub
 * tab, the way it declares a topology: drop-in, contributed, shadowable. Tabs
 * are React components, so the registry is JS and a bundle registers at import
 * time; PHP only enqueues the contributed bundles, through the
 * `newspack_nodes/devtools_tab_bundles` filter.
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 */

/**
 * One registered tab. `getDevtoolsTabs()` returns these with `order` and `slug`
 * already resolved, so no reader repeats the defaulting.
 *
 * @typedef {Object} DevtoolsTab
 * @property {string}                             id          Unique key; registering it again shadows whatever held it.
 * @property {string}                             label       Tab-bar label.
 * @property {string}                             host        Where the tab shows: `overlay`, `hub` or `both`.
 * @property {import('react').ComponentType<any>} component   Panel body, mounted with the host's `tabProps` plus `host`.
 * @property {number}                             [order]     Sort weight, ties broken alphabetically by label.
 * @property {string}                             [slug]      Deep-link slug (`?tab=<slug>`); defaults to the id.
 * @property {string}                             [param]     Query param the tab owns, such as `topology` or `log`; the host clears it while another tab is active.
 * @property {() => boolean}                      [gate]      Excludes the tab while it returns false.
 * @property {import('react').ReactNode}          [icon]      Rendered before the label in the tab bar.
 * @property {boolean}                            [fullBleed] The tab owns a full-height canvas, so the host gives it the bare pane instead of the default scroll container.
 */

/**
 * The registry itself.
 *
 * @typedef {Object} TabStore
 * @property {Map<string,DevtoolsTab>} tabs      Descriptors by id.
 * @property {Array<DevtoolsTab>|null} sorted    Sort memo; null asks the next read to rebuild it.
 * @property {number}                  version   Bumped on every mutation — the `useSyncExternalStore` snapshot.
 * @property {Set<() => void>}         listeners Subscribers called after every mutation.
 */

/**
 * Window key holding the one registry every copy of this module shares.
 *
 * Each tab-bearing bundle is its own IIFE and inlines this module, so a
 * module-local Map gives the hub page one registry per bundle: the host reads
 * its own empty copy and shows no tabs while three bundles register into theirs.
 */
const GLOBAL_KEY = '__newspackNodesDevtoolsTabs';

/**
 * Read the shared registry, creating it on first touch.
 *
 * @return {TabStore} The process-wide store.
 */
function store() {
	// These bundles only run in the browser (jest provides window too).
	if ( ! window[ GLOBAL_KEY ] ) {
		window[ GLOBAL_KEY ] = {
			tabs: new Map(),
			sorted: null,
			version: 0,
			listeners: new Set(),
		};
	}
	return window[ GLOBAL_KEY ];
}

/**
 * Publish a mutation: bump the version, then call every subscriber.
 *
 * @param {TabStore} s The store just mutated.
 */
function notify( s ) {
	s.version++;
	for ( const listener of s.listeners ) {
		listener();
	}
}

/**
 * The `host` values a descriptor may declare. `both` is a declaration only —
 * a read asks for `overlay` or `hub`, and gets the `both` tabs as well.
 */
const HOSTS = [ 'overlay', 'hub', 'both' ];

/**
 * Register a DevTools tab, replacing any tab already holding its id.
 *
 * Shadowing by id is what lets the hub register a placeholder for a lazy tab
 * and the bundle then swap in the live component under the same identity.
 *
 * @param {DevtoolsTab} descriptor The tab to register.
 */
export function registerDevtoolsTab( descriptor ) {
	const { id, label, host, component } = descriptor;
	if ( ! id || ! label || ! component ) {
		throw new Error(
			'registerDevtoolsTab: id, label, and component are required'
		);
	}
	if ( ! HOSTS.includes( host ) ) {
		throw new Error(
			`registerDevtoolsTab: host must be 'overlay' | 'hub' | 'both', got '${ host }'`
		);
	}
	// Normalize order to a finite number so the comparator never sees NaN.
	const order = Number.isFinite( descriptor.order ) ? descriptor.order : 0;
	// Slug defaults to the id (normalize-at-write) so reads never fall back.
	const slug = descriptor.slug || id;
	const s = store();
	s.tabs.set( id, { ...descriptor, order, slug } );
	s.sorted = null;
	notify( s );
}

/**
 * Subscribe to registry changes, so a host re-renders when a bundle loading
 * after it registers a tab. Pairs with `getDevtoolsTabsVersion` as the
 * `useSyncExternalStore` subscribe half.
 *
 * @param {() => void} listener Called after every register and reset.
 * @return {() => void} Unsubscribe — drops this listener from the registry.
 */
export function subscribeDevtoolsTabs( listener ) {
	const s = store();
	s.listeners.add( listener );
	return () => s.listeners.delete( listener );
}

/**
 * Read the version that changes on every register and reset.
 *
 * `getDevtoolsTabs()` builds a fresh array per call, so it cannot serve as a
 * `useSyncExternalStore` snapshot; this counter can.
 *
 * @return {number} The current version.
 */
export function getDevtoolsTabsVersion() {
	return store().version;
}

/**
 * Tabs a host shows: its own plus every `both` tab, gate-passing, ordered by
 * `order` and then label.
 *
 * The sort is memoized until the next mutation, leaving a read the host and
 * gate filter alone. Gates run per read rather than at registration, so a tab
 * gated on live state appears and disappears without re-registering.
 *
 * @param {string} host `overlay` or `hub`.
 * @return {Array<DevtoolsTab>} Matching descriptors, in tab-bar order.
 */
export function getDevtoolsTabs( host ) {
	const s = store();
	if ( null === s.sorted ) {
		s.sorted = [ ...s.tabs.values() ].sort(
			( a, b ) => a.order - b.order || a.label.localeCompare( b.label )
		);
	}
	return s.sorted.filter(
		( tab ) =>
			( tab.host === host || 'both' === tab.host ) &&
			( ! tab.gate || tab.gate() )
	);
}

/**
 * Drop every registered tab — tests only. Subscribers survive, and the version
 * bump tells them the registry emptied.
 */
export function resetDevtoolsTabs() {
	const s = store();
	s.tabs.clear();
	s.sorted = null;
	notify( s );
}
