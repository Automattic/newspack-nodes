/**
 * The one DataViews list every dashboard draws: each item by the row the
 * caller names, in the layout the view names, the caller's own words when
 * there is none, and a pager only when there is a second page.
 *
 * `@wordpress/dataviews` resolves to the substrate's `newspack-nodes-dataviews`
 * global in every build, and the enqueue of a bundle reading it puts the
 * script and its stylesheet on the page.
 */

import { Button, CheckboxControl } from '@wordpress/components';
import { DataViews } from '@wordpress/dataviews';
import { createContext, useContext } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import './DataViewsList.scss';

/** The one field every layout draws an item by. */
const ROW = 'row';

/** What the one cell draws each row with, set by the list around it. */
const RowContext = createContext( null );

/**
 * One item's row, as the list names it, after its checkbox where the list
 * checks rows. A component of its own, so every render keeps the row.
 *
 * @param {Object} props
 * @param {Object} props.item The item.
 * @return {import('react').ReactElement} The row.
 */
function RowCell( { item } ) {
	const {
		Row,
		rowProps,
		selectLabel,
		getItemId,
		selection,
		onChangeSelection,
	} = useContext( RowContext );
	const row = <Row item={ item } { ...rowProps } />;
	if ( ! selectLabel ) {
		return row;
	}
	const id = getItemId( item );
	const checked = selection.includes( id );
	return (
		<div className="newspack-nodes-dataviews__checkable">
			<CheckboxControl
				aria-label={ selectLabel( item ) }
				checked={ checked }
				onChange={ () =>
					onChangeSelection(
						checked
							? selection.filter( ( one ) => id !== one )
							: [ ...selection, id ]
					)
				}
			/>
			{ row }
		</div>
	);
}

/**
 * "Page %1$d of %2$d" with Previous and Next, drawn past one page or on a view
 * left past the last, whose Previous leads back to it.
 *
 * @param {Object}                 props
 * @param {Object}                 props.view         The view.
 * @param {(view: Object) => void} props.onChangeView Moves the view.
 * @param {number}                 props.totalPages   The pages there are.
 * @return {?import('react').ReactElement} The pager.
 */
function Pager( { view, onChangeView, totalPages } ) {
	const page = view.page ?? 1;
	if ( totalPages <= 1 && page <= 1 ) {
		return null;
	}
	const pages = Math.max( totalPages, 1 );
	const go = ( to ) => onChangeView( { ...view, page: to } );
	return (
		<div className="newspack-nodes-dataviews__pager">
			<span className="newspack-nodes-status is-muted">
				{ sprintf(
					/* translators: 1: this page, 2: the pages there are. */
					__( 'Page %1$d of %2$d', 'newspack-nodes' ),
					page,
					pages
				) }
			</span>
			{ 1 < page && (
				<Button
					variant="secondary"
					onClick={ () => go( Math.min( page - 1, pages ) ) }
				>
					{ __( 'Previous', 'newspack-nodes' ) }
				</Button>
			) }
			{ page < totalPages && (
				<Button variant="secondary" onClick={ () => go( page + 1 ) }>
					{ __( 'Next', 'newspack-nodes' ) }
				</Button>
			) }
		</div>
	);
}

/**
 * An item's key as DataViews reads it when the caller names none.
 *
 * @param {Object} item The item.
 * @return {string} Its `id`.
 */
const itemId = ( item ) => item.id;

