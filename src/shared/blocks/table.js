/**
 * The table block: its source's model, a list of rows each carrying an `id`,
 * as a `DataViewsList` table whose columns are the fields it names, every
 * declared field when it names nothing, each headed by its declared label. The reader
 * sorts and pages it in the page, from the sort and page size its
 * attributes give; that view is the reader's own and writes nothing.
 */

import { useMemo, useState } from '@wordpress/element';
import { filterSortAndPaginate } from '@wordpress/dataviews';
import { __ } from '@wordpress/i18n';
import DataViewsList from '../components/DataViewsList';
import Section from '../components/Section';
import { stableJson } from '../sources';
import { display, sourceBlock } from './sourceBlock';

/**
 * The DataViews field for one of the block's fields.
 *
 * @param {import('./sourceBlock').BlockField} field The field.
 * @return {Object} The DataViews field.
 */
const dataViewsField = ( field ) => ( {
	id: field.key,
	label: field.label,
	enableHiding: false,
	getValue: ( { item } ) => item[ field.key ],
	render: ( { item } ) => display( field, item[ field.key ] ),
} );

/**
 * The block: its rows, read afresh whenever the sort or the page size its
 * attributes give moves, since those seed the reader's own view.
 *
 * @param {Object}                               props
 * @param {Object}                               props.attributes `{ source, columns, sort, perPage, title }`.
 * @param {Object[]}                             props.model      The rows.
 * @param {import('./sourceBlock').BlockField[]} props.fields     The columns.
 * @return {import('react').ReactElement} The table.
 */
function Table( { attributes, model, fields } ) {
	const { sort, perPage } = attributes;
	return (
		<Rows
			key={ stableJson( { sort, perPage } ) }
			attributes={ attributes }
			model={ model }
			fields={ fields }
		/>
	);
}

/**
 * The table the reader sorts and pages.
 *
 * @param {Object}                               props
 * @param {Object}                               props.attributes `{ source, columns, sort, perPage, title }`.
 * @param {Object[]}                             props.model      The rows.
 * @param {import('./sourceBlock').BlockField[]} props.fields     The columns.
 * @return {import('react').ReactElement} The table.
 */
function Rows( { attributes, model, fields: named } ) {
	const { sort, perPage, title } = attributes;
	const fields = useMemo( () => named.map( dataViewsField ), [ named ] );
	const [ view, setView ] = useState(
		() =>
			/** @type {import('@wordpress/dataviews').View} */ ( {
				type: 'table',
				page: 1,
				perPage,
				fields: [],
				...( sort.field ? { sort } : {} ),
			} )
	);
	const { data, paginationInfo } = useMemo(
		() => filterSortAndPaginate( model, view, fields ),
		[ model, view, fields ]
	);
	const table = (
		<DataViewsList
			items={ data }
			view={ view }
			onChangeView={ setView }
			layout="table"
			empty={ __( 'Nothing to show yet.', 'newspack-nodes' ) }
			paginationInfo={ paginationInfo }
			render={ fields[ 0 ].render }
			fields={ fields }
			columns={ fields.map( ( field ) => field.id ) }
		/>
	);
	return title ? <Section heading={ title }>{ table }</Section> : table;
}

export default sourceBlock( Table, {
	kind: 'rows',
	list: 'columns',
	settings: [ 'title', 'perPage' ],
} );
