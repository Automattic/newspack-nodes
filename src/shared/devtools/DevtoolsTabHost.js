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
import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from '@wordpress/element';
import {
	getDevtoolsTabs,
	subscribeDevtoolsTabs,
	getDevtoolsTabsVersion,
} from './tabRegistry';
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
	// Set once the user picks a tab; then we never auto-switch to deep-link.
	const pickedRef = useRef( false );
	// Pending until ACTIVE tab IS target; else URL sync clears its param early.
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
								pickedRef.current = true;
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
