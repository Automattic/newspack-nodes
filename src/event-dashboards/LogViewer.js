/**
 * Log Viewer Component — DOM-rendered live tail of registry log sources.
 *
 * A THIN view over the `logviewer:*` graph (mounted by `useLogViewerGraph`),
 * which opens the substrate's `GET /log/stream` and catalogs sources via
 * `taillog sources`. The chrome (toolbar dropdown, filter, counts, pause,
 * clear, banner, body split) is the shared `LogStreamViewer`; the sidebar is
 * the shared `LogBrowser` browsing the selected source's SEGMENTS (a file
 * source has none — Live/Replay still apply). The rows are RAW log-file lines
 * (no partition column).
 */

import { useCallback, useEffect, useMemo, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { useLogViewerGraph } from './hooks/useLogViewerGraph';
import LogStreamViewer from '@newspack-nodes/shared/components/LogStreamViewer';
import LogBrowser from '@newspack-nodes/shared/components/LogBrowser';
import formatBytes from '@newspack-nodes/shared/utils/formatBytes';
import parseOffsetJump from '@newspack-nodes/shared/utils/parseOffsetJump';
import useDeepLinkedSelection from '@newspack-nodes/shared/hooks/useDeepLinkedSelection';
import useLogPositions, {
	segmentPositions,
	replayPositions,
} from '@newspack-nodes/shared/hooks/useLogPositions';
import './styles/log-viewer.scss';

const ROW_HEIGHT = 33;
// Catalog maintenance cadence (segment rotation + size growth).
const SEGMENTS_REFRESH_MS = 10000;
const VIEW_NODE = 'logviewer:view';

const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
	mode: 'live',
	lastReceivedSegment: null,
};

// One raw log line row (no partition gutter; height from the shared class).
const renderRawRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-log-row ${
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
	const { selectSource, setPaused, seek, sources, step, fetchSources } =
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

	// Memoized: the `?? []` mints a new identity per render, and this is a dep.
	const segments = useMemo(
		() => sources.find( ( s ) => s.name === currentSource )?.segments ?? [],
		[ sources, currentSource ]
	);

	// Maintain the rail: re-catalog on a cadence while a source streams.
	useEffect( () => {
		if ( ! currentSource ) {
			return undefined;
		}
		const id = setInterval( () => {
			fetchSources().catch( () => {} );
		}, SEGMENTS_REFRESH_MS );
		return () => clearInterval( id );
	}, [ currentSource, fetchSources ] );

	// A record from an unknown segment = rotation; re-catalog once (no loops).
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
		fetchSources().catch( () => {} );
	}, [ lastReceivedSegment, segments, fetchSources ] );

	// Seek intent; the DISPLAYED Live/Replay mode comes from the view.
	const { segmentId, follow, browseSegment, replay } =
		useLogPositions( currentSource );
	const handleFollow = () => {
		follow();
		seek( currentSource, null );
	};
	const handleReplay = () => {
		replay();
		seek( currentSource, replayPositions( currentSource ) );
	};
	// Time-travel: a past segment pauses; Step walks it, Play streams.
	const handleBrowseSegment = ( segment ) => {
		setPaused( true );
		browseSegment( segment.id );
		seek( currentSource, segmentPositions( currentSource, segment.id ) );
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
			seek( currentSource, { [ currentSource ]: position } )
		).then( () => step() );
	};

	// Re-read the live nodes each frame so a graph reinit is picked up.
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
			renderRow={ renderRawRow }
			rowHeight={ ROW_HEIGHT }
			hasKeyColumn={ false }
		/>
	);
}
