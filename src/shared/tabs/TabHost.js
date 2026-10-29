/**
 * Shared tab host — the tab bar, the selected-tab state and the lazy
 * mount behind BOTH surfaces, the floating debug overlay and the full-page
 * admin station. One component owns tab selection, so the two cannot drift in how a
 * tab is chosen, mounted or deep-linked; each host supplies its scope (`host`),
 * the props its tabs need, and its own surrounding chrome.
 *
 * It reads the registry for the given `host`, renders a bar (hidden when ≤1 tab),
 * and mounts ONLY the selected tab's component (keyed on the active id so each
 * tab's build-before-render runs fresh on switch). The component is told which
 * `host` it landed in and is spread the host's `tabProps`.
 *
 * The active tab mounts inside a per-tab scroll container
 * (`.nodes-tab-host__tab-content`): it scrolls vertically by default, so a long
 * list tab (the Topology Manager) stays usable inside the station's fixed wrapper. A
 * tab declaring `fullBleed: true` (the Topology Console, which owns its own
 * full-height canvas) opts out via `.is-full-bleed`.
 *
 * With `syncUrl` the host also owns the page's query string: the initial tab
 * comes from `?tab=<slug>`, the resolved tab is mirrored back through
 * `replaceState`, and a tab's declared `param` survives only while that tab is
 * showing. The overlay and every other consumer stay URL-free.
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 */
import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { getTabs, subscribeTabs, getTabsVersion } from './tabRegistry';
import TabBar, { tabDomId, panelDomId } from './TabBar';
import { getQueryParam, setQueryParam } from '../utils/queryParams';
import './TabHost.scss';

/**
 * Renders one station surface: its tab bar, and the tab it has selected.
 *
 * The routing `host` is applied after `tabProps` is spread, so a caller cannot
 * hand a tab the wrong surface even by putting `host` in `tabProps`.
 *
 * @param {Object}                props
 * @param {'overlay'|'station'}   props.host                Which registry scope to render.
 * @param {Object}                [props.tabProps]          Extra props spread into the mounted tab.
 * @param {*}                     [props.emptyState]        Rendered when no tab matches the host.
 * @param {(id?: string) => void} [props.onActiveTabChange] Called with the resolved active tab id on mount and on every switch, and with `undefined` while the host has no tabs — lets a host key sibling chrome (the station's debug overlay) on which tab is showing. A switch reports from the click and again from the effect behind it, so the handler tolerates a repeated id.
 * @param {boolean}               [props.syncUrl]           Mirror the active tab into `?tab=<slug>` via replaceState; the initial tab is read from `?tab=`. Default false (overlay + other consumers stay URL-free).
 * @return {*} The tab bar and the selected tab, or the empty state.
 */
export default function TabHost( {
	host,
	tabProps = {},
	emptyState = null,
	onActiveTabChange,
	syncUrl = false,
} ) {
	// Re-render on registry change so late-registered tabs still appear.
	const registryVersion = useSyncExternalStore(
		subscribeTabs,
		getTabsVersion,
		getTabsVersion
	);
	const tabs = getTabs( host );
	// Resolve initial tab now so a fullBleed tab mounts right on first render.
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

	// Capture the initial ?tab= slug once so a late tab is still honored.
	const initialSlugRef = useRef( syncUrl ? getQueryParam( 'tab' ) : null );
	// A user pick is final: it retires the deep link for the rest of the page.
	const pickedRef = useRef( false );
	// Pending until the deep-linked tab wins; URL sync holds off on it.
	const deepLinkPending =
		syncUrl &&
		! pickedRef.current &&
		!! initialSlugRef.current &&
		active?.slug !== initialSlugRef.current;

	// Switch to the deep-linked tab when it registers, unless the user picked.
	useEffect( () => {
		if ( ! syncUrl || pickedRef.current || ! initialSlugRef.current ) {
			return;
		}
		const match = getTabs( host ).find(
			( t ) => t.slug === initialSlugRef.current
		);
		if ( match && match.id !== activeId ) {
			setActiveId( match.id );
		}
	}, [ syncUrl, host, activeId, registryVersion ] );

	// Canonicalize the URL to the resolved tab's slug on mount and on switch.
	const resolvedSlug = active?.slug;
	useEffect( () => {
		// Hold off while a deep-link is pending; don't rewrite ?tab= early.
		if ( ! syncUrl || ! resolvedSlug || deepLinkPending ) {
			return;
		}
		setQueryParam( 'tab', resolvedSlug );
		// Drop the other tabs' params: the URL carries the active tab's alone.
		for ( const t of getTabs( host ) ) {
			if ( t.param && t.slug !== resolvedSlug ) {
				setQueryParam( t.param, null );
			}
		}
	}, [ syncUrl, resolvedSlug, host, deepLinkPending ] );

	// Report the RESOLVED active id so the host always learns the real tab.
	const resolvedId = active?.id;
	useEffect( () => {
		onActiveTabChange?.( resolvedId );
	}, [ resolvedId, onActiveTabChange ] );

	if ( ! Active ) {
		return emptyState;
	}

	const hasBar = tabs.length > 1;

	/**
	 * Select a tab, and retire the deep link so it never overrides the choice.
	 *
	 * The host hears about the switch from here as well as from the effect
	 * above, because chrome keyed on the active tab — the station's overlay, whose
	 * storage key and REPL flag are both per-tab — has to re-render in the same
	 * commit the new tab mounts, not one commit later.
	 *
	 * @param {string} id Id of the tab to show.
	 */
	const pick = ( id ) => {
		pickedRef.current = true;
		setActiveId( id );
		onActiveTabChange?.( id );
	};

	return (
		<>
			{ hasBar && (
				<TabBar
					scope={ host }
					label={ __( 'Developer tools', 'newspack-nodes' ) }
					tabs={ tabs }
					activeId={ active.id }
					onPick={ pick }
				/>
			) }
			<div
				id={ panelDomId( host ) }
				role={ hasBar ? 'tabpanel' : undefined }
				aria-labelledby={
					hasBar ? tabDomId( host, active.id ) : undefined
				}
				className={ `nodes-tab-host__tab-content${
					active.fullBleed ? ' is-full-bleed' : ''
				}` }
			>
				{ /* host must win over any caller-supplied tabProps.host */ }
				<Active key={ active.id } { ...tabProps } host={ host } />
			</div>
		</>
	);
}
