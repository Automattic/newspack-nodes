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
import LogListHeader from './LogListHeader';
import ConnectionBanner from './ConnectionBanner';
import StalenessIndicator from './StalenessIndicator';

// Pretty-print a struct row's raw JSON; anything else renders verbatim.
const debugValue = ( row ) => {
	if ( row.struct && row.raw ) {
		try {
			return JSON.stringify( JSON.parse( row.raw ), null, 2 );
		} catch ( e ) {
			return row.raw;
		}
	}
	return row.raw ?? row.content;
};

// Module-scope: a stable identity keeps LogRowList's row memoization live.
const renderDebugRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-log-row is-debug ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
		data-p={ row.partition }
	>
		<span className="newspack-nodes-log-row__id">{ row.msgId || '?' }</span>
		<span className="newspack-nodes-log-row__key">{ row.key || '' }</span>
		<span className="newspack-nodes-log-row__value">
			{ debugValue( row ) }
		</span>
	</div>
);

// Log Viewer variant: raw lines carry no KEY — two columns only.
const renderDebugRowNoKey = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-log-row is-debug ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
		data-p={ row.partition }
	>
		<span className="newspack-nodes-log-row__id">{ row.msgId || '?' }</span>
		<span className="newspack-nodes-log-row__value">
			{ debugValue( row ) }
		</span>
	</div>
);

// The debug-mode column header (ID [· Key] · Value), shared cell classes.
const debugHeader = ( hasKeyColumn ) => (
	<LogListHeader
		columns={ [
			{
				key: 'id',
				label: __( 'ID', 'newspack-nodes' ),
				className: 'newspack-nodes-log-row__id',
			},
			...( hasKeyColumn
				? [
						{
							key: 'key',
							label: __( 'Key', 'newspack-nodes' ),
							className: 'newspack-nodes-log-row__key',
						},
				  ]
				: [] ),
			{
				key: 'value',
				label: __( 'Value', 'newspack-nodes' ),
				className: 'newspack-nodes-log-row__value',
			},
		] }
	/>
);

/**
 * @param {Object}   props                      Props.
 * @param {string}   props.className            Root class; the body wrapper is `${className}__body`.
 * @param {string}   props.ariaLabel            The region's accessible name.
 * @param {string}   [props.title]              Inline page heading (adopters without a hub header).
 * @param {Element}  [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @param {?Array}   props.pickerOptions        `{ key, label, disabled? }` rows for the source dropdown; null = no picker.
 * @param {string}   props.selectedKey          The picked option's key.
 * @param {Function} props.onPick               `(key) => void` — switch the source.
 * @param {string}   props.pickerEmptyLabel     Status text when the catalog is empty.
 * @param {boolean}  props.isPaused             The view's paused flag.
 * @param {boolean}  props.connectionError      The view's reconnect flag.
 * @param {Function} props.onTogglePause        Pause/resume the stream.
 * @param {Function} [props.onStep]             Step one message (paused-only); absent = no step button.
 * @param {Function} [props.onJump]             Jump handler for the offset input; absent = no input.
 * @param {Function} props.getViewNode          `() => node` — the live ring node (rows + Clear).
 * @param {Function} props.getLastEventTime     `() => ?number` — the link's last-frame ms clock.
 * @param {*}        props.sidebar              The configured `LogBrowser` element.
 * @param {Function} props.renderRow            One-row renderer for `LogRowList`.
 * @param {number}   props.rowHeight            Fixed row height (px).
 * @param {string}   [props.listClassName]      Extra `LogRowList` class.
 * @param {Function} [props.matchRow]           `(row, filterLower) => boolean` filter override.
 * @param {string}   [props.filterPlaceholder]  Filter input placeholder override.
 * @param {Function} [props.renderCount]        `(stats) => string` count label override.
 * @param {Function} [props.renderRate]         `(lps) => string` rate label override.
 * @param {*}        [props.toolbarExtras]      Extra toolbar controls (before Clear).
 * @param {*}        [props.belowToolbar]       Panel under the banner (e.g. a column picker).
 * @param {*}        [props.listHeader]         Header row above the list (adds a `${className}__main` wrapper).
 * @param {boolean}  [props.hasKeyColumn]       False drops the debug KEY column (keyless raw lines).
 * @return {import('react').ReactElement} Rendered component.
 */
