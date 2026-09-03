/**
 * Log Viewer Component — DOM-rendered live tail of registry log sources.
 *
 * A THIN view over the `logviewer:*` graph (mounted by `useLogViewerGraph`),
 * which opens the substrate's `GET /log/stream` and catalogs sources via
 * `taillog sources`. The chrome (toolbar dropdown, filter, counts, pause,
 * clear, banner, body split) is the shared `LogStreamViewer`; browsing the
 * selected source's SEGMENTS (a file source has none — Live/Replay still
 * apply) is the shared `useSegmentBrowse`, which also renders the rail. The
 * rows are RAW log-file lines (no partition column).
 *
 * `taillog sources` already carries each source's segment list and is polled,
 * so the rail is handed the catalog row it needs and no refresh timer of its
 * own — unlike the Partition Viewer, which asks `log_status` per partition.
 */

import { useCallback, useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { useLogViewerGraph } from './hooks/useLogReaderGraph';
import LogStreamViewer from '@newspack-nodes/shared/components/LogStreamViewer';
import useDeepLinkedSelection from '@newspack-nodes/shared/hooks/useDeepLinkedSelection';
import { useSegmentBrowse } from '@newspack-nodes/shared/hooks/useLogPositions';
import { LIVE } from '@newspack-nodes/shared/nodes/seekTracker';
import './styles/log-viewer.scss';

/**
 * Fixed row height in px. `LogRowList` virtualizes on this number instead of
 * measuring, and pushes it into the `--log-row-height` custom property the row
 * class reads, so the geometry and the rendered height cannot disagree.
 */
const ROW_HEIGHT = 33;

/**
 * The view node `useLogViewerGraph` mounts under the `logviewer` prefix. It
 * holds the ring and publishes the low-frequency `view` model; the component
 * addresses it by name because `LogRowList` pulls rows straight off the node.
 */
const VIEW_NODE = 'logviewer:view';

/**
 * The model rendered until the view node publishes its first `view` state — a
 * fresh mount, a Reset Graph rebuild, a session renewed while the tab slept.
 * It carries every field the component destructures, so no render path has to
 * branch on an absent view.
 */
const EMPTY_VIEW = {
	selected: '',
	paused: false,
	connectionError: false,
	mode: LIVE,
	lastReceivedSegment: null,
};

/**
 * Render one raw log line: a single cell, no partition gutter, height from the
 * shared row class.
 *
 * It sits at module scope for a stable identity — `LogRowList` memoizes its
 * rendered window on the renderer, and a closure rebuilt each render drops
 * that memo.
 *
 * @param {Object}  row         One row from the view node's ring.
 * @param {number}  row.id      Monotonic admitted-row counter; the React key.
 * @param {boolean} row.isEven  Stripe flag picking the row-even/row-odd class.
 * @param {string}  row.content The log line as it arrived.
 * @return {import('react').ReactElement} The rendered row.
 */
const renderRawRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-table__row newspack-nodes-log-row ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
	>
		{ row.content }
	</div>
);

/**
 * Log Viewer Component.
 *
 * Wires the graph's control callbacks and its published view model into the
 * shared chrome. It holds no row data: rows stay in the view node's ring,
 * which `LogRowList` pulls through `getViewNode`, so a busy stream never
 * becomes React state.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function LogViewer( { headerControlsSlot } ) {
	const { selectSource, setPaused, seek, sources, step, clear, setFilter } =
		useLogViewerGraph();

	const view = useNodeState( VIEW_NODE, 'view' ) ?? EMPTY_VIEW;
	const {
		selected: currentSource,
		paused: isPaused,
		connectionError,
		// Displayed Live/Replay comes from the view's actual streaming state.
		mode: displayMode,
		lastReceivedSegment,
	} = view;

	// `?source=` deep link: one-shot seed + reflect-on-pick.
	const pick = useDeepLinkedSelection( {
		param: 'source',
		keys: sources.map( ( s ) => s.name ),
		selected: currentSource,
		select: selectSource,
	} );

	// The open source's row: the rail's segments AND seek's replay boundary.
	const sourceRow = useMemo(
		() => sources.find( ( s ) => s.name === currentSource ) ?? {},
		[ sources, currentSource ]
	);

	const { jump, sidebar } = useSegmentBrowse( {
		sub: currentSource,
		source: sourceRow,
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
			className="newspack-nodes-log-viewer"
			ariaLabel={ __( 'Log Viewer', 'newspack-nodes' ) }
			headerControlsSlot={ headerControlsSlot }
			pickerOptions={ sources.map( ( s ) => ( {
				key: s.name,
				label: s.name,
				disabled: ! s.available,
			} ) ) }
			selectedKey={ currentSource }
			onPick={ pick }
			pickerEmptyLabel={ __( 'No sources available', 'newspack-nodes' ) }
			isPaused={ isPaused }
			connectionError={ connectionError }
			onTogglePause={ () => setPaused( ! isPaused ) }
			onStep={ step }
			onJump={ jump }
			getViewNode={ getViewNode }
			onClear={ clear }
			onFilter={ setFilter }
			sidebar={ sidebar }
			renderRow={ renderRawRow }
			rowHeight={ ROW_HEIGHT }
			hasKeyColumn={ false }
		/>
	);
}
