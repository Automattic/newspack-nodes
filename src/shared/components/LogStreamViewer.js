/**
 * LogStreamViewer — the shared chrome of the substrate's log-stream dashboards
 * (Partition Viewer, Log Viewer): a toolbar (source dropdown, filter, line
 * counts + rate, pause, clear) that portals into the hub header slot when
 * given one, the reconnect banner, and the sidebar + virtualized row-list body.
 *
 * Presentational + local UI state only. The consumer mounts its own node graph
 * and passes the differing pieces: the picker catalog, the fully-configured
 * `LogBrowser` sidebar element, the row renderer, and the `getViewNode`
 * accessor (the ring `LogRowList` reads) — so this component stays
 * runtime-free like its `LogRowList` sibling.
 */

import { useEffect, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import { Core } from '../../runtime/core';
import LogRowList from './LogRowList';
import LogListHeader from './LogListHeader';
import ConnectionBanner from './ConnectionBanner';
import { HeaderSlot } from './HeaderSlot';

// What the toolbar shows before the first frame, and after a Clear.
const EMPTY_STATS = { total: 0, visible: 0, lps: 0 };

// Pretty-print a struct row's raw JSON; anything else renders verbatim.
export const debugValue = ( row ) => {
	if ( row.struct && row.raw ) {
		try {
			return JSON.stringify( JSON.parse( row.raw ), null, 2 );
		} catch ( e ) {
			return row.raw;
		}
	}
	return row.raw ?? row.content;
};

// One debug row; the KEY column is what the two variants differ by.
const debugRow = ( hasKey ) => ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-table__row newspack-nodes-log-row is-debug ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
		data-p={ row.partition }
	>
		<span className="newspack-nodes-table__cell is-muted newspack-nodes-log-row__id">
			{ row.msgId || '?' }
		</span>
		{ hasKey && (
			<span className="newspack-nodes-table__cell is-secondary newspack-nodes-log-row__key">
				{ row.key || '' }
			</span>
		) }
		<span className="newspack-nodes-table__cell newspack-nodes-log-row__value">
			{ debugValue( row ) }
		</span>
	</div>
);

// Module-scope: a stable identity keeps LogRowList's row memoization live.
const renderDebugRow = debugRow( true );
// Log Viewer variant: raw lines carry no KEY — two columns only.
const renderDebugRowNoKey = debugRow( false );

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

/** @typedef {import('./LogRowList').RenderRow} RenderRow */

