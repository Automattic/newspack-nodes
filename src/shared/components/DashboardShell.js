import { useState } from '@wordpress/element';
import useAdminMenuWidth from '../hooks/useAdminMenuWidth';
import { ASK_PAGE_ATTR } from '../hooks/useAskPicker';
import DebugOverlay from '../../debug-overlay/DebugOverlay';
import Header from './Header';
import ThemedRoot from './ThemedRoot';

/**
 * The class of the region below the header, which is what the page scrolls:
 * the surface around it is fixed and clips. A list virtualized against the
 * page measures against this, never the window, which does not scroll here.
 */
export const PAGE_CONTENT_CLASS = 'newspack-nodes-page-content';

/**
 * Fixed full-viewport chrome for an application's standalone dashboard page —
 * the skin, the box, the header and the debug overlay every such page shares.
 *
 * The header is the shared one, so a dashboard reads as the same product as
 * the station: one `NEWSPACK::NODES` wordmark, and a subtitle naming which
 * surface you are on.
 *
 * It also owns the ONE controls slot, exactly as the station does, and hands
 * it to `children` — a function, because the state behind those controls lives
 * deep inside each dashboard rather than up here. A page portals its toolbar
 * in with `HeaderSlot`, so the toolbar sits beside the name of the page it
 * drives instead of in a second bar under it.
 *
 * WordPress lays admin pages out in a padded, max-width column, which cramps a
 * wide monitoring surface. This box is positioned rather than flowed: `top`
 * clears the desktop admin bar and `left` tracks the admin menu's live width,
 * so folding the menu slides the page instead of reflowing it, and the eased
 * transition keeps the two in step.
 *
 * Both boxes are flex COLUMNS, as the station's is. The outer one is what
 * gives the header its own height and hands the rest to the scrolling area;
 * the scrolling area is what a dashboard root grows into, because every root
 * here declares `flex: 1 1 auto; min-height: 0` and a block parent ignores
 * both — the rows then size to their content, and a virtualized list that
 * measures its own `clientHeight` never scrolls at all.
 *
 * The box paints its own backdrop, through the substrate's shared
 * `newspack-nodes-page-surface` class. It is positioned rather than flowed, so
 * the admin page keeps its place in the document underneath — an admin notice
 * included, which WordPress relocates to just above the mount. A transparent
 * box shows it straight through; the station paints through the same class.
 *
 * `ThemedRoot` wraps the box rather than sitting inside it, so the overlay
 * takes the page's skin: `DebugOverlay` renders a skin provider of its own
 * only when it finds no `.newspack-nodes-ui` ancestor, and this wrapper is
 * that ancestor. Both its launcher and its panel are `position: fixed`, so
 * mounting the overlay inside a box that may clip costs it nothing.
 *
 * The HEADER sits outside the scroller. It is chrome rather than content, so
 * it holds its place while the page moves, and the scrollbar runs beside the
 * rows instead of through the header's own band. The box therefore clips, and
 * the area below the header is what scrolls.
 *
 * `overflowY` is required, not defaulted, and applies to that area: a
 * dashboard whose body owns its own scroller must clip there, and one without
 * an inner scroller must scroll there. Getting it wrong is a double scrollbar
 * or a truncated page, so each caller states which it is. `overflowX` is not a
 * caller's choice — it always clips, so anything wider scrolls in its own
 * container.
 *
 * @param {Object}                                        props                 Component props.
 * @param {string}                                        props.storageKey      Debug-overlay key; scopes the persisted panel layout to this page, so no two dashboards may share one.
 * @param {string}                                        props.subtitle        Names this dashboard in the header, beside the one shared wordmark.
 * @param {import('react').CSSProperties['overflowY']}    props.overflowY       Vertical overflow for the scrolling area below the header.
 * @param {(slot: ?Element) => import('react').ReactNode} props.children        Called with the header's controls slot — null until it mounts — and returns the dashboard root(s) to frame.
 * @param {string}                                        [props.askDescriptor] The `?` picker descriptor for the page itself, on the scrolling area the ring traces. A page with no brief of its own passes none and stays unaskable.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function DashboardShell( {
	storageKey,
	subtitle,
	overflowY,
	askDescriptor = '',
	children,
} ) {
	const menuWidth = useAdminMenuWidth();
	// Null until the header's slot div mounts; HeaderSlot withholds until then.
	const [ headerControlsSlot, setHeaderControlsSlot ] = useState( null );

	return (
		<ThemedRoot>
			<div
				className="newspack-nodes-page-surface"
				style={ {
					position: 'fixed',
					top: '32px',
					left: `${ menuWidth }px`,
					right: '0',
					bottom: '0',
					zIndex: 99, // Below WP admin menu hover (9990+)
					transition: 'left 0.1s ease-in-out',
					margin: 0,
					padding: 0,
					boxSizing: 'border-box',
					display: 'flex',
					flexDirection: 'column',
					overflowX: 'hidden',
					overflowY: 'hidden',
				} }
			>
				<Header
					subtitle={ subtitle }
					controlsSlotRef={ setHeaderControlsSlot }
				/>
				{ /* @longform The page's own ask target is what SCROLLS: the
				     reader's page is the area under the header, so that is
				     what the brief answers for and what the ring traces. */ }
				<div
					className={ PAGE_CONTENT_CLASS }
					{ ...( askDescriptor
						? {
								'data-ask': askDescriptor,
								[ ASK_PAGE_ATTR ]: '',
						  }
						: {} ) }
					style={ {
						flex: '1 1 auto',
						// A flex item's floor is its content; 0 lets it clip.
						minHeight: 0,
						// The roots below are flex items; this is their column.
						display: 'flex',
						flexDirection: 'column',
						overflowX: 'hidden',
						overflowY,
					} }
				>
					{ children( headerControlsSlot ) }
				</div>
				<DebugOverlay storageKey={ storageKey } />
			</div>
		</ThemedRoot>
	);
}
