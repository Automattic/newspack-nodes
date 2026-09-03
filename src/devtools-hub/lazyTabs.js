/**
 * Lazy hub tabs — the placeholders that keep four heavy tab bundles off the
 * DevTools hub's initial page load. Console, Vault, Sessions and Aggregator
 * together weigh roughly 600KB of minified JS, and a reader opens one of them.
 *
 * Their `newspack_nodes/devtools_tab_bundles` contributions declare `lazy`, so
 * `Admin::enqueue_devtools_tab_bundles()` skips the enqueue and localizes a load
 * recipe for each onto `window.NewspackNodesLazyTabs` instead.
 *
 * This module registers a placeholder per bundle carrying that tab's shared
 * `tabMeta` — the descriptor the bundle's own `tabs.js` spreads — so the tab bar
 * and the `?tab=` deep link resolve the same label, slug, order and `fullBleed`
 * flag before anything loads. Two spellings of that metadata would show as two
 * tabs.
 *
 * On first activation the placeholder injects its bundle, whose
 * `registerDevtoolsTab` call shadows this descriptor with the live component
 * under the same id — the registry's last-register-wins rule, not a lazy-tab
 * special case.
 */

import { useEffect } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import consoleMeta from '../topology-console/tabMeta';
import vaultMeta from '../vault/tabMeta';
import sessionsMeta from '../sessions/tabMeta';
import aggregatorMeta from '../event-aggregator/tabMeta';
import { loadTabBundle } from './loadTabBundle';

/**
 * Every lazy tab's shared descriptor beside the enqueue handle Admin localizes
 * its load recipe under. That handle is the only join between the two halves,
 * and it need not resemble the build directory — Aggregator ships from
 * `event-aggregator` under `newspack-nodes-aggregator-tab` — so a rename on the
 * PHP side has to land here too.
 *
 * @type {Array<{meta:Object,handle:string}>}
 */
const LAZY_TABS = [
	{ meta: consoleMeta, handle: 'newspack-nodes-topology-console' },
	{ meta: vaultMeta, handle: 'newspack-nodes-vault' },
	{ meta: sessionsMeta, handle: 'newspack-nodes-sessions' },
	{ meta: aggregatorMeta, handle: 'newspack-nodes-aggregator-tab' },
];

/**
 * A tab's stand-in until its bundle arrives: injects the bundle on mount and
 * renders a loading line in the meantime.
 *
 * The host mounts only the active tab, so mounting IS first activation. The
 * injection belongs in an effect because it appends to the document, and a
 * re-mount costs nothing — `loadTabBundle` is idempotent per handle. Nothing
 * here swaps in the real component: the bundle's own registration bumps the
 * registry version, and the host re-renders with what the bundle registered.
 *
 * @param {Object} props
 * @param {string} props.handle Enqueue handle naming the bundle to inject.
 * @return {import('react').ReactElement} The loading placeholder.
 */
function LazyTabPlaceholder( { handle } ) {
	useEffect( () => {
		loadTabBundle( handle );
	}, [ handle ] );
	return (
		<div className="newspack-nodes-performance-loading nodes-devtools__lazy-loading">
			{ __( 'Loading…', 'newspack-nodes' ) }
		</div>
	);
}

/**
 * Register a placeholder for every lazy tab.
 *
 * Each descriptor's `component` closes over that tab's handle, so the mounted
 * placeholder knows which bundle to inject without reading the registry back.
 */
export function registerLazyTabs() {
	for ( const { meta, handle } of LAZY_TABS ) {
		registerDevtoolsTab( {
			...meta,
			component: () => <LazyTabPlaceholder handle={ handle } />,
		} );
	}
}
