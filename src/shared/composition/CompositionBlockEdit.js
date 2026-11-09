/**
 * CompositionBlockEdit — one block in the layout editor: its View rendered
 * live with `editing: true`, so the View disables every write control it
 * holds, its Controls in the block inspector, and a container's children
 * through `InnerBlocks`.
 *
 * The editor half of the composition layer: it imports
 * `@wordpress/block-editor`, so only the editor's own bundle carries it.
 */

import {
	InnerBlocks,
	InspectorControls,
	useBlockProps,
} from '@wordpress/block-editor';

/**
 * @param {Object}                                           props
 * @param {Object}                                           props.attributes      The block's attributes.
 * @param {(next: Object) => void}                           props.setAttributes   Writes attributes.
 * @param {import('./CompositionView').CompositionBlockView} props.view            The block's View and Controls.
 * @param {string[]}                                         [props.allowedBlocks] What a container admits; absent for any other block.
 * @return {import('react').ReactElement} The block as the editor shows it.
 */
export default function CompositionBlockEdit( {
	attributes,
	setAttributes,
	view: { View, Controls },
	allowedBlocks,
} ) {
	return (
		<div { ...useBlockProps() }>
			{ Controls && (
				<InspectorControls>
					<Controls
						attributes={ attributes }
						setAttributes={ setAttributes }
					/>
				</InspectorControls>
			) }
			<View attributes={ attributes } editing>
				{ allowedBlocks && (
					<InnerBlocks allowedBlocks={ allowedBlocks } />
				) }
			</View>
		</div>
	);
}