export default function LogStreamViewer( {
	className,
	ariaLabel,
	title,
	headerControlsSlot,
	pickerOptions,
	selectedKey,
	onPick,
	pickerEmptyLabel,
	isPaused,
	connectionError,
	onTogglePause,
	onStep,
	onJump,
	getViewNode,
	getLastEventTime,
	sidebar,
	renderRow,
	rowHeight,
	listClassName,
	matchRow,
	filterPlaceholder,
	renderCount,
	renderRate,
	toolbarExtras,
	belowToolbar,
	listHeader,
	hasKeyColumn = true,
} ) {
	const [ filter, setFilter ] = useState( '' );
	// Debug rows: ID · KEY · VALUE, pretty structs, natural heights.
	const [ debug, setDebug ] = useState( false );
	const [ jumpText, setJumpText ] = useState( '' );
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
			{ pickerOptions && pickerOptions.length === 0 && (
				<span className="newspack-nodes-toolbar-status">
					{ pickerEmptyLabel }
				</span>
			) }
			{ pickerOptions && pickerOptions.length > 0 && (
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
				placeholder={
					filterPlaceholder ?? __( 'Filter…', 'newspack-nodes' )
				}
				value={ filter }
				onChange={ ( e ) => setFilter( e.target.value ) }
			/>

			{ onJump && (
				<input
					type="text"
					className="newspack-nodes-offset-input"
					placeholder={ __( 'seg:offset', 'newspack-nodes' ) }
					value={ jumpText }
					onChange={ ( e ) => setJumpText( e.target.value ) }
					onKeyDown={ ( e ) => {
						if ( 'Enter' === e.key ) {
							onJump( jumpText.trim() );
						}
					} }
					title={ __(
						'Jump: paste a message ID (seg:off:len) or a bare offset, Enter pauses and steps that message',
						'newspack-nodes'
					) }
				/>
			) }

			<span className="newspack-nodes-toolbar-stats">
				<span className="newspack-nodes-toolbar-stats__count">
					{ renderCount && renderCount( stats ) }
					{ ! renderCount && stats.visible !== stats.total
						? sprintf(
								// translators: 1: number of lines shown, 2: total number of lines.
								_n(
									'%1$d / %2$d line',
									'%1$d / %2$d lines',
									stats.total,
									'newspack-nodes'
								),
								stats.visible,
								stats.total
						  )
						: ! renderCount &&
						  sprintf(
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
						{ renderRate
							? renderRate( stats.lps )
							: sprintf(
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

			{ onStep && (
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
			) }

			<button
				className={ `button ${ debug ? 'is-active' : '' }` }
				onClick={ () => setDebug( ! debug ) }
				title={ __(
					'Debug rows: ID · KEY · VALUE, pretty structs, full lines',
					'newspack-nodes'
				) }
			>
				{ __( 'Debug', 'newspack-nodes' ) }
			</button>

			{ toolbarExtras }

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

	// The active header row: debug builds its own; normal is consumer-supplied.
	const activeHeader = debug
		? debugHeader( hasKeyColumn )
		: listHeader ?? null;
	const activeDebugRow = hasKeyColumn ? renderDebugRow : renderDebugRowNoKey;

	const list = (
		<LogRowList
			getNode={ getViewNode }
			rowHeight={ rowHeight }
			debug={ debug }
			renderRow={ debug ? activeDebugRow : renderRow }
			filter={ filter }
			matchRow={ matchRow }
			emptyLabel={ emptyLabel }
			onStats={ handleStats }
			resetSignal={ resetSignal }
			listClassName={ listClassName }
		/>
	);

	return (
		<div className={ className } role="region" aria-label={ ariaLabel }>
			{ title ? (
				<div className={ `${ className }__header` }>
					<h1 className="newspack-dashboard-title">{ title }</h1>
					{ renderedControls }
				</div>
			) : (
				renderedControls
			) }

			<ConnectionBanner
				connectionError={ connectionError }
				message={ __(
					'Connection lost. Reconnecting…',
					'newspack-nodes'
				) }
			/>

			{ belowToolbar }

			<div className={ `${ className }__body` }>
				{ sidebar }

				{ activeHeader ? (
					<div className={ `${ className }__main` }>
						{ activeHeader }
						{ list }
					</div>
				) : (
					list
				) }
			</div>
		</div>
	);
}
