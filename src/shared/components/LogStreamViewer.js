/**
 * LogStreamViewer — the shared chrome of the substrate's log-stream dashboards
 * (Partition Viewer, Log Viewer): a toolbar (source dropdown, filter, line
 * counts + staleness, pause, clear) that portals into the hub header slot when
 * given one, the reconnect banner, and the sidebar + virtualized row-list body.
 *
 * Presentational + local UI state only. The consumer mounts its own node graph
 * and passes the differing pieces: the picker catalog, the fully-configured
 * `LogBrowser` sidebar element, the row renderer, and two node accessors —
 * `getViewNode` (the ring `LogRowList` reads and Clear empties) and
 * `getLastEventTime` (the SSE link's last-frame clock behind "Xs ago") — so
 * this component stays runtime-free like its `LogRowList` sibling.
 */

import {
	useState,
	useEffect,
	useCallback,
	createPortal,
} from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import LogRowList from './LogRowList';
import ConnectionBanner from './ConnectionBanner';
import StalenessIndicator from './StalenessIndicator';

/**
 * @param {Object}   props                      Props.
 * @param {string}   props.className            Root class; the body wrapper is `${className}__body`.
 * @param {string}   props.ariaLabel            The region's accessible name.
 * @param {Element}  [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @param {Array}    props.pickerOptions        `{ key, label, disabled? }` rows for the source dropdown.
 * @param {string}   props.selectedKey          The picked option's key.
 * @param {Function} props.onPick               `(key) => void` — switch the source.
 * @param {string}   props.pickerEmptyLabel     Status text when the catalog is empty.
 * @param {boolean}  props.isPaused             The view's paused flag.
 * @param {boolean}  props.connectionError      The view's reconnect flag.
 * @param {Function} props.onTogglePause        Pause/resume the stream.
 * @param {Function} props.onStep               Step one message (enabled only while paused).
 * @param {Function} props.getViewNode          `() => node` — the live ring node (rows + Clear).
 * @param {Function} props.getLastEventTime     `() => ?number` — the link's last-frame ms clock.
 * @param {*}        props.sidebar              The configured `LogBrowser` element.
 * @param {Function} props.renderRow            One-row renderer for `LogRowList`.
 * @param {number}   props.rowHeight            Fixed row height (px).
 * @param {string}   [props.listClassName]      Extra `LogRowList` class.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function LogStreamViewer( {
	className,
	ariaLabel,
	headerControlsSlot,
	pickerOptions,
	selectedKey,
	onPick,
	pickerEmptyLabel,
	isPaused,
	connectionError,
	onTogglePause,
	onStep,
	getViewNode,
	getLastEventTime,
	sidebar,
	renderRow,
	rowHeight,
	listClassName,
} ) {
	const [ filter, setFilter ] = useState( '' );
	// Counts LogRowList reports up (row DATA never becomes React state).
	const [ stats, setStats ] = useState( { total: 0, visible: 0, lps: 0 } );
	const handleStats = useCallback( ( next ) => setStats( next ), [] );
	// Bumped to rebase the list on Clear (also re-reads the emptied ring).
	const [ resetSignal, setResetSignal ] = useState( 0 );

	// Ticking "Xs ago" display, read off the link's last-frame clock.
	const [ now, setNow ] = useState( Date.now() );
	useEffect( () => {
		const id = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( id );
	}, [] );
	const lastEventTime = getLastEventTime();
	const staleSec = lastEventTime
		? Math.max( 0, Math.floor( ( now - lastEventTime ) / 1000 ) )
		: null;

	// Clear all lines — empties the node ring; the next frame reflects 0 lines.
	const handleClear = () => {
		const node = getViewNode();
		if ( node ) {
			node.lines = [];
		}
		setStats( { total: 0, visible: 0, lps: 0 } );
		setResetSignal( ( n ) => n + 1 );
	};

	const emptyLabel = isPaused
		? __( 'Paused', 'newspack-nodes' )
		: __( 'Waiting for log lines…', 'newspack-nodes' );

	// Controls strip portals into the hub header slot; undefined = inline.
	const controls = (
		<div className="newspack-nodes-toolbar">
			{ pickerOptions.length === 0 && (
				<span className="newspack-nodes-toolbar-status">
					{ pickerEmptyLabel }
				</span>
			) }
			{ pickerOptions.length > 0 && (
				<select
					className="newspack-nodes-select"
					value={ selectedKey }
					onChange={ ( e ) => onPick( e.target.value ) }
				>
					{ pickerOptions.map( ( option ) => (
						<option
							key={ option.key }
							value={ option.key }
							disabled={ option.disabled ?? false }
						>
							{ option.label }
						</option>
					) ) }
				</select>
			) }

			<input
				type="text"
				className="newspack-nodes-search-input"
				placeholder={ __( 'Filter…', 'newspack-nodes' ) }
				value={ filter }
				onChange={ ( e ) => setFilter( e.target.value ) }
			/>

			<span className="newspack-nodes-toolbar-stats">
				<span className="newspack-nodes-toolbar-stats__count">
					{ filter
						? sprintf(
								// translators: 1: number of matching lines, 2: total number of lines.
								_n(
									'%1$d / %2$d line',
									'%1$d / %2$d lines',
									stats.total,
									'newspack-nodes'
								),
								stats.visible,
								stats.total
						  )
						: sprintf(
								// translators: %d: number of lines.
								_n(
									'%d line',
									'%d lines',
									stats.visible,
									'newspack-nodes'
								),
								stats.visible
						  ) }
				</span>
				{ stats.lps > 0 && (
					<span className="newspack-nodes-toolbar-stats__rps">
						{ sprintf(
							// translators: %s: lines-per-second rate (one decimal place).
							__( '%s lines/s', 'newspack-nodes' ),
							stats.lps.toFixed( 1 )
						) }
					</span>
				) }
				<StalenessIndicator paused={ isPaused } staleSec={ staleSec } />
			</span>

			<button
				className={ `button ${ isPaused ? 'is-paused' : '' }` }
				onClick={ onTogglePause }
				title={
					isPaused
						? __( 'Resume streaming', 'newspack-nodes' )
						: __( 'Pause streaming', 'newspack-nodes' )
				}
			>
				{ isPaused ? '▶' : '⏸' }
			</button>

			<button
				className="button"
				onClick={ onStep }
				disabled={ ! isPaused }
				title={ __(
					'Step one message (paused only)',
					'newspack-nodes'
				) }
			>
				{ '⏭' }
			</button>

			<button
				className="button"
				onClick={ handleClear }
				title={ __( 'Clear all lines', 'newspack-nodes' ) }
			>
				{ __( 'Clear', 'newspack-nodes' ) }
			</button>
		</div>
	);
	let renderedControls = null;
	if ( headerControlsSlot ) {
		renderedControls = createPortal( controls, headerControlsSlot );
	} else if ( undefined === headerControlsSlot ) {
		renderedControls = controls;
	}

	return (
		<div className={ className } role="region" aria-label={ ariaLabel }>
			{ renderedControls }

			<ConnectionBanner
				connectionError={ connectionError }
				message={ __(
					'Connection lost. Reconnecting…',
					'newspack-nodes'
				) }
			/>

			<div className={ `${ className }__body` }>
				{ sidebar }

				<LogRowList
					getNode={ getViewNode }
					rowHeight={ rowHeight }
					renderRow={ renderRow }
					filter={ filter }
					emptyLabel={ emptyLabel }
					onStats={ handleStats }
					resetSignal={ resetSignal }
					listClassName={ listClassName }
				/>
			</div>
		</div>
	);
}
