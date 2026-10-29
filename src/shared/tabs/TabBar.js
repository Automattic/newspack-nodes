/**
 * Shared tab bar — the WAI-ARIA tablist every Newspack dashboard switches
 * views with. `TabHost` renders it over the tab registry; a page holding its
 * own view state renders it directly, beside one panel of its own carrying
 * `panelDomId( scope )` and labelled by `tabDomId( scope, activeId )`.
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 */

/**
 * DOM id of one tab button, which its panel points back at.
 *
 * The scope keeps two bars on one page apart: the station renders the
 * floating overlay beside its own tabs.
 *
 * @param {string} scope Names the bar on its page.
 * @param {string} id    The tab's id.
 * @return {string} The button's DOM id.
 */
export const tabDomId = ( scope, id ) =>
	`nodes-tab-host-tab-${ scope }-${ id }`;

/**
 * DOM id of the one panel a bar controls.
 *
 * @param {string} scope Names the bar on its page.
 * @return {string} The panel's DOM id.
 */
export const panelDomId = ( scope ) => `nodes-tab-host-panel-${ scope }`;

/**
 * One tab of a bar.
 *
 * @typedef {Object} BarTab
 * @property {string}                    id     The tab's id.
 * @property {import('react').ReactNode} label  What the button says.
 * @property {import('react').ReactNode} [icon] Shown ahead of the label.
 */

/**
 * Renders the tablist, and moves and selects with the keyboard.
 *
 * Arrows wrap at both ends, Home and End jump to the edges, and selection
 * follows focus — which is what the roving `tabIndex` on the buttons is for.
 * Every other key falls through untouched, so Tab still leaves the bar.
 *
 * @param {Object}               props
 * @param {string}               props.scope    Names the bar on its page.
 * @param {string}               props.label    The tablist's accessible name.
 * @param {BarTab[]}             props.tabs     The tabs, in order.
 * @param {string}               props.activeId The selected tab's id.
 * @param {(id: string) => void} props.onPick   Selects a tab.
 * @return {import('react').ReactElement} The tab bar.
 */
export default function TabBar( { scope, label, tabs, activeId, onPick } ) {
	const onTabKeyDown = ( event ) => {
		const index = tabs.findIndex( ( t ) => t.id === activeId );
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
		onPick( tabs[ next ].id );
		document.getElementById( tabDomId( scope, tabs[ next ].id ) )?.focus();
	};

	return (
		<div
			className="nodes-tab-host__tabbar"
			role="tablist"
			aria-label={ label }
		>
			{ tabs.map( ( t ) => (
				<button
					key={ t.id }
					id={ tabDomId( scope, t.id ) }
					type="button"
					role="tab"
					aria-selected={ t.id === activeId }
					aria-controls={ panelDomId( scope ) }
					tabIndex={ t.id === activeId ? 0 : -1 }
					className={ `nodes-tab-host__tab${
						t.id === activeId ? ' is-active' : ''
					}` }
					onClick={ () => onPick( t.id ) }
					onKeyDown={ onTabKeyDown }
				>
					{ t.icon }
					{ t.label }
				</button>
			) ) }
		</div>
	);
}
