/**
 * Shared DevTools tab host — the tab bar + selected-tab state + lazy mount used
 * by BOTH hosts (the floating overlay and the full-page admin hub). It reads the
 * registry for the given `host`, renders a bar (hidden when ≤1 tab), and mounts
 * ONLY the selected tab's component (keyed on the active id so each tab's
 * build-before-render runs fresh on switch). The component is told which `host`
 * it landed in and is spread the host's `tabProps`.
 *
 * The active tab mounts inside a per-tab scroll container
 * (`.nodes-devtools__tab-content`): it scrolls vertically by default, so a long
 * list tab (the Topology Manager) stays usable inside the hub's fixed wrapper. A
 * tab declaring `fullBleed: true` (the Topology Console, which owns its own
 * full-height canvas) opts out via `.is-full-bleed`.
 */
import { useEffect, useState } from '@wordpress/element';
import { getDevtoolsTabs } from './tabRegistry';
import { getQueryParam, setQueryParam } from '../utils/queryParams';
import './DevtoolsTabHost.scss';

/**
 * @param {Object}   props
 * @param {string}   props.host                'overlay' | 'hub'.
 * @param {Object}   [props.tabProps]          Extra props spread into the mounted tab.
 * @param {*}        [props.emptyState]        Rendered when no tab matches the host.
 * @param {Function} [props.onActiveTabChange] Called with the resolved active tab id on mount and on every switch — lets a host gate sibling chrome (e.g. the hub's debug overlay) on which tab is showing.
 * @param {boolean}  [props.syncUrl]           Mirror the active tab into `?tab=<slug>` via replaceState; the initial tab is read from `?tab=`. Default false (overlay + other consumers stay URL-free).
 * @return {*} The tab bar + selected tab, or the empty state.
 */
export default function DevtoolsTabHost( {
	host,
	tabProps = {},
	emptyState = null,
	onActiveTabChange,
	syncUrl = false,
} ) {
	const tabs = getDevtoolsTabs( host );
	// Compute the initial tab in the initializer so the right tab mounts on the
	// FIRST render (matters for a fullBleed tab that builds before it paints):
	// honor `?tab=<slug>` under syncUrl, else the first tab.
	const [ activeId, setActiveId ] = useState( () => {
		if ( syncUrl ) {
			const slug = getQueryParam( 'tab' );
			const match = tabs.find( ( t ) => t.slug === slug );
			if ( match ) {
				return match.id;
			}
		}
		return tabs[ 0 ]?.id;
	} );
	const active = tabs.find( ( t ) => t.id === activeId ) || tabs[ 0 ];
	const Active = active?.component;

	// Canonicalize the URL to the resolved tab's slug on mount (so a bare
	// `?page=...` gains `&tab=...`) and whenever the resolved tab changes.
	// Preserves sibling params (`&topology=`/`&log=`) — setQueryParam is surgical.
	const resolvedSlug = active?.slug;
	useEffect( () => {
		if ( syncUrl && resolvedSlug ) {
			setQueryParam( 'tab', resolvedSlug );
		}
	}, [ syncUrl, resolvedSlug ] );

	// Report the RESOLVED active id (which may differ from activeId when the
	// stored id no longer matches a tab) so the host always learns the real tab.
	const resolvedId = active?.id;
	useEffect( () => {
		onActiveTabChange?.( resolvedId );
	}, [ resolvedId, onActiveTabChange ] );

	if ( ! Active ) {
		return emptyState;
	}

	return (
		<>
			{ tabs.length > 1 && (
				<div className="nodes-devtools__tabbar" role="tablist">
					{ tabs.map( ( t ) => (
						<button
							key={ t.id }
							type="button"
							role="tab"
							aria-selected={ t.id === active.id }
							className={ `nodes-devtools__tab${
								t.id === active.id ? ' is-active' : ''
							}` }
							onClick={ () => {
								setActiveId( t.id );
								onActiveTabChange?.( t.id );
							} }
						>
							{ t.icon }
							{ t.label }
						</button>
					) ) }
				</div>
			) }
			<div
				className={ `nodes-devtools__tab-content${
					active.fullBleed ? ' is-full-bleed' : ''
				}` }
			>
				{ /* host must win over any caller-supplied tabProps.host */ }
				<Active key={ active.id } { ...tabProps } host={ host } />
			</div>
		</>
	);
}