/**
 * `<DataViewsList items view onChangeView layout? empty paginationInfo render
 * rowProps? label? fields? actions? header? getItemId? selection?
 * onChangeSelection? selectLabel? />`: DataViews over the items, keyed by
 * `getItemId`, the item's `id` unless named. `layout` names one layout, or
 * several with the first the default; `view.type` picks among them. Each item
 * draws as `render` (a component taking `item` and `rowProps`) in the layout's
 * title place, headed `label`, so `fields` adds only further columns.
 * `actions` pass through, `supportsBulk` and `isPrimary` with them. `header`
 * stands above the list inside DataViews, where `DataViews.Search`,
 * `DataViews.FiltersToggle` and `DataViews.FiltersToggled` read the view; any
 * other DataViews prop passes through.
 *
 * Given `selectLabel`, the rows keep their own controls and the actions act on
 * a checked run alone: each row draws a checkbox named `selectLabel( item )`
 * that adds it to `selection` or takes it out, through `onChangeSelection`;
 * `DataViews.BulkActionToolbar` stands above the list; and the list carries
 * `newspack-nodes-dataviews__run-only`, which hides the action cells and the
 * selection checkboxes DataViews draws in each row. `selectLabel` without
 * `selection` and `onChangeSelection` throws.
 *
 * @typedef {Object} DataViewsListProps
 * @property {Object[]}                                      items               The page's items.
 * @property {Object}                                        view                The DataViews view: `type`, `page`, `perPage`, and any `sort`, `search`, `filters` or `groupBy`.
 * @property {(view: Object) => void}                        onChangeView        Takes the view moved.
 * @property {string | string[]}                             [layout]            `list`, `activity`, `table` or `grid`, or several, the first the default.
 * @property {import('react').ReactNode}                     empty               What an empty list says, in place of DataViews' own.
 * @property {{totalItems: number, totalPages: number}}      paginationInfo      The server's total, and the pages it makes.
 * @property {import('react').ComponentType<{item: Object}>} render              The row.
 * @property {Object}                                        [rowProps]          Props each row takes beside its item.
 * @property {string}                                        [label]             The row column's heading, "Item" unless named.
 * @property {Object[]}                                      [fields]            Further DataViews fields, as columns or filters.
 * @property {Object[]}                                      [actions]           DataViews actions.
 * @property {import('react').ReactNode}                     [header]            Controls above the list.
 * @property {(item: Object) => string}                      [getItemId]         An item's key, its `id` unless named.
 * @property {string[]}                                      [selection]         The keys of the checked run.
 * @property {(selection: string[]) => void}                 [onChangeSelection] Takes the run changed.
 * @property {(item: Object) => string}                      [selectLabel]       Names a row's checkbox; given, the rows are checked into a run.
 *
 * @param    {DataViewsListProps & Object<string, any>}      props               Its own props, and any DataViews prop, which passes through.
 * @return {import('react').ReactElement} The list.
 */
export default function DataViewsList( {
	items,
	view,
	onChangeView,
	layout = 'list',
	empty,
	paginationInfo,
	render: Row,
	rowProps = {},
	label = __( 'Item', 'newspack-nodes' ),
	fields = [],
	actions = [],
	header = null,
	getItemId = itemId,
	selection,
	onChangeSelection,
	selectLabel,
	...rest
} ) {
	if ( selectLabel && ( ! selection || ! onChangeSelection ) ) {
		throw new Error(
			'DataViewsList: selectLabel checks rows into selection, so it needs selection and onChangeSelection'
		);
	}
	const layouts = [].concat( layout );
	return (
		<RowContext.Provider
			value={ {
				Row,
				rowProps,
				selectLabel,
				getItemId,
				selection,
				onChangeSelection,
			} }
		>
			<div className="newspack-nodes-dataviews">
				<DataViews
					data={ items }
					getItemId={ getItemId }
					view={ { ...view, titleField: ROW } }
					onChangeView={ onChangeView }
					fields={ [
						{
							id: ROW,
							label,
							enableHiding: false,
							enableSorting: false,
							render: RowCell,
						},
						...fields,
					] }
					defaultLayouts={ Object.fromEntries(
						layouts.map( ( type ) => [ type, {} ] )
					) }
					actions={ actions }
					paginationInfo={ paginationInfo }
					empty={ empty }
					selection={ selection }
					onChangeSelection={ onChangeSelection }
					{ ...rest }
				>
					{ header }
					{ selectLabel && <DataViews.BulkActionToolbar /> }
					<DataViews.Layout
						className={
							selectLabel
								? 'newspack-nodes-dataviews__run-only'
								: undefined
						}
					/>
					<Pager
						view={ view }
						onChangeView={ onChangeView }
						totalPages={ paginationInfo.totalPages }
					/>
				</DataViews>
			</div>
		</RowContext.Provider>
	);
}
