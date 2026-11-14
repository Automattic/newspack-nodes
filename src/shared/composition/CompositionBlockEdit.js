/**
 * CompositionBlockEdit — one block in the layout editor: its View rendered
 * live with `editing: true`, so the View disables every write control it
 * holds, its Controls in the block inspector, handed its attribute schemas,
 * and a container's children through `InnerBlocks`.
 *
 * A block preview, which core renders as a second, `Disabled` block list in
 * its own iframe, shows the wrapper and a container's children alone: the
 * View's live reads carry node names unique to the page, so a second View
 * would collide with the first.
 *
 * The editor half of the composition layer: it imports
 * `@wordpress/block-editor`, so only the editor's own bundle carries it.
 */

import {
	InnerBlocks,
	InspectorControls,
	useBlockProps,
} from '@wordpress/block-editor';
import { Disabled } from '@wordpress/components';
import { useContext } from '@wordpress/element';

/**
 * @param {Object}                                           props
 * @param {Object}                                           props.attributes      The block's attributes.
 * @param {(next: Object) => void}                           props.setAttributes   Writes attributes.
 * @param {import('./CompositionView').CompositionBlockView} props.view            The block's View and Controls.
 * @param {string[]}                                         [props.allowedBlocks] What a container admits; absent for any other block.
 * @param {Object<string,Object>}                            [props.schema]        Each attribute's declared schema, which the Controls read.
 * @return {import('react').ReactElement} The block as the editor shows it.
 */
export default function CompositionBlockEdit( {
	attributes,
	setAttributes,
	view: { View, Controls },
	allowedBlocks,
	schema,
} ) {
	const blockProps = useBlockProps();
	const previewing = useContext( Disabled.Context );
	const inner = allowedBlocks && (
		<InnerBlocks allowedBlocks={ allowedBlocks } />
	);
	if ( previewing ) {
		return <div { ...blockProps }>{ inner }</div>;
	}
	return (
		<div { ...blockProps }>
			{ Controls && (
				<InspectorControls>
					<Controls
						attributes={ attributes }
						setAttributes={ setAttributes }
						schema={ schema }
					/>
				</InspectorControls>
			) }
			<View attributes={ attributes } editing>
				{ inner }
			</View>
		</div>
	);
}
