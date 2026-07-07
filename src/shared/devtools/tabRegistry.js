/**
 * DevTools tab registry — the one place a plugin declares an overlay/hub tab,
 * the way it declares a topology: drop-in, contributed, shadowable. Tabs are
 * React components, so this is a JS registry (a bundle calls registerDevtoolsTab
 * at import); a thin PHP filter (P2) only enqueues contributor bundles.
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 * See docs/superpowers/specs/2026-06-14-devtools-hub-tab-api-design.md.
 */

// The build emits each bundle (devtools-hub, event-dashboards, topology-console)
// as its own IIFE inlining its own copy of this module — so a module-local Map
// would give every bundle on the page a SEPARATE registry, and the hub host
// (which imports no tabs) would never see the tabs the other bundles register.
// Back the store with a process-wide singleton on the global so all the
// separately-built copies share ONE registry. Both the `tabs` Map and the
// `sorted` memo live there, so a register-side memo invalidation is visible to
// the hub's read.
const GLOBAL_KEY = '__newspackNodesDevtoolsTabs';

// id → descriptor. Last registration with an id wins (shadow), mirroring
// user-shadows-stock topology resolution. sorted is the memoized sorted view,
// rebuilt only when a tab registers/resets — settle the sort at the earliest
// stage, not on every getDevtoolsTabs() call. The per-call work is just the
// cheap host/gate filter (gate may depend on runtime state).
function store() {
	// These IIFE bundles only ever run in the browser (jest provides window
	// too), matching the bare-window convention in src/shared/utils.
	if ( ! window[ GLOBAL_KEY ] ) {
		window[ GLOBAL_KEY ] = {
			tabs: new Map(),
			sorted: null,
			// Bumped on every register/reset; the host reads it via
			// useSyncExternalStore so a LATE-registering bundle (common when a
			// backgrounded tab throttles script loading past the host's first
			// render) re-renders the tab bar instead of being dropped.
			version: 0,
			listeners: new Set(),
		};
	}
	return window[ GLOBAL_KEY ];
}

// Bump the version + fire subscribers after any registry mutation.
function notify( s ) {
	s.version++;
	for ( const listener of s.listeners ) {
		listener();
	}
}

const HOSTS = [ 'overlay', 'hub', 'both' ];

/**
 * Register a DevTools tab.
 *
 * @param {Object}   descriptor
 * @param {string}   descriptor.id          Unique id; re-register = shadow.
 * @param {string}   descriptor.label       Tab-bar label.
 * @param {string}   descriptor.host        'overlay' | 'hub' | 'both'.
 * @param {Function} descriptor.component   React component for the panel.
 * @param {number}   [descriptor.order=0]   Sort weight; alpha by label within a weight.
 * @param {string}   [descriptor.slug]      URL slug for deep-linking (`?tab=<slug>`); defaults to `id`.
 * @param {string}   [descriptor.param]     Query param the tab owns (e.g. `topology`, `log`); cleared from the URL when another tab is active.
 * @param {Function} [descriptor.gate]      Optional () => boolean; excluded when it returns false.
 * @param {*}        [descriptor.icon]      Optional @wordpress/icons element.
 * @param {boolean}  [descriptor.fullBleed] Tab owns its own full-height canvas; opts out of the host's default scroll container.
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
	// Normalize order to a finite number so the sort comparator can never see
	// NaN (an explicit non-finite order would otherwise corrupt ordering silently).
	const order = Number.isFinite( descriptor.order ) ? descriptor.order : 0;
	// Slug defaults to the id, mirroring `order`'s normalize-at-write so the
	// read side never has to fall back.
	const slug = descriptor.slug || id;
	const s = store();
	s.tabs.set( id, { ...descriptor, order, slug } );
	s.sorted = null;
	notify( s );
}

/**
 * Subscribe to registry changes (register/reset). The host re-renders on a
 * change so late-registered tabs appear.
 *
 * @param {Function} listener Called on each change.
 * @return {Function} Unsubscribe.
 */
export function subscribeDevtoolsTabs( listener ) {
	const s = store();
	s.listeners.add( listener );
	return () => s.listeners.delete( listener );
}

/** @return {number} A version that changes on every register/reset — the useSyncExternalStore snapshot. */
export function getDevtoolsTabsVersion() {
	return store().version;
}

/**
 * Tabs for a host: deduped, gate-passing, pre-sorted (order asc, then label).
 *
 * @param {string} host 'overlay' | 'hub'.
 * @return {Array<Object>} Matching tab descriptors.
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

/** Clear the registry — tests only. */
export function resetDevtoolsTabs() {
	const s = store();
	s.tabs.clear();
	s.sorted = null;
	notify( s );
}