/**
 * @param {Object}                 props                      Props.
 * @param {string}                 props.className            Root class; the body wrapper is `${className}__body`.
 * @param {string}                 props.ariaLabel            The region's accessible name.
 * @param {string}                 [props.title]              Inline page heading (adopters without a hub header).
 * @param {?Element}               [props.headerControlsSlot] Hub shared-header slot to portal the controls into; null renders none, undefined renders them inline.
 * @param {?Array}                 props.pickerOptions        `{ key, label, disabled? }` rows for the source dropdown; null = no picker.
 * @param {string}                 [props.selectedKey]        The picked option's key; required only with a picker.
 * @param {Function}               [props.onPick]             `(key) => void` — switch the source; required only with a picker.
 * @param {string}                 [props.pickerEmptyLabel]   Status text when the catalog is empty; required only with a picker.
 * @param {boolean}                props.isPaused             The view's paused flag.
 * @param {boolean}                props.connectionError      The view's reconnect flag.
 * @param {() => void}             props.onTogglePause        Pause/resume the stream.
 * @param {() => void}             [props.onStep]             Step one message (paused-only); absent = no step button.
 * @param {Function}               [props.onJump]             Jump handler for the offset input; absent = no input.
 * @param {Function}               props.getViewNode          `() => node` — the live ring node `LogRowList` reads.
 * @param {() => void}             props.onClear              Send the view's `clear` control. Required.
 * @param {*}                      props.sidebar              The configured `LogBrowser` element.
 * @param {RenderRow}              props.renderRow            One-row renderer, forwarded to `LogRowList`.
 * @param {number}                 props.rowHeight            Fixed row height (px).
 * @param {string}                 [props.listClassName]      Extra `LogRowList` class.
 * @param {(term: string) => void} props.onFilter             Send the view's `filter` control; the node gates ingest on it. Required.
 * @param {string}                 [props.filterPlaceholder]  Filter input placeholder override.
 * @param {Function}               [props.renderCount]        `(stats) => string` count label override.
 * @param {Function}               [props.renderRate]         `(lps) => string` rate label override.
 * @param {*}                      [props.toolbarExtras]      Extra toolbar controls (before Clear).
 * @param {*}                      [props.belowToolbar]       Panel under the banner (e.g. a column picker).
 * @param {*}                      [props.listHeader]         Header row above the list (adds a `${className}__main` wrapper).
 * @param {RenderRow}              [props.renderDebugRow]     Debug-mode row renderer; defaults to the shared ID/Key/Value row.
 * @param {*}                      [props.renderDebugHeader]  Debug-mode header; defaults to the shared ID/Key/Value header.
 * @param {boolean}                [props.hasKeyColumn]       False drops the debug KEY column (keyless raw lines).
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
	onClear,
	sidebar,
	renderRow,
	rowHeight,
	listClassName,
	onFilter,
	filterPlaceholder,
	renderCount,
	renderRate,
	toolbarExtras,
	belowToolbar,
	listHeader,
	renderDebugRow: renderDebugRowOverride,
	renderDebugHeader,
	hasKeyColumn = true,
} ) {
	const [ filter, setFilter ] = useState( '' );
	// Browse-rail visibility, remembered per dashboard (className-keyed).
	const railKey = `newspack-nodes-rail:${ className }`;
	const [ railOpen, setRailOpen ] = useState( () => {
		try {
			return 'closed' !== window.localStorage.getItem( railKey );
		} catch ( e ) {
			return true;
		}
	} );
	const toggleRail = () => {
		const next = ! railOpen;
		setRailOpen( next );
		try {
			window.localStorage.setItem( railKey, next ? 'open' : 'closed' );
		} catch ( e ) {
			// Preference-only; ignore storage failures.
		}
	};
	// Debug rows: ID · KEY · VALUE, pretty structs, natural heights.
	const [ debug, setDebug ] = useState( false );
	const [ jumpText, setJumpText ] = useState( '' );
	// Counts LogRowList reports up (row DATA never becomes React state).
	const [ stats, setStats ] = useState( EMPTY_STATS );

	// @longform The gate lives on the view node, which a graph rebuild
	// replaces — "Reset Graph", a renewed session, a remount. The input would
	// still read the typed term while the fresh node admitted everything, so
	// re-send it whenever the generation moves. Render-time filtering survived
	// a rebuild for free because it lived here; this does not.
	useEffect(
		() => Core.subscribeGraphGeneration( () => onFilter?.( filter ) ),
		[ filter, onFilter ]
	);
	// Bumped to rebase the list on Clear (also re-reads the emptied ring).
	const [ resetSignal, setResetSignal ] = useState( 0 );

	// Clear travels as a message; the viewer never reaches into the node.
	const handleClear = () => {
		onClear();
		setStats( EMPTY_STATS );
		setResetSignal( ( n ) => n + 1 );
	};

	const emptyLabel = isPaused
		? __( 'Paused', 'newspack-nodes' )
		: __( 'Waiting for log lines…', 'newspack-nodes' );

	// Controls strip portals into the hub header slot; undefined = inline.
	const controls = (
		<div className="newspack-nodes-toolbar">
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
				<span className="newspack-nodes-toolbar-stats__rps">
					{ renderRate
						? renderRate( stats.lps )
						: sprintf(
								// translators: %s: lines-per-second rate (one decimal place).
								__( '%s lines/s', 'newspack-nodes' ),
								stats.lps.toFixed( 1 )
						  ) }
				</span>
			</span>

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
				onChange={ ( e ) => {
					setFilter( e.target.value );
					onFilter?.( e.target.value );
				} }
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

	// Debug builds its own; a column-picking consumer supplies both.
	const activeHeader = debug
		? renderDebugHeader ?? debugHeader( hasKeyColumn )
		: listHeader ?? null;
	const activeDebugRow =
		renderDebugRowOverride ??
		( hasKeyColumn ? renderDebugRow : renderDebugRowNoKey );
	const railToggleLabel = railOpen
		? __( 'Hide the browse rail', 'newspack-nodes' )
		: __( 'Show the browse rail', 'newspack-nodes' );

	const list = (
		<LogRowList
			getNode={ getViewNode }
			rowHeight={ rowHeight }
			debug={ debug }
			renderRow={ debug ? activeDebugRow : renderRow }
			emptyLabel={ emptyLabel }
			onStats={ setStats }
			resetSignal={ resetSignal }
			listClassName={ listClassName }
		/>
	);

	return (
		<div className={ className } role="region" aria-label={ ariaLabel }>
			{ title ? (
				<div
					className={ `newspack-nodes-request-stream-header ${ className }__header` }
				>
					<h1 className="newspack-dashboard-title">{ title }</h1>
					<HeaderSlot slot={ headerControlsSlot }>
						{ controls }
					</HeaderSlot>
				</div>
			) : (
				<HeaderSlot slot={ headerControlsSlot }>
					{ controls }
				</HeaderSlot>
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
				{ sidebar && (
					<div
						className={ `newspack-nodes-rail-dock${
							railOpen ? '' : ' is-collapsed'
						}` }
					>
						<button
							type="button"
							className="newspack-nodes-rail-toggle"
							onClick={ toggleRail }
							aria-label={ railToggleLabel }
							aria-expanded={ railOpen }
							title={ railToggleLabel }
						>
							{ railOpen ? '\u2039' : '\u203a' }
						</button>
						{ railOpen && sidebar }
					</div>
				) }

				{ /* ONE stable wrapper in BOTH modes: reparenting the list
				     across the debug toggle would remount it (fresh refs =
				     the whole ring replayed as a glide). */ }
				<div
					className={ `${ className }__main newspack-nodes-log-main` }
				>
					{ activeHeader }
					{ list }
				</div>
			</div>
		</div>
	);
}
