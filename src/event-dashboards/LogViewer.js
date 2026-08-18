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

const ROW_HEIGHT = 33;
const VIEW_NODE = 'logviewer:view';

const EMPTY_VIEW = {
	selected: '',
	paused: false,
	connectionError: false,
	mode: LIVE,
	lastReceivedSegment: null,
};

// One raw log line row (no partition gutter; height from the shared class).
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
			pickerLabel={ __( 'Browse a source', 'newspack-nodes' ) }
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
