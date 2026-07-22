/**
 * LogBrowser — the shared Kafka-UI-style browse sidebar. A Live/Replay control
 * pair sits above a selectable item list; the items are shaped by render props so
 * the same sidebar serves the Partition Viewer's segments (`log_status`) and the
 * Log Viewer's sources (`taillog sources`). It is presentational: browse STATE
 * lives in `useLogPositions`, which the consumer drives from these callbacks.
 *
 * @param {Object}   props
 * @param {string}   props.mode           'live' | 'browse' (from useLogPositions).
 * @param {Function} props.onFollow       Return to the live tail.
 * @param {Function} props.onReplay       Replay from the earliest record.
 * @param {Array}    props.items          Segments or sources.
 * @param {*}        [props.selectedKey]  Key of the browsed item (the clicked one, or null).
 * @param {*}        [props.activeKey]    Key of the item last RECEIVED from; wins over
 *                                        selectedKey for the highlight when provided.
 * @param {Function} props.onSelectItem   `(item) => void` — browse that item.
 * @param {Function} props.itemKey        `(item) => string|number`.
 * @param {Function} props.itemLabel      `(item) => ReactNode`.
 * @param {Function} [props.itemMeta]     `(item) => ReactNode` secondary line.
 * @param {Function} [props.itemDisabled] `(item) => boolean` (e.g. unavailable source).
 * @param {string}   [props.title]        Sidebar heading.
 * @param {*}        [props.emptyLabel]   Rendered when `items` is empty.
 * @return {import('react').ReactElement} The sidebar.
 */

import { __ } from '@wordpress/i18n';
import './LogBrowser.scss';

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
	itemDisabled,
	title,
	emptyLabel,
} ) {
	const isLive = 'live' === mode;
	// Last-received wins the highlight; else the clicked item.
	const highlightKey = activeKey ?? selectedKey;
	return (
		<div className="newspack-nodes-log-browser">
			<div className="newspack-nodes-log-browser__controls">
				<button
					type="button"
					className={ `button${ isLive ? ' is-active' : '' }` }
					onClick={ onFollow }
				>
					{ __( 'Live', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ `button${ isLive ? '' : ' is-active' }` }
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
				<div className="newspack-nodes-log-browser__empty">
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
									disabled={ itemDisabled?.( item ) ?? false }
									onClick={ () => onSelectItem( item ) }
								>
									<span className="newspack-nodes-log-browser__item-label">
										{ itemLabel( item ) }
									</span>
									{ itemMeta && (
										<span className="newspack-nodes-log-browser__item-meta">
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
