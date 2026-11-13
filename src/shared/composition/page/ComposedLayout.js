/**
 * A composed page's layout as a reader reads it: each block by its view
 * under the page it stands on, the aside apart so it can stand in a column
 * of its own, and a stored layout that no longer reads as the shared read
 * error in its place, with no Try again, since a read refuses it again; a
 * curator is offered **Restore default**, which asks first. The layout
 * stands under one `PageStateProvider` and one `SourcesProvider`, so its
 * blocks read page state and sources with no provider of the consumer's
 * own, both columns sharing each.
 *
 * The reader half of the composition layer: it imports no block library.
 */

import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import CompositionView from '../CompositionView';
import { useComposition } from '../useComposition';
import { Confirm } from '../../components/Modal';
import { SourcesProvider } from '../../sources';
import Unread from '../../components/Unread';
import AsideView from './AsideView';
import { ComposedPage, providedViews } from './pageContext';
import { PageStateProvider } from './pageState';

/** The one block split into the aside column. */
export const ASIDE = 'newspack-nodes/aside';

/** Read the page again, the one way to read its layouts again. */
const reload = () => window.location.reload();

/**
 * A block that could not render, in its own place.
 *
 * @param {Error} error Why.
 * @return {import('react').ReactElement} The read error.
 */
const unreadBlock = ( error ) => (
	<Unread error={ error.message } refresh={ reload } />
);

/**
 * The way back from a stored layout that no longer reads: the default
 * restored once the curator confirms, as the layout editor restores it.
 *
 * @param {Object}                                    props
 * @param {string}                                    props.context The context refused.
 * @param {import('./pageContext').ComposedPageValue} props.page    The page it stands on.
 * @return {import('react').ReactElement} The line and its control.
 */
function RestoreDefault( { context, page } ) {
	const [ asking, setAsking ] = useState( false );
	const { restore, refusal, writing } = useComposition(
		page.group,
		context,
		( answer ) => page.onRestored( answer )
	);
	return (
		<>
			<p>
				{ __(
					'This layout names a block or a setting this version does not have.',
					'newspack-nodes'
				) }{ ' ' }
				<button
					type="button"
					className="button"
					disabled={ writing }
					onClick={ () => setAsking( true ) }
				>
					{ __( 'Restore default', 'newspack-nodes' ) }
				</button>
			</p>
			{ refusal && (
				<div className="newspack-nodes-error-banner" role="alert">
					{ refusal }
				</div>
			) }
			{ asking && (
				<Confirm
					title={ __(
						'Restore the default layout?',
						'newspack-nodes'
					) }
					body={ __(
						'Everyone who opens this page will see the default.',
						'newspack-nodes'
					) }
					yes={ __( 'Restore default', 'newspack-nodes' ) }
					no={ __( 'Cancel', 'newspack-nodes' ) }
					onYes={ () => {
						setAsking( false );
						restore();
					} }
					onNo={ () => setAsking( false ) }
				/>
			) }
		</>
	);
}

/**
 * @param {Object}                                                                         props
 * @param {import('../useComposition').CompositionAnswer|{context: string, error: string}} props.layout What `Composition_Store::page_data()` answered for the page's context.
 * @param {Object<string,import('../CompositionView').CompositionBlockView>}               props.views  Block name => view, each View handed `editing`. The substrate supplies the aside's view.
 * @param {import('./pageContext').ComposedPageValue}                                      props.page   The page the blocks stand on.
 * @return {?import('react').ReactElement} The layout, or nothing for an empty one.
 */
export default function ComposedLayout( { layout, views, page } ) {
	if ( 'error' in layout ) {
		return (
			<ComposedPage.Provider value={ page }>
				<Unread error={ layout.error } />
				{ page.canTune && (
					<RestoreDefault context={ layout.context } page={ page } />
				) }
			</ComposedPage.Provider>
		);
	}
	if ( 0 === layout.blocks.length ) {
		return null;
	}
	const withAside = {
		...providedViews( views ),
		[ ASIDE ]: { View: AsideView },
	};
	const main = layout.blocks.filter( ( node ) => ASIDE !== node.name );
	const aside = layout.blocks.filter( ( node ) => ASIDE === node.name );
	return (
		<ComposedPage.Provider value={ page }>
			<PageStateProvider>
				<SourcesProvider>
					<div className="newspack-nodes-composed-layout">
						<div className="newspack-nodes-composed-layout-main">
							<CompositionView
								blocks={ main }
								views={ withAside }
								renderError={ unreadBlock }
							/>
						</div>
						<CompositionView
							blocks={ aside }
							views={ withAside }
							renderError={ unreadBlock }
						/>
					</div>
				</SourcesProvider>
			</PageStateProvider>
		</ComposedPage.Provider>
	);
}
