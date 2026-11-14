/**
 * The log-stream block: its stream source's rows in the shared
 * `LogStreamViewer`, one column per field it names, every declared field
 * when it names nothing. Each column is headed by its field's label and
 * tooltip and laid out at its declared `width`, and a field declaring a
 * `cell( row )` draws its whole cell, `role="cell"` included. A block naming fewer columns
 * than its source declares offers the rest through **Cols**, the reader's
 * choice kept under the source's `columnsKey`.
 *
 * The source's declaration names what the chrome says: its `label` names
 * the region and its table, `count( stats )` and `rate( lps )` the toolbar's
 * figures, `placeholder` the filter, which a source naming none draws
 * without, and `empty` the list while it holds nothing. A browsed stream
 * adds its partition picker, its rail, its offset jump and its step. A
 * block whose `toolbar` is `header` puts that toolbar in the header slot its
 * page offers (`headerSlot`), and a control the page hands its source
 * (`sourceControls`) stands in the toolbar just ahead of **Cols**. Pause, filter and clear go to the source's view, which every
 * reader of the key shares, so on a layout being edited they send nothing.
 */

import {
	Fragment,
	memo,
	useContext,
	useMemo,
	useState,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import ColumnPicker from '../components/ColumnPicker';
import LogListHeader from '../components/LogListHeader';
import LogStreamViewer from '../components/LogStreamViewer';
import { gridTemplate, useColumnPicker } from '../hooks/useColumnPicker';
import {
	ComposedPage,
	useEditing,
	useWriteControl,
} from '../composition/page/pageContext';
import { sourceDeclaration } from '../sources';
import { display, namedFields, sourceBlock } from './sourceBlock';
import './log-stream.scss';

/** A row's fixed height in pixels, as the Partition Viewer's. */
const ROW_HEIGHT = 33;

/**
 * One field's cell: the whole cell its declared `cell( row )` draws, else its
 * value as it shows.
 *
 * @param {import('./sourceBlock').BlockField} field The column.
 * @param {Object}                             row   The row.
 * @return {import('react').ReactElement} The cell.
 */
const cellOf = ( field, row ) =>
	field.cell ? (
		<Fragment key={ field.key }>{ field.cell( row ) }</Fragment>
	) : (
		<span
			key={ field.key }
			role="cell"
			className="newspack-nodes-table__cell newspack-nodes-log-row__value"
		>
			{ display( field, row[ field.key ] ) }
		</span>
	);

const LogRow = memo(
	/**
	 * One row, a cell per column on their grid, drawn again only when the
	 * row or the columns change.
	 *
	 * @param {Object}                               props
	 * @param {Object}                               props.row    The row.
	 * @param {import('./sourceBlock').BlockField[]} props.fields The columns.
	 * @param {Object}                               props.style  Their grid.
	 * @return {import('react').ReactElement} The row.
	 */
	function LogRow( { row, fields, style } ) {
		return (
			<div
				role="row"
				className={ `newspack-nodes-table__row newspack-nodes-log-row ${
					row.isEven ? 'row-even' : 'row-odd'
				}` }
				style={ style }
			>
				{ fields.map( ( field ) => cellOf( field, row ) ) }
			</div>
		);
	}
);

/**
 * The row renderer for some fields: each row a `LogRow` keyed by its id, so
 * a row already drawn is not drawn again as new rows arrive.
 *
 * @param {import('./sourceBlock').BlockField[]} fields The columns.
 * @return {import('../components/LogRowList').RenderRow} The renderer.
 */
export const logRow = ( fields ) => {
	const style = { gridTemplateColumns: tracks( fields ) };
	return ( row ) => (
		<LogRow key={ row.id } row={ row } fields={ fields } style={ style } />
	);
};

/**
 * The grid track list for some fields, by their declared widths.
 *
 * @param {import('./sourceBlock').BlockField[]} fields The columns.
 * @return {string} A `grid-template-columns` value.
 */
const tracks = ( fields ) =>
	gridTemplate(
		Object.fromEntries( fields.map( ( field ) => [ field.key, field ] ) ),
		fields.map( ( field ) => field.key )
	);

/**
 * The block.
 *
 * @param {Object}                                        props
 * @param {Object}                                        props.attributes `{ source, columns, title }`.
 * @param {?Object}                                       props.model      The view's model, `paused` and `connectionError`, null until it publishes.
 * @param {import('./sourceBlock').BlockField[]}          props.fields     The columns it names.
 * @param {import('../sources/useSource').StreamControls} [props.stream]   The view and its controls.
 * @return {import('react').ReactElement} The viewer.
 * @throws {Error} When the source is not a stream.
 */
function LogStream( { attributes, model, fields, stream } ) {
	const { source, title } = attributes;
	if ( ! stream ) {
		throw new Error( `${ source } is not a stream source` );
	}
	const decl = sourceDeclaration( source );
	const declared = useMemo(
		() => namedFields( source, [], 'rows' ),
		[ source ]
	);
	const picks = fields.length < declared.length;
	const columns = useMemo(
		() =>
			Object.fromEntries(
				declared.map( ( field ) => [ field.key, field ] )
			),
		[ declared ]
	);
	const named = useMemo(
		() => fields.map( ( field ) => field.key ),
		[ fields ]
	);
	const picker = useColumnPicker( {
		columns,
		storageKey: decl.columnsKey ?? `newspack-nodes-log-columns:${ source }`,
		defaultVisible: named,
	} );
	const visible = useMemo(
		() =>
			picks
				? picker.visibleColumns.map( ( key ) => columns[ key ] )
				: fields,
		[ picks, picker.visibleColumns, columns, fields ]
	);
	const [ picking, setPicking ] = useState( false );
	const { renderRow, header } = useMemo(
		() => ( {
			renderRow: logRow( visible ),
			header: (
				<div
					className="newspack-nodes-log-stream-block__columns"
					style={
						/** @type {import('react').CSSProperties} */ ( {
							'--log-columns': tracks( visible ),
						} )
					}
				>
					<LogListHeader
						columns={ visible.map( ( field ) => ( {
							key: field.key,
							label: field.label,
							tooltip: field.tooltip,
							className: 'newspack-nodes-log-row__value',
						} ) ) }
					/>
				</div>
			),
		} ),
		[ visible ]
	);
	const editing = useEditing();
	const page = useContext( ComposedPage );
	const togglePause = useWriteControl( () =>
		stream.setPaused( ! model?.paused )
	).onClick;
	const clear = useWriteControl( stream.clear ).onClick;
	const { browse } = stream;
	return (
		<LogStreamViewer
			headerControlsSlot={
				'header' === attributes.toolbar ? page?.headerSlot : undefined
			}
			className="newspack-nodes-log-stream-block"
			ariaLabel={ title || decl.label || source }
			isPaused={ !! model?.paused }
			connectionError={ !! model?.connectionError }
			subscribe={ stream.subscribe }
			pickerOptions={ browse?.pickerOptions }
			selectedKey={ browse?.selectedPartition }
			onPick={ browse?.selectPartition }
			pickerLabel={ browse?.pickerLabel }
			onTogglePause={ togglePause }
			onStep={ stream.step }
			onJump={ browse?.jump }
			onClear={ clear }
			onFilter={ filterOf( decl, editing, stream ) }
			getViewNode={ stream.node }
			sidebar={ browse?.sidebar ?? null }
			renderRow={ renderRow }
			rowHeight={ ROW_HEIGHT }
			listHeader={ header }
			filterPlaceholder={ decl.placeholder }
			renderCount={ decl.count }
			renderRate={ decl.rate }
			emptyLabel={ decl.empty }
			toolbarExtras={
				<>
					{ page?.sourceControls?.[ source ] }
					{ picks && (
						<button
							type="button"
							className={ `button${
								picking ? ' is-active' : ''
							}` }
							onClick={ () => setPicking( ! picking ) }
							title={ __( 'Select columns', 'newspack-nodes' ) }
						>
							{ __( 'Cols', 'newspack-nodes' ) }
						</button>
					) }
				</>
			}
			belowToolbar={
				picks &&
				picking && (
					<ColumnPicker
						columns={ columns }
						isVisible={ picker.isVisible }
						onToggle={ picker.toggleColumn }
						idPrefix={ `${ source }-col` }
					/>
				)
			}
		/>
	);
}

/** Does nothing, as the filter does on a layout being edited. */
const NOTHING = () => {};

/**
 * What the filter sends: nothing for a source naming no filter, which draws
 * none, and nothing on a layout being edited.
 *
 * @param {Object}                                        decl    The source's declaration.
 * @param {boolean}                                       editing Whether the layout is edited.
 * @param {import('../sources/useSource').StreamControls} stream  The view's controls.
 * @return {((term: string) => void)|undefined} The filter's sender.
 */
function filterOf( decl, editing, stream ) {
	if ( ! decl.placeholder ) {
		return undefined;
	}
	return editing ? NOTHING : stream.setFilter;
}

export default sourceBlock( LogStream, {
	kind: 'rows',
	list: 'columns',
	settings: [ 'title', 'toolbar' ],
} );
