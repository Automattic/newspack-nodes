/**
 * LogStreamViewer — the chrome every log-stream dashboard wears.
 *
 * It owns the toolbar (counts and rate, source picker, filter, offset jump,
 * pause, step, debug, clear), the reconnect banner, the collapsible browse
 * rail and the virtualized row list, so the Partition Viewer, the Log Viewer
 * and an adopter's own stream all behave alike.
 *
 * The consumer owns the node graph and passes what differs: the picker
 * catalog, the configured `LogBrowser` rail, the row renderer, and the
 * `getViewNode` accessor the ring-reading `LogRowList` calls each frame. This
 * component keeps presentational state only — filter text, rail visibility,
 * the debug toggle, the counts reported up — and every control leaves as a
 * message through a consumer callback. A control that reached into the view
 * node instead would leave the node's id stamp and rate smoother loaded, and
 * the next frame would overwrite it.
 *
 * Its one runtime touch is `Core.subscribeGraphGeneration`, which re-sends the
 * filter after a rebuild: the gate lives on the node, not in render.
 */

import { useEffect, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import { Core } from '../../runtime/core';
import LogRowList from './LogRowList';
import LogListHeader from './LogListHeader';
import ConnectionBanner from './ConnectionBanner';
import { HeaderSlot } from './HeaderSlot';

/** What the toolbar shows before the first frame, and after a Clear. */
const EMPTY_STATS = { total: 0, visible: 0, lps: 0 };

/**
 * The debug VALUE of one row: a struct's raw JSON pretty-printed, anything
 * else verbatim.
 *
 * Unparseable JSON falls back to the raw text rather than an error, because a
 * malformed line is the one a reader most needs to see.
 *
 * @param {Object} row One row, as the view node yields it from the ring.
 * @return {string} The text of the VALUE cell.
 */
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

/**
 * Build the shared debug-row renderer for one column layout.
 *
 * A factory rather than a component, because `LogRowList` memoizes its mapped
 * window on the renderer's identity: both variants are built once at module
 * scope below, so a re-render of this viewer never re-maps the rows.
 *
 * @param {boolean} hasKey Whether the row carries a KEY cell.
 * @return {RenderRow} The one-row renderer.
 */
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

/** The default debug row: ID, KEY and VALUE. */
const renderDebugRow = debugRow( true );

/** The keyless variant, for a source whose raw lines carry no KEY. */
const renderDebugRowNoKey = debugRow( false );

/**
 * The debug-mode column header matching the shared debug row.
 *
 * Its cells reuse the row's classes, so header and rows take their widths
 * from one CSS rule.
 *
 * @param {boolean} hasKeyColumn Whether to include the KEY column.
 * @return {import('react').ReactElement} The header row.
 */
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
 * Render the log-stream chrome around a consumer's view node.
 *
 * @param {Object}                    props                      Props.
 * @param {string}                    props.className            Root class; the body wrapper is `${className}__body`.
 * @param {string}                    props.ariaLabel            The region's accessible name.
 * @param {string}                    [props.title]              Inline page heading, for an adopter with no hub header.
 * @param {?Element}                  [props.headerControlsSlot] Hub shared-header slot to portal the controls into; null renders none, undefined renders them inline.
 * @param {?Array<Object>}            [props.pickerOptions]      `{ key, label, disabled? }` rows for the source dropdown; empty or absent renders no picker.
 * @param {string}                    [props.selectedKey]        The picked option's key; required only with a picker.
 * @param {Function}                  [props.onPick]             `(key) => void` — switch the source; required only with a picker.
 * @param {string}                    [props.pickerEmptyLabel]   Status text for an empty catalog; omit to say nothing about one.
 * @param {string}                    [props.pickerLabel]        The picker's accessible name; defaulted, never absent.
 * @param {boolean}                   props.isPaused             The view's paused flag.
 * @param {boolean}                   props.connectionError      The view's reconnect flag.
 * @param {() => void}                props.onTogglePause        Pause or resume the stream.
 * @param {() => void}                [props.onStep]             Deliver one message; absent renders no step button, and it is disabled while the stream runs.
 * @param {(offset: string) => void}  [props.onJump]             Handler for the offset input, called on Enter with the trimmed text; absent renders no input.
 * @param {() => ?Object}             props.getViewNode          The live ring node `LogRowList` reads. Read per call, so a graph rebuild is picked up.
 * @param {() => void}                props.onClear              Send the view's `clear` control.
 * @param {*}                         props.sidebar              The configured `LogBrowser` element; falsy docks no rail.
 * @param {RenderRow}                 props.renderRow            One-row renderer, forwarded to `LogRowList`.
 * @param {number}                    props.rowHeight            Fixed row height in px.
 * @param {string}                    [props.listClassName]      Extra `LogRowList` class.
 * @param {(term: string) => void}    [props.onFilter]           Send the view's `filter` control; the node gates INGEST on it, so the ring holds only what is displayed.
 * @param {string}                    [props.filterPlaceholder]  Filter input placeholder override.
 * @param {(stats: Object) => string} [props.renderCount]        Count-label override, taking `{ total, visible, lps }`; the default counts lines.
 * @param {(lps: number) => string}   [props.renderRate]         Rate-label override; the default reads lines per second.
 * @param {*}                         [props.toolbarExtras]      Extra toolbar controls, placed before Clear.
 * @param {*}                         [props.belowToolbar]       Panel under the banner, such as a column picker.
 * @param {*}                         [props.listHeader]         Header row above the list.
 * @param {RenderRow}                 [props.renderDebugRow]     Debug-mode row renderer; defaults to the shared debug row `hasKeyColumn` picks.
 * @param {*}                         [props.renderDebugHeader]  Debug-mode header; defaults to the header matching that row.
 * @param {boolean}                   [props.hasKeyColumn]       False drops the debug KEY column, for a source whose raw lines carry no KEY.
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
	pickerLabel = __( 'Browse a source', 'newspack-nodes' ),
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
	// replaces — "Reset Graph", a renewed session, a remount. The input still
	// reads the typed term while the fresh node admits everything, so re-send
	// it whenever the generation moves. Filtering at render would survive a
	// rebuild for free; filtering at ingest, which is what keeps the ring
	// holding only displayed rows, does not.
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

	// HeaderSlot places these: portalled, inline, or withheld by the host.
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

			{ pickerOptions?.length ? (
				<select
					className="newspack-nodes-select"
					value={ selectedKey }
					onChange={ ( e ) => onPick( e.target.value ) }
					aria-label={ pickerLabel }
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
			) : (
				pickerEmptyLabel && (
					<span className="newspack-nodes-toolbar-status">
						{ pickerEmptyLabel }
					</span>
				)
			) }

			<input
				type="text"
				className="newspack-nodes-search-input"
				aria-label={ __( 'Filter the stream', 'newspack-nodes' ) }
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
					aria-label={ __( 'Jump to an offset', 'newspack-nodes' ) }
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
				aria-label={
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
					aria-label={ __( 'Step one message', 'newspack-nodes' ) }
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
						>
							{ railOpen ? '\u2039' : '\u203a' }
						</button>
						{ railOpen && sidebar }
					</div>
				) }

				{ /* ONE stable wrapper in BOTH modes. Reparenting the list
				     across the debug toggle would remount it, and its fresh
				     refs would replay the whole ring as one glide. */ }
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
