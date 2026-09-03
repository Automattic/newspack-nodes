/**
 * Partition Viewer Component — the DOM-rendered live stream of one
 * partition's records.
 *
 * A THIN view over the `partition:*` node graph (mounted by
 * `usePartitionViewerGraph`): `partition:link` holds the SSE connection and
 * `partition:view` holds the ring + view model. The chrome (toolbar dropdown,
 * filter, counts, pause, clear, banner, body split) is the shared
 * `LogStreamViewer`; browsing the selected log's segments (`log_status`) is the
 * shared `useSegmentBrowse`, which also renders the rail. Rows are packed
 * partition envelopes, one cell per message field the Cols picker has enabled.
 */

import { useState, useCallback } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { usePartitionViewerGraph } from './hooks/useLogReaderGraph';
import LogStreamViewer, {
	debugValue,
} from '@newspack-nodes/shared/components/LogStreamViewer';
import ColumnPicker from '@newspack-nodes/shared/components/ColumnPicker';
import { useColumnPicker } from '@newspack-nodes/shared/hooks/useColumnPicker';
import { formatTypeLabel } from '../runtime/dumper-node';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import LogListHeader from '@newspack-nodes/shared/components/LogListHeader';
import useDeepLinkedSelection from '@newspack-nodes/shared/hooks/useDeepLinkedSelection';
import {
	useSegmentBrowse,
	useLogStatusSegments,
} from '@newspack-nodes/shared/hooks/useLogPositions';
import { LIVE } from '@newspack-nodes/shared/nodes/seekTracker';
import './styles/partition-viewer.scss';

/**
 * Row height in pixels. `LogRowList` virtualizes on this number and publishes
 * it to the CSS as `--log-row-height`, so the scroll geometry and the painted
 * rows cannot disagree.
 *
 * @type {number}
 */
const ROW_HEIGHT = 33;

/**
 * The view node `usePartitionViewerGraph` mounts. `useNodeState` reads state
 * by NAME, so this and the hook's `partition` prefix move together.
 *
 * @type {string}
 */
const VIEW_NODE = 'partition:view';

/**
 * What the component renders until `partition:view` publishes its first
 * model: an empty catalog, no selection, live and unpaused.
 *
 * @type {Object}
 */
const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
	mode: LIVE,
	lastReceivedSegment: null,
};

/**
 * localStorage key holding the column selection, namespaced to this dashboard
 * so a sibling viewer's picker keeps its own.
 *
 * @type {string}
 */
const COLUMNS_STORAGE_KEY = 'newspack-nodes:partition-viewer:columns';

/**
 * The seven positional message fields (ADR-2), declared in wire order. A
 * record IS a Message, so these ARE its columns. `useColumnPicker` re-adds a
 * toggled-on column in the order declared here, and both the header and the
 * cells are built from that list, so this order is the table's order.
 *
 * An entry carries the picker's `label` and `tooltip` plus the `className`
 * that sizes the cell; the widths themselves live in the SCSS.
 *
 * @type {Object<string,{label: string, tooltip: string, className: string}>}
 */
