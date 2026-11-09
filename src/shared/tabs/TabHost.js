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
 * comes from `?tab=<slug>`, the load canonicalizes it through `replaceState`,
 * each tab switch pushes one Back entry, and Back or Forward shows the tab the
 * landed entry names. A tab's declared `param` survives only while that tab is
 * showing, so the pushed entry drops the param of the tab left behind. The
 * overlay and every other consumer stay URL-free.
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
import TabBar, { useTabPanelProps } from './TabBar';
import { getQueryParam, setQueryParams } from '../utils/queryParams';
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
 * @param {*}                     [props.emptyState]        Rendered when the
 *                                                          host has no tabs.
 * @param {(id?: string) => void} [props.onActiveTabChange] Called with the resolved active tab id on mount and on every switch, and with `undefined` while the host has no tabs — lets a host key sibling chrome (the station's debug overlay) on which tab is showing. A switch reports from the click and again from the effect behind it, so the handler tolerates a repeated id.
 * @param {boolean}               [props.syncUrl]           Mirror the active tab into `?tab=<slug>`: the initial tab is read from `?tab=`, a switch pushes a history entry, and popstate shows the tab the entry names. Default false (overlay + other consumers stay URL-free).
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
		setQueryParams( tabQuery( host, resolvedSlug ) );
	}, [ syncUrl, resolvedSlug, host, deepLinkPending ] );

	// Back or Forward shows the tab the landed entry names.
	useEffect( () => {
		if ( ! syncUrl ) {
			return;
		}
		const restore = () => {
			const hosted = getTabs( host );
			const slug = getQueryParam( 'tab' );
			pickedRef.current = true;
			setActiveId(
				( hosted.find( ( t ) => t.slug === slug ) || hosted[ 0 ] )?.id
			);
		};
		window.addEventListener( 'popstate', restore );
		return () => window.removeEventListener( 'popstate', restore );
	}, [ syncUrl, host ] );

	// Report the RESOLVED active id so the host always learns the real tab.
	const resolvedId = active?.id;
	useEffect( () => {
		onActiveTabChange?.( resolvedId );
	}, [ resolvedId, onActiveTabChange ] );

	const hasBar = tabs.length > 1;
	const panelProps = useTabPanelProps( host, active?.id, hasBar );

	if ( ! Active ) {
		return emptyState;
	}

	/**
	 * Select a tab, and retire the deep link so it never overrides the choice.
	 *
	 * The host hears about the switch from here as well as from the effect
	 * above, because chrome keyed on the active tab — the station's overlay, whose
	 * storage key and REPL flag are both per-tab — has to re-render in the same
	 * commit the new tab mounts, not one commit later.
	 *
	 * With `syncUrl` a switch pushes its entry here, before the new tab mounts,
	 * so the tab's own mount write lands on its entry and not the one left.
	 *
	 * @param {string} id Id of the tab to show.
	 */
	const pick = ( id ) => {
		const next = tabs.find( ( t ) => t.id === id );
		if ( syncUrl && next && id !== active.id ) {
			setQueryParams( tabQuery( host, next.slug ), { push: true } );
		}
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
				{ ...panelProps }
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

/**
 * The query a tab's entry carries: its slug, and every other tab's param gone.
 *
 * @param {'overlay'|'station'} host Which registry scope is showing.
 * @param {string}              slug The active tab's slug.
 * @return {Object<string, ?string>} The params `setQueryParams` writes.
 */
function tabQuery( host, slug ) {
	const query = { tab: slug };
	for ( const t of getTabs( host ) ) {
		if ( t.param && t.slug !== slug ) {
			query[ t.param ] = null;
		}
	}
	return query;
}
