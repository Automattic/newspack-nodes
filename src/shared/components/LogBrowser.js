import { __ } from '@wordpress/i18n';
import { LIVE } from '../nodes/seekTracker';
import './LogBrowser.scss';

/** @typedef {import('react').ReactNode} ItemNode */

/**
 * LogBrowser — the shared Kafka-UI-style browse sidebar: a Live/Replay control
 * pair above a selectable item list whose rows the render props shape. Both
 * log-stream dashboards drive it as a SEGMENT browser (the Partition Viewer
 * from `log_status.segments`, the Log Viewer from `taillog sources[].segments`).
 *
 * It keeps no state. `useSegmentBrowse` supplies every callback and both keys:
 * `useLogPositions` owns the clicked segment, and `mode` is the view node's
 * `SeekTracker.mode`. Live/Replay therefore stays one state machine, rather
 * than a second copy here that could disagree with the records arriving.
 *
 * @template T The listed item — a segment row carrying `id` and `size` in both
 * dashboards.
 * @param {Object}                     props
 * @param {string}                     props.mode          Displayed mode: 'live' lights Live, anything else lights Replay.
 * @param {() => void}                 props.onFollow      Return to the live tail. Wired straight to the button's `onClick`, so a click event arrives and goes unread.
 * @param {() => void}                 props.onReplay      Replay from the earliest record; the same `onClick` wiring as `onFollow`.
 * @param {Array<T>}                   props.items         The rows to list, drawn in array order.
 * @param {?(string|number)}           [props.selectedKey] Key of the clicked item. NOT guaranteed to name a listed item: replay-from-start passes the literal `'start'` token, which matches no id, and `activeKey` lights the row instead.
 * @param {?(string|number)}           [props.activeKey]   Key of the item the newest record ARRIVED from; it outranks `selectedKey` for the highlight.
 * @param {(item: T) => void}          props.onSelectItem  Browse that item.
 * @param {(item: T) => string|number} props.itemKey       The row's React key, and the value both highlight keys are matched against.
 * @param {(item: T) => ItemNode}      props.itemLabel     The row's primary line.
 * @param {(item: T) => ItemNode}      [props.itemMeta]    The row's secondary line; omitted, the row is label-only.
 * @param {string}                     [props.title]       Sidebar heading; omitted, none is drawn.
 * @param {ItemNode}                   [props.emptyLabel]  Drawn in place of the list when `items` is empty.
 * @return {import('react').ReactElement} The sidebar.
 */
export default function LogBrowser( {
	mode,
	onFollow,
	onReplay,
	items,
	selectedKey = null,
	activeKey = null,
	onSelectItem,
	itemKey,
	itemLabel,
	itemMeta,
	title,
	emptyLabel,
} ) {
	const isLive = LIVE === mode;
	// Last-received wins the highlight; else the clicked item.
	const highlightKey = activeKey ?? selectedKey;
	return (
		<div className="newspack-nodes-log-browser">
			<div className="newspack-nodes-log-browser__controls">
				<button
					type="button"
					className={ `newspack-nodes-log-browser__mode newspack-nodes-log-browser__mode--live${
						isLive ? ' is-active' : ''
					}` }
					aria-pressed={ isLive }
					onClick={ onFollow }
				>
					{ __( 'Live', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ `newspack-nodes-log-browser__mode newspack-nodes-log-browser__mode--replay${
						isLive ? '' : ' is-active'
					}` }
					aria-pressed={ ! isLive }
					onClick={ onReplay }
				>
					{ __( 'Replay', 'newspack-nodes' ) }
				</button>
			</div>

			{ title && (
				<div className="newspack-nodes-log-browser__title">
					{ title }
				</div>
			) }

			{ 0 === items.length ? (
				<div className="newspack-nodes-empty-state is-quiet newspack-nodes-log-browser__empty">
					{ emptyLabel }
				</div>
			) : (
				<ul className="newspack-nodes-log-browser__list">
					{ items.map( ( item ) => {
						const key = itemKey( item );
						const active = key === highlightKey;
						return (
							<li key={ key }>
								<button
									type="button"
									className={ `newspack-nodes-log-browser__item${
										active ? ' is-active' : ''
									}` }
									onClick={ () => onSelectItem( item ) }
								>
									<span className="newspack-nodes-log-browser__item-label">
										{ itemLabel( item ) }
									</span>
									{ itemMeta && (
										<span className="newspack-nodes-status newspack-nodes-log-browser__item-meta">
											{ itemMeta( item ) }
										</span>
									) }
								</button>
							</li>
						);
					} ) }
				</ul>
			) }
		</div>
	);
}