const COLUMNS = {
	type: {
		label: __( 'Type', 'newspack-nodes' ),
		tooltip: __( 'Message type flags', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__type',
	},
	timestamp: {
		label: __( 'Time', 'newspack-nodes' ),
		tooltip: __( 'When the message was minted', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__ts',
	},
	from: {
		label: __( 'From', 'newspack-nodes' ),
		tooltip: __( 'Origin breadcrumb path', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__from',
	},
	to: {
		label: __( 'To', 'newspack-nodes' ),
		tooltip: __( 'Destination path', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__to',
	},
	id: {
		label: __( 'ID', 'newspack-nodes' ),
		tooltip: __( 'Segment:offset:line', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__id',
	},
	key: {
		label: __( 'Key', 'newspack-nodes' ),
		tooltip: __( 'Partition routing key', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__key',
	},
	value: {
		label: __( 'Value', 'newspack-nodes' ),
		tooltip: __( 'Record payload', 'newspack-nodes' ),
		className: 'newspack-nodes-log-row__value',
	},
};

/**
 * The columns visible until someone opens the picker: the VALUE payload, the
 * ID locating the record on disk, and the KEY it was routed by. The other
 * four are metadata a reader opts into.
 *
 * @type {string[]}
 */
const DEFAULT_COLUMNS = [ 'id', 'key', 'value' ];

/**
 * The text of one cell.
 *
 * TYPE is a bitmask and TIMESTAMP is epoch seconds, so neither reads as
 * itself and both go through a formatter. The default arm is the VALUE
 * column: debug rows render the whole raw payload, pretty-printed for a
 * struct, and plain rows the clipped `value` the view node shaped — falling
 * back to `content`, the `KEY: VALUE` line the filter matches on, for a row
 * carrying no bare value.
 *
 * @param {string}  col   The column key, one of `COLUMNS`.
 * @param {Object}  row   One row, as `partition:view` shaped it.
 * @param {boolean} debug Whether the Debug toggle is on.
 * @return {string} The cell's text.
 */
const cellText = ( col, row, debug ) => {
	switch ( col ) {
		case 'type':
			return formatTypeLabel( row.type ?? 0 );
		case 'timestamp':
			return formatLocalDateTime( row.timestamp );
		case 'from':
			return row.from || '';
		case 'to':
			return row.to || '';
		case 'id':
			return row.msgId || '';
		case 'key':
			return row.key || '';
		default:
			return debug ? debugValue( row ) : row.value ?? row.content;
	}
};

/**
 * Build the row renderer for one column set: a cell per enabled column, VALUE
 * carrying the payload and every other column dimmed as metadata.
 *
 * Debug rows keep the picked columns and swap only the VALUE cell for the
 * full raw payload, which is why the viewer supplies its own debug renderer
 * instead of taking `LogStreamViewer`'s fixed ID/Key/Value one.
 *
 * `LogRowList` maps the ring window through the returned function and
 * memoizes on its identity, so a caller must hold it stable while the column
 * set is unchanged.
 *
 * @param {string[]} visibleColumns The enabled column keys, in table order.
 * @param {boolean}  debug          Whether the Debug toggle is on.
 * @return {(row: Object) => import('react').ReactElement} The one-row renderer.
 */
const makeRenderRow = ( visibleColumns, debug ) => ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-table__row newspack-nodes-log-row ${
			debug ? 'is-debug ' : ''
		}${ row.isEven ? 'row-even' : 'row-odd' }` }
	>
		{ visibleColumns.map( ( col ) => (
			<span
				key={ col }
				className={ `newspack-nodes-table__cell ${
					'value' === col ? '' : 'is-muted '
				}${ COLUMNS[ col ].className }` }
			>
				{ cellText( col, row, debug ) }
			</span>
		) ) }
	</div>
);

/**
 * The header row for one column set, built from the same `COLUMNS` entries as
 * the cells so a header and the column under it are sized from one
 * declaration.
 *
 * @param {string[]} visibleColumns The enabled column keys, in table order.
 * @return {import('react').ReactElement} The header row.
 */
const makeHeader = ( visibleColumns ) => (
	<LogListHeader
		columns={ visibleColumns.map( ( col ) => ( {
			key: col,
			label: COLUMNS[ col ].label,
			tooltip: COLUMNS[ col ].tooltip,
			className: COLUMNS[ col ].className,
		} ) ) }
	/>
);

/**
 * Partition Viewer Component.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function PartitionViewer( { headerControlsSlot } ) {
	const [ showColumnPicker, setShowColumnPicker ] = useState( false );
	const { visibleColumns, toggleColumn, isVisible } = useColumnPicker( {
		columns: COLUMNS,
		storageKey: COLUMNS_STORAGE_KEY,
		defaultVisible: DEFAULT_COLUMNS,
	} );
	// LogRowList memoizes its rows on the renderer's identity.
	const renderRow = useCallback(
		() => makeRenderRow( visibleColumns, false ),
		[ visibleColumns ]
	)();
	const renderDebugRow = useCallback(
		() => makeRenderRow( visibleColumns, true ),
		[ visibleColumns ]
	)();
	// Debug reuses this header; its shared default would ignore the picker.
	const header = makeHeader( visibleColumns );

	// Mount the node graph; it returns the thin control callbacks.
	const { selectLog, setPaused, seek, step, clear, setFilter } =
		usePartitionViewerGraph();

	// Low-frequency view model (dropdown + pause button + selected value).
	const view = useNodeState( VIEW_NODE, 'view' ) ?? EMPTY_VIEW;
	const {
		logs: availableLogs,
		selected: selectedLog,
		paused: isPaused,
		connectionError,
		// Actual streaming state (from the view's breadcrumbs), not the click.
		mode: displayMode,
		lastReceivedSegment,
	} = view;

	// `?log=` deep link: one-shot seed + reflect-on-pick.
	const pick = useDeepLinkedSelection( {
		param: 'log',
		keys: availableLogs.map( ( l ) => l.key ),
		selected: selectedLog,
		select: selectLog,
	} );

	const { source, refresh } = useLogStatusSegments( {
		sub: selectedLog,
		scope: 'partition:status',
	} );

	const { jump, sidebar } = useSegmentBrowse( {
		sub: selectedLog,
		source,
		refresh,
		railName: 'partition:refresh',
		mode: displayMode,
		lastReceivedSegment,
		seek,
		setPaused,
		step,
	} );

	// Read the view node per call, so a graph reinit is picked up.
	const getViewNode = useCallback( () => Core.node( VIEW_NODE ), [] );

	return (
		<LogStreamViewer
			className="newspack-nodes-partition-viewer"
			ariaLabel={ __( 'Partition Viewer', 'newspack-nodes' ) }
			headerControlsSlot={ headerControlsSlot }
			pickerOptions={ availableLogs }
			selectedKey={ selectedLog }
			onPick={ pick }
			pickerEmptyLabel={ __( 'No logs available', 'newspack-nodes' ) }
			pickerLabel={ __( 'Browse a log', 'newspack-nodes' ) }
			isPaused={ isPaused }
			connectionError={ connectionError }
			onTogglePause={ () => setPaused( ! isPaused ) }
			onStep={ step }
			onJump={ jump }
			getViewNode={ getViewNode }
			onClear={ clear }
			onFilter={ setFilter }
			sidebar={ sidebar }
			renderRow={ renderRow }
			renderDebugRow={ renderDebugRow }
			renderDebugHeader={ header }
			rowHeight={ ROW_HEIGHT }
			listClassName="newspack-nodes-partition-rows"
			listHeader={ header }
			toolbarExtras={
				<button
					className={ `button ${
						showColumnPicker ? 'is-active' : ''
					}` }
					onClick={ () => setShowColumnPicker( ! showColumnPicker ) }
					title={ __( 'Select columns', 'newspack-nodes' ) }
				>
					{ __( 'Cols', 'newspack-nodes' ) }
				</button>
			}
			belowToolbar={
				showColumnPicker && (
					<ColumnPicker
						columns={ COLUMNS }
						isVisible={ isVisible }
						onToggle={ toggleColumn }
						idPrefix="pv-col"
					/>
				)
			}
		/>
	);
}
