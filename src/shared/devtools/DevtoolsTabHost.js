/**
 * Shared DevTools tab host — the tab bar, the selected-tab state and the lazy
 * mount behind BOTH surfaces, the floating debug overlay and the full-page
 * admin hub. One component owns tab selection, so the two cannot drift in how a
 * tab is chosen, mounted or deep-linked; each host supplies its scope (`host`),
 * the props its tabs need, and its own surrounding chrome.
 *
 * It reads the registry for the given `host`, renders a bar (hidden when ≤1 tab),
 * and mounts ONLY the selected tab's component (keyed on the active id so each
 * tab's build-before-render runs fresh on switch). The component is told which
 * `host` it landed in and is spread the host's `tabProps`.
 *
 * The active tab mounts inside a per-tab scroll container
 * (`.nodes-devtools__tab-content`): it scrolls vertically by default, so a long
 * list tab (the Topology Manager) stays usable inside the hub's fixed wrapper. A
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
import {
	getDevtoolsTabs,
	subscribeDevtoolsTabs,
	getDevtoolsTabsVersion,
} from './tabRegistry';
import { getQueryParam, setQueryParam } from '../utils/queryParams';
import './DevtoolsTabHost.scss';

/**
 * Renders one DevTools surface: its tab bar, and the tab it has selected.
 *
 * The routing `host` is applied after `tabProps` is spread, so a caller cannot
 * hand a tab the wrong surface even by putting `host` in `tabProps`.
 *
 * @param {Object}                props
 * @param {'overlay'|'hub'}       props.host                Which registry scope to render.
 * @param {Object}                [props.tabProps]          Extra props spread into the mounted tab.
 * @param {*}                     [props.emptyState]        Rendered when no tab matches the host.
 * @param {(id?: string) => void} [props.onActiveTabChange] Called with the resolved active tab id on mount and on every switch, and with `undefined` while the host has no tabs — lets a host key sibling chrome (the hub's debug overlay) on which tab is showing. A switch reports from the click and again from the effect behind it, so the handler tolerates a repeated id.
 * @param {boolean}               [props.syncUrl]           Mirror the active tab into `?tab=<slug>` via replaceState; the initial tab is read from `?tab=`. Default false (overlay + other consumers stay URL-free).
 * @return {*} The tab bar and the selected tab, or the empty state.
 */
export default function DevtoolsTabHost( {
	host,
	tabProps = {},
	emptyState = null,
	onActiveTabChange,
	syncUrl = false,
} ) {
	// Re-render on registry change so late-registered tabs still appear.
	const registryVersion = useSyncExternalStore(
		subscribeDevtoolsTabs,
		getDevtoolsTabsVersion,
		getDevtoolsTabsVersion
	);
	const tabs = getDevtoolsTabs( host );
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
		const match = getDevtoolsTabs( host ).find(
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
		for ( const t of getDevtoolsTabs( host ) ) {
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

	/**
	 * DOM id of one tab button, which its panel points back at.
	 *
	 * The id carries the host because the hub renders the floating overlay
	 * beside its own tabs, putting both surfaces on one page.
	 *
	 * @param {import('./tabRegistry').DevtoolsTab} t The tab descriptor.
	 * @return {string} The button's DOM id.
	 */
	const tabDomId = ( t ) => `nodes-devtools-tab-${ host }-${ t.id }`;
	const panelDomId = `nodes-devtools-panel-${ host }`;
	const hasBar = tabs.length > 1;

	/**
	 * Select a tab, and retire the deep link so it never overrides the choice.
	 *
	 * The host hears about the switch from here as well as from the effect
	 * above, because chrome keyed on the active tab — the hub's overlay, whose
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

	/**
	 * Move and select with the keyboard, per the WAI-ARIA tabs pattern.
	 *
	 * Arrows wrap at both ends, Home and End jump to the edges, and selection
	 * follows focus — which is what the roving `tabIndex` on the buttons is
	 * for. Every other key falls through untouched, so Tab still leaves the bar.
	 *
	 * @param {import('react').KeyboardEvent} event A keydown on a tab button.
	 */
	const onTabKeyDown = ( event ) => {
		const index = tabs.findIndex( ( t ) => t.id === active.id );
		const last = tabs.length - 1;
		const next = {
			ArrowRight: index === last ? 0 : index + 1,
			ArrowLeft: 0 === index ? last : index - 1,
			Home: 0,
			End: last,
		}[ event.key ];
		if ( undefined === next ) {
			return;
		}
		event.preventDefault();
		pick( tabs[ next ].id );
		document.getElementById( tabDomId( tabs[ next ] ) )?.focus();
	};

	return (
		<>
			{ hasBar && (
				<div
					className="nodes-devtools__tabbar"
					role="tablist"
					aria-label={ __( 'Developer tools', 'newspack-nodes' ) }
				>
					{ tabs.map( ( t ) => (
						<button
							key={ t.id }
							id={ tabDomId( t ) }
							type="button"
							role="tab"
							aria-selected={ t.id === active.id }
							aria-controls={ panelDomId }
							tabIndex={ t.id === active.id ? 0 : -1 }
							className={ `nodes-devtools__tab${
								t.id === active.id ? ' is-active' : ''
							}` }
							onClick={ () => pick( t.id ) }
							onKeyDown={ onTabKeyDown }
						>
							{ t.icon }
							{ t.label }
						</button>
					) ) }
				</div>
			) }
			<div
				id={ panelDomId }
				role={ hasBar ? 'tabpanel' : undefined }
				aria-labelledby={ hasBar ? tabDomId( active ) : undefined }
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
