/**
 * StationLayout — one station tab as a composed page: the tab's controls in
 * the station header beside a ⋯ menu offering **Edit layout** to a `tune`
 * reader, its chrome, and the layout its context reads, all under one
 * `PageStateProvider` and one `SourcesProvider`, so the chrome, the
 * controls and every block share each source's one fetch. On a load whose
 * `edit` names this page, for a `tune` reader, the context's editor takes
 * the layout's place, and its answer is the layout the tab reads next; a
 * tab left mid-edit drops the edit, so the next one reads its layout. While
 * the editor holds a change, a tab switch asks first through `Confirm`.
 *
 * Each tab's bundle renders this with its own views, so the providers and
 * the blocks come from that one bundle.
 */

import { DropdownMenu } from '@wordpress/components';
import { useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import CompositionEditSlot from '@newspack-nodes/shared/composition/CompositionEditSlot';
import {
	ComposedLayout,
	editLayoutControl,
	editTarget,
	leaveEdit,
} from '@newspack-nodes/shared/composition/page';
import { PageStateProvider } from '@newspack-nodes/shared/composition/page/pageState';
import { SourcesProvider } from '@newspack-nodes/shared/sources';
import { HeaderSlot } from '@newspack-nodes/shared/components/HeaderSlot';
import { Confirm } from '@newspack-nodes/shared/components/Modal';
import { guardLeave } from './leaveGuard';
import {
	STATION_GROUP,
	STATION_PAGES,
	stationContext,
	stationPages,
} from './stationPages';

/** The edit slot, which hands every prop past `context` to the editor. */
const EditSlot = /** @type {import('react').ComponentType<Object>} */ (
	CompositionEditSlot
);

/**
 * @param {Object}                                                                                           props
 * @param {string}                                                                                           props.page                 A STATION_PAGES key.
 * @param {Object<string,import('@newspack-nodes/shared/composition/CompositionView').CompositionBlockView>} props.views                Every block's view.
 * @param {?Element}                                                                                         [props.headerControlsSlot] The station header's slot; null withholds the controls, undefined renders them inline.
 * @param {import('react').ReactNode}                                                                        [props.controls]           The tab's own header controls.
 * @param {import('react').ReactNode}                                                                        [props.children]           The chrome above the layout.
 * @return {import('react').ReactElement} The tab.
 */
export default function StationLayout( {
	page,
	views,
	headerControlsSlot,
	controls = null,
	children = null,
} ) {
	const { canTune, canManage, compositions } = stationPages();
	const context = stationContext( page );
	const [ layout, setLayout ] = useState( compositions[ context ] );
	const [ editing, setEditing ] = useState(
		() =>
			canTune &&
			page === editTarget( window.location.search, STATION_PAGES )?.page
	);
	const composed = {
		group: STATION_GROUP,
		canTune,
		operator: canManage,
		onRestored: setLayout,
	};
	const [ dirty, setDirty ] = useState( false );
	const [ leaving, setLeaving ] = useState(
		/** @type {?import('@newspack-nodes/shared/tabs/tabRegistry').TabLeave} */ (
			null
		)
	);
	useEffect( () => {
		if ( editing ) {
			return () => leaveEdit( STATION_PAGES );
		}
	}, [ editing ] );
	useEffect( () => {
		if ( editing && dirty ) {
			return guardLeave( ( next ) => {
				setLeaving( next );
				return false;
			} );
		}
	}, [ editing, dirty ] );
	const done = ( answer ) => {
		if ( answer ) {
			setLayout( answer );
		}
		setDirty( false );
		setEditing( false );
		leaveEdit( STATION_PAGES );
	};
	const discard = () => {
		setLeaving( null );
		leaving.leave();
	};
	return (
		<PageStateProvider>
			<SourcesProvider>
				<HeaderSlot slot={ headerControlsSlot }>
					{ controls }
					{ canTune && (
						<DropdownMenu
							icon="ellipsis"
							label={ __( 'Layout actions', 'newspack-nodes' ) }
							toggleProps={ { size: 'small' } }
							controls={ [
								editLayoutControl( { page }, STATION_PAGES ),
							] }
						/>
					) }
				</HeaderSlot>
				{ editing ? (
					<EditSlot
						context={ context }
						target={ { page } }
						onDirty={ setDirty }
						onDone={ done }
					/>
				) : (
					<>
						{ children }
						<ComposedLayout
							layout={ layout }
							views={ views }
							page={ composed }
						/>
					</>
				) }
				{ leaving && (
					<Confirm
						title={ __(
							'Discard your changes to this layout?',
							'newspack-nodes'
						) }
						yes={ __( 'Discard changes', 'newspack-nodes' ) }
						no={ __( 'Keep editing', 'newspack-nodes' ) }
						onYes={ discard }
						onNo={ () => setLeaving( null ) }
					/>
				) }
			</SourcesProvider>
		</PageStateProvider>
	);
}
