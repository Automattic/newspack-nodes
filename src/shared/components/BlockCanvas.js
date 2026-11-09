/**
 * One block-editor canvas on a plain admin page: the provider stack that
 * edits a block list, with its popovers anchored inside it.
 *
 * The page boots the editor first through
 * `Newspack_Nodes\Block_Editor_Bootstrap::load_canvas()`, which enqueues
 * `wp-block-editor` and seeds `wp.blocks` for the page's editor context.
 * Children render inside the provider, beside the list, so a
 * `BlockInspector` or a toolbar placed there reads the same editor store.
 */

import {
	BlockEditorProvider,
	BlockList,
	BlockTools,
	WritingFlow,
	ObserveTyping,
} from '@wordpress/block-editor';
import { SlotFillProvider, Popover } from '@wordpress/components';

// One object for every render, so the provider never sees settings change.
const NO_SETTINGS = Object.freeze( {} );

/**
 * @param {Object}                    props
 * @param {Object[]}                  props.blocks      The block list edited.
 * @param {Function}                  props.onInput     Takes each transient edit's block list.
 * @param {Function}                  props.onChange    Takes each committed edit's block list.
 * @param {Object}                    [props.settings]  The block-editor settings, `allowedBlockTypes` among them;
 *                                                      none hands the provider one frozen empty object.
 * @param {Object}                    [props.selection] `{ selectionStart, selectionEnd }`, each `{ clientId }`, which the
 *                                                      provider applies when it next takes `blocks` from outside.
 * @param {import('react').ReactNode} [props.children]  Rendered inside the provider, beside the list.
 * @return {import('react').ReactElement} The canvas.
 */
export default function BlockCanvas( {
	blocks,
	onInput,
	onChange,
	settings = NO_SETTINGS,
	selection,
	children,
} ) {
	return (
		<SlotFillProvider>
			<BlockEditorProvider
				value={ blocks }
				onInput={ onInput }
				onChange={ onChange }
				settings={ settings }
				selection={ selection }
			>
				<BlockTools>
					<WritingFlow>
						<ObserveTyping>
							<BlockList />
						</ObserveTyping>
					</WritingFlow>
				</BlockTools>
				{ children }
				<Popover.Slot />
			</BlockEditorProvider>
		</SlotFillProvider>
	);
}
