/**
 * DevTools tab registry — the one place a plugin declares an overlay/hub tab,
 * the way it declares a topology: drop-in, contributed, shadowable. Tabs are
 * React components, so this is a JS registry (a bundle calls registerDevtoolsTab
 * at import); a thin PHP filter (P2) only enqueues contributor bundles.
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 * See docs/superpowers/specs/2026-06-14-devtools-hub-tab-api-design.md.
 */

// id → descriptor. Last registration with an id wins (shadow), mirroring
// user-shadows-stock topology resolution.
const tabs = new Map();

// Memoized sorted view, rebuilt only when a tab registers/resets — settle the
// sort at the earliest stage, not on every getDevtoolsTabs() call. The per-call
// work is just the cheap host/gate filter (gate may depend on runtime state).
let sorted = null;

const HOSTS = [ 'overlay', 'hub', 'both' ];

/**
 * Register a DevTools tab.
 *
 * @param {Object}   descriptor
 * @param {string}   descriptor.id        Unique id; re-register = shadow.
 * @param {string}   descriptor.label     Tab-bar label.
 * @param {string}   descriptor.host      'overlay' | 'hub' | 'both'.
 * @param {Function} descriptor.component React component for the panel.
 * @param {number}   [descriptor.order=0] Sort weight; alpha by label within a weight.
 * @param {Function} [descriptor.gate]    Optional () => boolean; excluded when it returns false.
 * @param {*}        [descriptor.icon]    Optional @wordpress/icons element.
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
	tabs.set( id, { ...descriptor, order } );
	sorted = null;
}

/**
 * Tabs for a host: deduped, gate-passing, pre-sorted (order asc, then label).
 *
 * @param {string} host 'overlay' | 'hub'.
 * @return {Array<Object>} Matching tab descriptors.
 */
export function getDevtoolsTabs( host ) {
	if ( null === sorted ) {
		sorted = [ ...tabs.values() ].sort(
			( a, b ) => a.order - b.order || a.label.localeCompare( b.label )
		);
	}
	return sorted.filter(
		( tab ) =>
			( tab.host === host || 'both' === tab.host ) &&
			( ! tab.gate || tab.gate() )
	);
}

/** Clear the registry — tests only. */
export function resetDevtoolsTabs() {
	tabs.clear();
	sorted = null;
}
