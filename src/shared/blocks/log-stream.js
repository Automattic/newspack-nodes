/**
 * The log-stream block: its stream source's rows in the shared
 * `LogStreamViewer`, one column per field it names, every declared field
 * when it names nothing, each headed by its declared label. Pause, filter and clear go to
 * the source's view, which every reader of the key shares, so on a layout
 * being edited they send nothing.
 */

import { useMemo } from '@wordpress/element';
import LogListHeader from '../components/LogListHeader';
import LogStreamViewer from '../components/LogStreamViewer';
import { useEditing, useWriteControl } from '../composition/page/pageContext';
import { shown, sourceBlock } from './sourceBlock';

/** A row's fixed height in pixels, as the Partition Viewer's. */
const ROW_HEIGHT = 33;

/**
 * The row renderer for some fields: a cell per field, as each shows its value.
 *
 * @param {import('./sourceBlock').BlockField[]} fields The columns.
 * @return {import('../components/LogRowList').RenderRow} The renderer.
 */
export const logRow = ( fields ) => ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-table__row newspack-nodes-log-row ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
	>
		{ fields.map( ( field ) => (
			<span
				key={ field.key }
				className="newspack-nodes-table__cell newspack-nodes-log-row__value"
			>
				{ shown( field, row[ field.key ] ) }
			</span>
		) ) }
	</div>
);

/**
 * The block.
 *
 * @param {Object}                                        props
 * @param {Object}                                        props.attributes `{ source, columns, title }`.
 * @param {?Object}                                       props.model      The view's model, `paused` and `connectionError`, null until it publishes.
 * @param {import('./sourceBlock').BlockField[]}          props.fields     The columns.
 * @param {import('../sources/useSource').StreamControls} [props.stream]   The view and its controls.
 * @return {import('react').ReactElement} The viewer.
 * @throws {Error} When the source is not a stream.
 */
function LogStream( { attributes, model, fields, stream } ) {
	const { source, title } = attributes;
	if ( ! stream ) {
		throw new Error( `${ source } is not a stream source` );
	}
	const { renderRow, header } = useMemo( () => {
		return {
			renderRow: logRow( fields ),
			header: (
				<LogListHeader
					columns={ fields.map( ( field ) => ( {
						key: field.key,
						label: field.label,
						className: 'newspack-nodes-log-row__value',
					} ) ) }
				/>
			),
		};
	}, [ fields ] );
	const editing = useEditing();
	const togglePause = useWriteControl( () =>
		stream.setPaused( ! model?.paused )
	).onClick;
	const clear = useWriteControl( stream.clear ).onClick;
	return (
		<LogStreamViewer
			className="newspack-nodes-log-stream-block"
			ariaLabel={ title || source }
			isPaused={ !! model?.paused }
			connectionError={ !! model?.connectionError }
			onTogglePause={ togglePause }
			onClear={ clear }
			onFilter={ editing ? undefined : stream.setFilter }
			getViewNode={ stream.node }
			sidebar={ null }
			renderRow={ renderRow }
			rowHeight={ ROW_HEIGHT }
			listHeader={ header }
		/>
	);
}

export default sourceBlock( LogStream, {
	kind: 'rows',
	list: 'columns',
	settings: [ 'title' ],
} );
