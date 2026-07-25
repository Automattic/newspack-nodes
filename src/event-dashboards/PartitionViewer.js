/**
 * Partition Viewer Component — DOM-rendered real-time stream of log lines.
 *
 * A THIN view over the `partition:*` node graph (mounted by
 * `usePartitionViewerGraph`): `partition:link` holds the SSE connection and
 * `partition:view` holds the ring + view model. The chrome (toolbar dropdown,
 * filter, counts, pause, clear, banner, body split) is the shared
 * `LogStreamViewer`; the sidebar is the shared `LogBrowser` browsing the
 * selected log's segments (`log_status`). Rows are packed partition envelopes
 * with a P<n> gutter.
 */

import { useState, useEffect, useCallback } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { usePartitionViewerGraph } from './hooks/usePartitionViewerGraph';
import LogStreamViewer from '@newspack-nodes/shared/components/LogStreamViewer';
import LogBrowser from '@newspack-nodes/shared/components/LogBrowser';
import formatBytes from '@newspack-nodes/shared/utils/formatBytes';
import useDeepLinkedSelection from '@newspack-nodes/shared/hooks/useDeepLinkedSelection';
import { endPosition } from '../shared/nodes/seekTracker';
import useLogPositions, {
	segmentPositions,
	replayPositions,
} from '@newspack-nodes/shared/hooks/useLogPositions';
import './styles/partition-viewer.scss';

const ROW_HEIGHT = 18;
const VIEW_NODE = 'partition:view';
// SSE connector owns liveness; "Xs ago" reads its lastEventTime, not the view.
const LINK_NODE = 'partition:link';

const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
	mode: 'live',
	lastReceivedSegment: null,
};

// One envelope row; row height + the P<n> gutter come from the partition CSS.
const renderPartitionRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-log-row ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
		data-p={ row.partition }
	>
		{ row.content }
	</div>
);

/**
 * Partition Viewer Component.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function PartitionViewer( { headerControlsSlot } ) {
	// Mount the node graph; it returns the thin control callbacks.
	const { selectLog, setPaused, fetchLogStatus, seek } =
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

	// Seek intent drives positions; displayed mode comes from the view.
	const { segmentId, follow, browseSegment, replay } =
		useLogPositions( selectedLog );
	const [ segments, setSegments ] = useState( [] );
	useEffect( () => {
		if ( ! selectedLog ) {
			setSegments( [] );
			return undefined;
		}
		let cancelled = false;
		fetchLogStatus( selectedLog )
			.then( ( status ) => {
				if ( ! cancelled ) {
					setSegments( status?.segments ?? [] );
				}
			} )
			.catch( () => {
				if ( ! cancelled ) {
					setSegments( [] );
				}
			} );
		return () => {
			cancelled = true;
		};
	}, [ selectedLog, fetchLogStatus ] );

	// Browse: update seek intent, reposition, and carry the end for catch-up.
	const handleFollow = () => {
		follow();
		seek( selectedLog, null );
	};
	const handleReplay = () => {
		replay();
		seek(
			selectedLog,
			replayPositions( selectedLog ),
			endPosition( segments )
		);
	};
	const handleBrowseSegment = ( segment ) => {
		browseSegment( segment.id );
		seek(
			selectedLog,
			segmentPositions( selectedLog, segment.id ),
			endPosition( segments )
		);
	};

	// Re-read the live nodes each frame so a graph reinit is picked up.
	const getViewNode = useCallback( () => Core.node( VIEW_NODE ), [] );
	const getLastEventTime = useCallback(
		() => Core.node( LINK_NODE )?.lastEventTime() ?? null,
		[]
	);

	return (
		<LogStreamViewer
			className="newspack-nodes-partition-viewer"
			ariaLabel={ __( 'Partition Viewer', 'newspack-nodes' ) }
			headerControlsSlot={ headerControlsSlot }
			pickerOptions={ availableLogs.map( ( log ) => ( {
				key: log.key,
				label: log.label,
			} ) ) }
			selectedKey={ selectedLog }
			onPick={ pick }
			pickerEmptyLabel={ __( 'No logs available', 'newspack-nodes' ) }
			isPaused={ isPaused }
			connectionError={ connectionError }
			onTogglePause={ () => setPaused( ! isPaused ) }
			getViewNode={ getViewNode }
			getLastEventTime={ getLastEventTime }
			sidebar={
				<LogBrowser
					mode={ displayMode }
					onFollow={ handleFollow }
					onReplay={ handleReplay }
					items={ segments }
					selectedKey={ segmentId }
					activeKey={ lastReceivedSegment }
					onSelectItem={ handleBrowseSegment }
					itemKey={ ( s ) => s.id }
					itemLabel={ ( s ) =>
						sprintf(
							// translators: %d: log segment number.
							__( 'Segment %d', 'newspack-nodes' ),
							s.id
						)
					}
					itemMeta={ ( s ) => formatBytes( s.size ) }
					title={ __( 'Segments', 'newspack-nodes' ) }
					emptyLabel={ __( 'No segments', 'newspack-nodes' ) }
				/>
			}
			renderRow={ renderPartitionRow }
			rowHeight={ ROW_HEIGHT }
			listClassName="newspack-nodes-partition-rows"
		/>
	);
}
