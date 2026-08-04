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

import { useState, useEffect, useCallback, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { usePartitionViewerGraph } from './hooks/usePartitionViewerGraph';
import LogStreamViewer from '@newspack-nodes/shared/components/LogStreamViewer';
import LogListHeader from '@newspack-nodes/shared/components/LogListHeader';
import LogBrowser from '@newspack-nodes/shared/components/LogBrowser';
import formatBytes from '@newspack-nodes/shared/utils/formatBytes';
import parseOffsetJump from '@newspack-nodes/shared/utils/parseOffsetJump';
import useDeepLinkedSelection from '@newspack-nodes/shared/hooks/useDeepLinkedSelection';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import useLogPositions, {
	segmentPositions,
	replayPositions,
} from '@newspack-nodes/shared/hooks/useLogPositions';
import './styles/partition-viewer.scss';

const ROW_HEIGHT = 33;
// Segment-rail maintenance cadence (rotation + size growth).
const SEGMENTS_REFRESH_MS = 10000;
const VIEW_NODE = 'partition:view';

const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
	mode: 'live',
	lastReceivedSegment: null,
};

// One envelope row: Key | Value cells; the P<n> gutter comes from the CSS.
const renderPartitionRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-table__row newspack-nodes-log-row ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
		data-p={ row.partition }
	>
		<span className="newspack-nodes-table__cell is-secondary newspack-nodes-log-row__key">
			{ row.key || '' }
		</span>
		<span className="newspack-nodes-table__cell newspack-nodes-log-row__value">
			{ row.value ?? row.content }
		</span>
	</div>
);

// Normal-mode column header, aligned via the shared row cell classes.
const partitionHeader = (
	<LogListHeader
		columns={ [
			{
				key: 'key',
				label: __( 'Key', 'newspack-nodes' ),
				className: 'newspack-nodes-log-row__key',
			},
			{
				key: 'value',
				label: __( 'Value', 'newspack-nodes' ),
				className: 'newspack-nodes-log-row__value',
			},
		] }
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
	// Mount the node graph; it returns the thin control callbacks.
	const { selectLog, setPaused, fetchLogStatus, seek, step } =
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
	// @longform
	// Keyed on the log the reply BELONGS to, not a shared cancelled flag: React
	// runs the old cleanup then the new effect body, so a single ref is un-set
	// by the very re-run it should be cancelling and a slow reply for the
	// previous log lands in the new log's rail. Both writers below use this.
	const selectedLogRef = useRef( selectedLog );
	selectedLogRef.current = selectedLog;
	const applySegments = useCallback( ( forLog, status ) => {
		if ( selectedLogRef.current === forLog ) {
			setSegments( status?.segments ?? [] );
		}
	}, [] );

	const refreshSegments = useCallback( () => {
		const forLog = selectedLog;
		if ( ! forLog ) {
			return;
		}
		fetchLogStatus( forLog )
			.then( ( status ) => applySegments( forLog, status ) )
			.catch( () => {} );
	}, [ selectedLog, fetchLogStatus, applySegments ] );

	useEffect( () => {
		if ( ! selectedLog ) {
			setSegments( [] );
			return;
		}
		refreshSegments();
	}, [ selectedLog, refreshSegments ] );

	// Maintain the rail: rotation and size growth while streaming.
	useRouterTick( {
		name: 'partition-viewer:segments',
		onTick: refreshSegments,
		intervalMs: SEGMENTS_REFRESH_MS,
		enabled: Boolean( selectedLog ),
	} );

	// A record from an unknown segment = rotation; refetch once (no loops).
	const staleSegmentRef = useRef( null );
	useEffect( () => {
		if (
			null === lastReceivedSegment ||
			staleSegmentRef.current === lastReceivedSegment ||
			0 === segments.length ||
			segments.some( ( s ) => s.id === lastReceivedSegment )
		) {
			return;
		}
		staleSegmentRef.current = lastReceivedSegment;
		const forLog = selectedLog;
		fetchLogStatus( forLog )
			.then( ( status ) => applySegments( forLog, status ) )
			.catch( () => {} );
	}, [
		lastReceivedSegment,
		segments,
		selectedLog,
		fetchLogStatus,
		applySegments,
	] );

	// Browse: update seek intent, reposition, and carry the end for catch-up.
	const handleFollow = () => {
		follow();
		seek( selectedLog, null );
	};
	const handleReplay = () => {
		replay();
		seek( selectedLog, replayPositions( selectedLog ), { segments } );
	};
	// Time-travel: a past segment pauses; Step walks it, Play streams.
	const handleBrowseSegment = ( segment ) => {
		setPaused( true );
		browseSegment( segment.id );
		seek( selectedLog, segmentPositions( selectedLog, segment.id ), {
			segments,
		} );
	};

	// Offset jump: a full ID or a bare offset pauses and steps that message.
	const handleJump = ( text ) => {
		const position = parseOffsetJump(
			text,
			lastReceivedSegment ??
				( 'number' === typeof segmentId ? segmentId : null )
		);
		if ( ! position ) {
			return;
		}
		setPaused( true );
		browseSegment( position.segment );
		Promise.resolve(
			seek( selectedLog, { [ selectedLog ]: position }, { segments } )
		).then( () => step() );
	};

	// Re-read the live nodes each frame so a graph reinit is picked up.
	const getViewNode = useCallback( () => Core.node( VIEW_NODE ), [] );

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
			onStep={ step }
			onJump={ handleJump }
			getViewNode={ getViewNode }
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
			listHeader={ partitionHeader }
		/>
	);
}
