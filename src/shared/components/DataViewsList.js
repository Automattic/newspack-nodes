/**
 * The one DataViews list every dashboard draws: each item by the row the
 * caller names, in the layout the view names, the caller's own words when
 * there is none, and a pager only when there is a second page.
 *
 * `@wordpress/dataviews` resolves to the substrate's `newspack-nodes-dataviews`
 * global in every build, and the enqueue of a bundle reading it puts the
 * script and its stylesheet on the page.
 */

import { Button, CheckboxControl, Modal } from '@wordpress/components';
import { DataViews } from '@wordpress/dataviews';
import { createContext, useContext, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import CloseIcon from './CloseIcon';
import useNarrow from '../hooks/useNarrow';
import './DataViewsList.scss';

/** The one field every layout draws an item by. */
const ROW = 'row';

/** What the one cell draws each row with, set by the list around it. */
const RowContext = createContext( null );

/** The selection DataViews holds in a checked list: none, and always this one. */
const NO_SELECTION = [];

/** What DataViews may change a checked list's selection through: nothing. */
const keepRun = () => {};

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
 * Whether an action may act on an item: it declares no `isEligible`, or that
 * passes the item.
 *
 * @param {Object} action The DataViews action.
 * @param {Object} item   The item.
 * @return {boolean} Whether it fits.
 */
const fits = ( action, item ) =>
	! action.isEligible || action.isEligible( item );

/**
 * What the toolbar's count reads: the run checked, and how much of it is on
 * this page when some is not, since the actions take this page's rows alone;
 * or with none checked the items as DataViews' own footer counts them.
 *
 * @param {number} run   How many keys the run holds, on any page.
 * @param {number} on    How many of them are on this page.
 * @param {number} shown The items on this page.
 * @param {number} total The items on every page.
 * @return {string} The count.
 */
function runCount( run, on, shown, total ) {
	if ( 0 < run && on < run ) {
		return sprintf(
			/* translators: 1: how many items the checked run holds, 2: how many of them are on this page. */
			_n(
				'%1$d Item selected, %2$d on this page',
				'%1$d Items selected, %2$d on this page',
				run,
				'newspack-nodes'
			),
			run,
			on
		);
	}
	if ( 0 < run ) {
		return sprintf(
			/* translators: %d: how many items the checked run holds. */
			_n(
				'%d Item selected',
				'%d Items selected',
				run,
				'newspack-nodes'
			),
			run
		);
	}
	if ( total > shown ) {
		return sprintf(
			/* translators: 1: the items on this page, 2: the items on every page. */
			_n(
				'%1$d of %2$d Item',
				'%1$d of %2$d Items',
				total,
				'newspack-nodes'
			),
			shown,
			total
		);
	}
	return sprintf(
		/* translators: %d: the items on this page. */
		_n( '%d Item', '%d Items', shown, 'newspack-nodes' ),
		shown
	);
}

/**
 * The checked list's own toolbar, in DataViews' bulk-footer classes so it
 * looks like the stock one: a checkbox over this page's rows a bulk action can
 * act on, adding them to the run or taking them out and keeping every key from
 * another page; the run's count; a button per bulk action some checked row on
 * this page is eligible for, named by those rows and handed every checked row
 * of this page a bulk action takes, as DataViews' own toolbar hands them, busy
 * while its callback runs, or opening its `RenderModal` over the checked rows
 * it is eligible for; and a clear button emptying the run. Deselecting takes
 * out every row of this page, one no bulk action takes included.
 *
 * @param {Object}                        props
 * @param {Object[]}                      props.items             The page's items.
 * @param {Object[]}                      props.actions           DataViews actions.
 * @param {(item: Object) => string}      props.getItemId         An item's key.
 * @param {string[]}                      props.selection         The run.
 * @param {(selection: string[]) => void} props.onChangeSelection Takes the run changed.
 * @param {number}                        props.totalItems        The items on every page.
 * @return {import('react').ReactElement} The toolbar.
 */
function RunToolbar( {
	items,
	actions,
	getItemId,
	selection,
	onChangeSelection,
	totalItems,
} ) {
	const [ busy, setBusy ] = useState( null );
	const [ open, setOpen ] = useState( null );
	const narrow = useNarrow();
	const bulk = actions.filter( ( action ) => action.supportsBulk );
	const page = items.filter( ( item ) =>
		bulk.some( ( action ) => fits( action, item ) )
	);
	const run = new Set( selection );
	const here = new Set( items.map( getItemId ) );
	const checked = page.filter( ( item ) => run.has( getItemId( item ) ) );
	const whole = 0 < page.length && checked.length === page.length;
	const elsewhere = selection.filter( ( id ) => ! here.has( id ) );
	const act = async ( action ) => {
		if ( action.RenderModal ) {
			setOpen( action.id );
			return;
		}
		setBusy( action.id );
		try {
			await action.callback( checked );
		} finally {
			setBusy( null );
		}
	};
	const opened = bulk.find( ( action ) => action.id === open );
	return (
		<div className="dataviews-bulk-actions-footer__container newspack-nodes-dataviews__run-toolbar">
			{ 0 < page.length && (
				<CheckboxControl
					className="dataviews-view-table-selection-checkbox"
					checked={ whole }
					indeterminate={ ! whole && 0 < checked.length }
					onChange={ () =>
						onChangeSelection(
							whole
								? elsewhere
								: [
										...selection,
										...page
											.map( getItemId )
											.filter(
												( id ) => ! run.has( id )
											),
								  ]
						)
					}
					aria-label={
						whole
							? __( 'Deselect all', 'newspack-nodes' )
							: __( 'Select all', 'newspack-nodes' )
					}
				/>
			) }
			<span className="dataviews-bulk-actions-footer__item-count">
				{ runCount(
					selection.length,
					selection.length - elsewhere.length,
					items.length,
					totalItems
				) }
			</span>
			<div className="dataviews-bulk-actions-footer__action-buttons newspack-nodes-dataviews__run-actions">
				{ bulk.map( ( action ) => {
					const rows = checked.filter( ( item ) =>
						fits( action, item )
					);
					if ( 0 === rows.length ) {
						return null;
					}
					const label =
						'string' === typeof action.label
							? action.label
							: action.label( rows );
					const iconOnly = narrow && action.icon;
					return (
						<Button
							key={ action.id }
							size="compact"
							disabled={ busy === action.id }
							accessibleWhenDisabled
							isBusy={ busy === action.id }
							icon={ iconOnly ? action.icon : undefined }
							label={ iconOnly ? label : undefined }
							onClick={ () => act( action ) }
						>
							{ iconOnly ? null : label }
						</Button>
					);
				} ) }
				{ 0 < selection.length && (
					<Button
						size="compact"
						icon={ <CloseIcon small /> }
						label={ __( 'Clear selection', 'newspack-nodes' ) }
						showTooltip
						tooltipPosition="top"
						disabled={ null !== busy }
						onClick={ () => onChangeSelection( [] ) }
					/>
				) }
			</div>
			{ opened && (
				<RunModal
					action={ opened }
					rows={ checked.filter( ( item ) => fits( opened, item ) ) }
					close={ () => setOpen( null ) }
				/>
			) }
		</div>
	);
}

/**
 * A bulk action's own modal over the checked rows it is eligible for, framed
 * as DataViews frames one: headed `modalHeader`, else the action's label.
 *
 * @param {Object}     props
 * @param {Object}     props.action The action, carrying `RenderModal`.
 * @param {Object[]}   props.rows   The checked rows it is eligible for.
 * @param {() => void} props.close  Shuts the modal.
 * @return {import('react').ReactElement} The modal.
 */
function RunModal( { action, rows, close } ) {
	const label =
		'string' === typeof action.label ? action.label : action.label( rows );
	const header =
		'function' === typeof action.modalHeader
			? action.modalHeader( rows )
			: action.modalHeader;
	return (
		<Modal
			title={ header || label }
			__experimentalHideHeader={ !! action.hideModalHeader }
			onRequestClose={ close }
			focusOnMount={ action.modalFocusOnMount ?? true }
			size={ action.modalSize || 'medium' }
			overlayClassName="dataviews-action-modal"
		>
			<action.RenderModal items={ rows } closeModal={ close } />
		</Modal>
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
 * Given `selectLabel`, the list owns the run and DataViews holds no part of
 * it: DataViews is handed an empty selection and a no-op in its place, so no
 * DataViews control changes the run, and no row reads as pressed or is
 * scrolled to. Each row draws a checkbox named `selectLabel( item )` that adds
 * it to `selection` or takes it out, through `onChangeSelection`. A toolbar of
 * the list's own stands above it, in DataViews' bulk-footer classes: a
 * checkbox adding this page's bulk-eligible rows to the run or taking them out,
 * every key from another page kept; the run's count; a button per bulk action
 * some checked row on this page is eligible for, handed every checked row of
 * this page a bulk action takes; and a clear button emptying the run. Those are
 * the only controls that change the run, so a click on a row's body leaves it
 * alone. The list carries `newspack-nodes-dataviews__run-only`, which hides the
 * action cells and the selection checkboxes DataViews draws in each row.
 * `selectLabel` without `selection` and `onChangeSelection` throws.
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
					selection={ selectLabel ? NO_SELECTION : selection }
					onChangeSelection={
						selectLabel ? keepRun : onChangeSelection
					}
					{ ...rest }
				>
					{ header }
					{ selectLabel && (
						<RunToolbar
							items={ items }
							actions={ actions }
							getItemId={ getItemId }
							selection={ selection }
							onChangeSelection={ onChangeSelection }
							totalItems={ paginationInfo.totalItems }
						/>
					) }
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
