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
 * list tab (the Topology Manager) stays usable inside the station's fixed
 * wrapper, and it wears the shared page inset. A tab declaring `ownsScroll`
 * (the Log Viewer, whose rows scroll in a pane of their own) keeps the inset
 * and opts out of the scroll via `.is-own-scroll`; one declaring `fullBleed`
 * (the Topology Console, which owns its own full-height canvas) opts out of
 * both via `.is-full-bleed`.
 *
 * With `syncUrl` the host also owns the page's query string: the initial tab
 * comes from `?tab=<slug>`, the load canonicalizes it through `replaceState`,
 * each tab switch pushes one Back entry, and Back or Forward shows the tab the
 * landed entry names. A tab's declared `params` survive only while that tab
 * is showing, so the pushed entry drops every param of the tab left behind,
 * one the tab shown declares too included, while a load keeps every param
 * the tab it lands on declares, and
 * when Back or Forward lands on another tab's entry, that entry is
 * canonicalized once the landed tab has rendered, after every popstate
 * listener, the departing tab's own write-back included, has run. The overlay
 * and every other consumer stay URL-free.
 *
 * A tab declaring `beforeLeave( next )` is asked before a pick or a Back
 * takes it away. Only `true` lets the switch happen; any other answer keeps
 * the tab, and on a Back the bar store's `holdPop` returns to the tab's entry
 * before any reader hears of the one landed on; the host reads `?tab=` through
 * that store, so it shows only a Back the store published. The guard may switch
 * later through `next.leave()`, as a confirm dialog's yes does.
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
import {
	getQueryParam,
	holdPop,
	openParam,
	setQueryParams,
	subscribeParam,
} from '../utils/queryParams';
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

	// @longform Canonicalize the URL to the resolved tab's slug on mount and
	// on switch, keeping the params the tab itself declares: on a load these
	// are its deep link, such as the edit a station page loads its editor on;
	// on a switch the pushed entry already dropped the tab left behind's.
	const resolvedSlug = active?.slug;
	useEffect( () => {
		// Hold off while a deep-link is pending; don't rewrite ?tab= early.
		if ( ! syncUrl || ! resolvedSlug || deepLinkPending ) {
			return;
		}
		setQueryParams( tabQuery( host, resolvedSlug, active.params ) );
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the slug keys the tab
	}, [ syncUrl, resolvedSlug, host, deepLinkPending ] );

	// The active tab, for a guard asked about a Back.
	const shownRef = useRef( null );
	shownRef.current = active;

	// Back or Forward shows the landed tab unless the shown one declines.
	useEffect( () => {
		if ( ! syncUrl ) {
			return;
		}
		const landedOn = ( slug ) => {
			const hosted = getTabs( host );
			return hosted.find( ( t ) => t.slug === slug ) || hosted[ 0 ];
		};
		const release = holdPop( ( incoming, proceed ) => {
			const shown = shownRef.current;
			const landed = landedOn( incoming.get( 'tab' ) );
			return (
				!! landed &&
				!! shown &&
				landed.id !== shown.id &&
				! allowsLeave( shown, landed, proceed )
			);
		} );
		// The store tells this of a Back it publishes, never of one it holds.
		const unsubscribe = subscribeParam(
			openParam( 'tab', TAB_PARAM ),
			() => {
				pickedRef.current = true;
				setActiveId( landedOn( getQueryParam( 'tab' ) )?.id );
			}
		);
		return () => {
			unsubscribe();
			release();
		};
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
		const go = () => {
			if ( syncUrl && next && id !== active.id ) {
				setQueryParams( tabQuery( host, next.slug ), { push: true } );
			}
			pickedRef.current = true;
			setActiveId( id );
			onActiveTabChange?.( id );
		};
		if ( next && id !== active.id && ! allowsLeave( active, next, go ) ) {
			return;
		}
		go();
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
				className={ `nodes-tab-host__tab-content${ tabPane(
					active
				) }` }
			>
				{ /* host must win over any caller-supplied tabProps.host */ }
				<Active key={ active.id } { ...tabProps } host={ host } />
			</div>
		</>
	);
}

/**
 * The classes after `nodes-tab-host__tab-content` that a tab's pane wears. A
 * full-bleed tab runs edge to edge and scrolls itself; one that owns its
 * scroll keeps the shared page inset and loses only the outer scroll; any
 * other takes both.
 *
 * @param {import('./tabRegistry').TabDescriptor} tab The active tab.
 * @return {string} The classes, each led by a space.
 */
function tabPane( tab ) {
	if ( tab.fullBleed ) {
		return ' is-full-bleed';
	}
	return `${
		tab.ownsScroll ? ' is-own-scroll' : ''
	} newspack-nodes-page-inset`;
}

/**
 * `?tab=` as the bar store reads it: a Back entry, so the store re-reads it
 * off each entry it publishes.
 *
 * @type {import('../utils/queryParams').ParamCodec}
 */
const TAB_PARAM = {
	parse: ( raw ) => raw ?? '',
	format: ( slug ) => slug,
	push: true,
};

/**
 * Whether the tab shown lets the host take it away now: true unless it
 * declares a `beforeLeave` answering anything but `true`.
 *
 * @param {import('./tabRegistry').TabDescriptor} from  The tab shown.
 * @param {import('./tabRegistry').TabDescriptor} to    The tab asked for.
 * @param {() => void}                            leave Carries out the switch.
 * @return {boolean} Whether to switch now.
 */
function allowsLeave( from, to, leave ) {
	if ( ! from.beforeLeave ) {
		return true;
	}
	return true === from.beforeLeave( { id: to.id, slug: to.slug, leave } );
}

/**
 * The query a tab's entry carries: its slug, and every other tab's params
 * gone but those `kept` names.
 *
 * @param {'overlay'|'station'} host   Which registry scope is showing.
 * @param {string}              slug   The active tab's slug.
 * @param {Array<string>}       [kept] Params to leave, whichever tab declares them.
 * @return {Object<string, ?string>} The params `setQueryParams` writes.
 */
function tabQuery( host, slug, kept = [] ) {
	const query = { tab: slug };
	for ( const t of getTabs( host ) ) {
		if ( t.slug !== slug ) {
			for ( const param of t.params ) {
				if ( ! kept.includes( param ) ) {
					query[ param ] = null;
				}
			}
		}
	}
	return query;
}
