/**
 * Shared tab bar — the WAI-ARIA tablist every Newspack dashboard switches
 * views with, and under `NARROW_PX` one select labelled "View". `TabHost`
 * renders it over the tab registry; a page holding its own view state renders
 * it directly, beside one panel of its own carrying `panelDomId( scope )` and
 * labelled by `tabDomId( scope, activeId )`.
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 */

import { SelectControl } from '@wordpress/components';
import { useLayoutEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import useNarrow, { isNarrow } from '../hooks/useNarrow';
import './TabBar.scss';

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
 * @property {string}                    label  What the button, or the narrow form's option, says.
 * @property {import('react').ReactNode} [icon] Shown ahead of the label; the narrow form drops it.
 */

/**
 * Props for the one panel a bar controls, matching the form the bar takes.
 *
 * A wide bar's tabs label the panel, so it is a tabpanel named by the
 * selected tab. A narrow bar is a select, and a bar not shown is nothing, so
 * the panel then carries its id alone, which the select's `aria-controls`
 * names.
 *
 * @param {string}  scope    Names the bar on its page.
 * @param {string}  activeId The selected tab's id.
 * @param {boolean} shown    Whether the page renders the bar at all.
 * @return {{ id: string, role?: string, 'aria-labelledby'?: string }} The panel's props.
 */
export function useTabPanelProps( scope, activeId, shown ) {
	const narrow = useNarrow();
	const id = panelDomId( scope );
	if ( ! shown || narrow ) {
		return { id };
	}
	return {
		id,
		role: 'tabpanel',
		'aria-labelledby': tabDomId( scope, activeId ),
	};
}

/**
 * Renders the tablist, and moves and selects with the keyboard.
 *
 * Arrows wrap at both ends, Home and End jump to the edges, and selection
 * follows focus — which is what the roving `tabIndex` on the buttons is for.
 * Every other key falls through untouched, so Tab still leaves the bar.
 *
 * Under `NARROW_PX` a row of tabs no longer fits, so the bar renders one
 * select labelled "View" instead, inside the same wrapper, which then takes
 * no role: the sheets paint it and the inspector measures it either way.
 * Focus inside the bar follows it across the breakpoint, to the selected tab
 * or to the select, because the control it sat on is gone.
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
	const narrow = useNarrow();
	const barRef = useRef( null );
	const focusedRef = useRef( false );
	const formRef = useRef( narrow );

	useLayoutEffect( () => {
		if ( formRef.current === narrow ) {
			return;
		}
		formRef.current = narrow;
		if ( focusedRef.current ) {
			barRef.current
				?.querySelector( narrow ? 'select' : '[aria-selected="true"]' )
				?.focus();
		}
	}, [ narrow ] );

	const onBlur = ( event ) => {
		// A blur mid-flip comes from the departing control, not from focus.
		if ( isNarrow() !== formRef.current ) {
			return;
		}
		focusedRef.current = !! barRef.current?.contains( event.relatedTarget );
	};

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
			ref={ barRef }
			className={ `nodes-tab-host__tabbar${
				narrow ? ' is-narrow' : ''
			}` }
			role={ narrow ? undefined : 'tablist' }
			aria-label={ narrow ? undefined : label }
			onFocus={ () => ( focusedRef.current = true ) }
			onBlur={ onBlur }
		>
			{ narrow ? (
				<SelectControl
					__next40pxDefaultSize
					__nextHasNoMarginBottom
					aria-controls={ panelDomId( scope ) }
					label={ __( 'View', 'newspack-nodes' ) }
					options={ tabs.map( ( t ) => ( {
						value: t.id,
						label: t.label,
					} ) ) }
					value={ activeId }
					onChange={ ( id ) => onPick( id ) }
				/>
			) : (
				tabs.map( ( t ) => (
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
				) )
			) }
		</div>
	);
}
