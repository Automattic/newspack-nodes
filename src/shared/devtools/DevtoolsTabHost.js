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
import { useState } from '@wordpress/element';
import { getDevtoolsTabs } from './tabRegistry';
import './DevtoolsTabHost.scss';

/**
 * @param {Object} props
 * @param {string} props.host         'overlay' | 'hub'.
 * @param {Object} [props.tabProps]   Extra props spread into the mounted tab.
 * @param {*}      [props.emptyState] Rendered when no tab matches the host.
 * @return {*} The tab bar + selected tab, or the empty state.
 */
export default function DevtoolsTabHost( {
	host,
	tabProps = {},
	emptyState = null,
} ) {
	const tabs = getDevtoolsTabs( host );
	const [ activeId, setActiveId ] = useState( tabs[ 0 ]?.id );
	const active = tabs.find( ( t ) => t.id === activeId ) || tabs[ 0 ];
	const Active = active?.component;

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
							onClick={ () => setActiveId( t.id ) }
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
