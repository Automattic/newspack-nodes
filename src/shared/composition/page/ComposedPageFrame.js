/**
 * ComposedPageFrame — a composed page's frame: the page's controls in its
 * header beside a ⋯ menu offering **Edit layout** to a `tune` reader, its
 * chrome, and the layout its context reads, all under one
 * `PageStateProvider` and one `SourcesProvider`, so the chrome, the controls
 * and every block share each source's one fetch. On a load whose `edit`
 * names the page, for a `tune` reader, the context's editor takes the
 * layout's place, and its answer is the layout the page reads next; a page
 * left mid-edit drops the edit. While the editor holds a change, an in-page
 * leave a `guardLeave` answers asks first, through the shared `Confirm`; a
 * page leave the editor guards itself.
 *
 * A consumer's bundle renders this with its own views, so the providers and
 * the blocks come from that one bundle.
 */

import { DropdownMenu } from '@wordpress/components';
import { useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import CompositionEditSlot from '../CompositionEditSlot';
import { SourcesProvider } from '../../sources';
import { HeaderSlot } from '../../components/HeaderSlot';
import { Confirm } from '../../components/Modal';
import ComposedLayout from './ComposedLayout';
import { editLayoutControl, editTarget, leaveEdit } from './editMode';
import { PageStateProvider } from './pageState';

/** The edit slot, which hands every prop past `context` to the editor. */
const EditSlot = /** @type {import('react').ComponentType<Object>} */ (
	CompositionEditSlot
);

/**
 * A leave the frame was asked about: `leave()` goes ahead with it.
 *
 * @typedef {{leave: () => void}} FrameLeave
 */

/**
 * @param {Object}                                                           props
 * @param {string}                                                           props.context              The context the page lays out.
 * @param {string}                                                           props.page                 Its key in `pages`, which `?edit=` names.
 * @param {import('./editMode').ComposedPages}                               props.pages                The consumer's composed pages.
 * @param {string}                                                           props.group                The surface the page's commands are sent for.
 * @param {boolean}                                                          props.canTune              Whether the reader may curate.
 * @param {boolean}                                                          props.canManage            Whether the reader is an operator.
 * @param {Object}                                                           props.layout               The layout or refusal the page read.
 * @param {Object<string,import('../CompositionView').CompositionBlockView>} props.views                Every block's view.
 * @param {Object}                                                           [props.standing]           What the page's blocks stand on beside the frame's own `group`, `canTune`, `operator` and `onRestored`.
 * @param {?Element}                                                         [props.headerControlsSlot] The header's slot; null withholds the controls, undefined renders them inline.
 * @param {import('react').ReactNode}                                        [props.controls]           The page's own header controls.
 * @param {import('react').ReactNode}                                        [props.children]           The chrome above the layout.
 * @param {(guard: (next: FrameLeave) => boolean) => () => void}             [props.guardLeave]         Registers the answer an in-page leave, a tab switch, asks while the editor holds a change; answers its release.
 * @return {import('react').ReactElement} The page.
 */
export default function ComposedPageFrame( {
	context,
	page,
	pages,
	group,
	canTune,
	canManage,
	layout: read,
	views,
	standing = {},
	headerControlsSlot,
	controls = null,
	children = null,
	guardLeave = null,
} ) {
	const [ layout, setLayout ] = useState( read );
	const [ editing, setEditing ] = useState(
		() =>
			canTune &&
			page === editTarget( window.location.search, pages )?.page
	);
	const [ dirty, setDirty ] = useState( false );
	const [ leaving, setLeaving ] = useState(
		/** @type {?FrameLeave} */ ( null )
	);
	useEffect( () => {
		if ( editing ) {
			return () => leaveEdit( pages );
		}
	}, [ editing, pages ] );
	useEffect( () => {
		if ( editing && dirty && guardLeave ) {
			return guardLeave( ( next ) => {
				setLeaving( next );
				return false;
			} );
		}
	}, [ editing, dirty, guardLeave ] );
	const done = ( answer ) => {
		if ( answer ) {
			setLayout( answer );
		}
		setDirty( false );
		setEditing( false );
		leaveEdit( pages );
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
								editLayoutControl( { page }, pages ),
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
							page={ {
								...standing,
								group,
								canTune,
								operator: canManage,
								onRestored: setLayout,
							} }
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
