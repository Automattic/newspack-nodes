/**
 * Lazy hub tabs — the heavy tab bundles (Console, Vault, Sessions, Aggregator) are NOT
 * enqueued up front (~870KB of tab JS for one screen). The hub registers a
 * lightweight placeholder for each, carrying the tab's metadata from its shared
 * `tabMeta` so the tab bar and `?tab=` deep-link work before the bundle loads.
 * On first activation the placeholder injects the real bundle, whose own
 * `registerDevtoolsTab` shadows this descriptor with the live component.
 */

import { useEffect } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import consoleMeta from '../topology-console/tabMeta';
import vaultMeta from '../vault/tabMeta';
import sessionsMeta from '../sessions/tabMeta';
import aggregatorMeta from '../event-aggregator/tabMeta';
import { loadTabBundle } from './loadTabBundle';

// tabMeta ↔ the enqueue handle Admin localizes into NewspackNodesLazyTabs.
const LAZY_TABS = [
	{ meta: consoleMeta, handle: 'newspack-nodes-topology-console' },
	{ meta: vaultMeta, handle: 'newspack-nodes-vault' },
	{ meta: sessionsMeta, handle: 'newspack-nodes-sessions' },
	{ meta: aggregatorMeta, handle: 'newspack-nodes-aggregator-tab' },
];

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

/** Register the lazy placeholders; a bundle's real component shadows on load. */
export function registerLazyTabs() {
	for ( const { meta, handle } of LAZY_TABS ) {
		registerDevtoolsTab( {
			...meta,
			component: () => <LazyTabPlaceholder handle={ handle } />,
		} );
	}
}
