/**
 * CompositionView — a layout's tree rendered read-only, each node by the View
 * its block name registers.
 *
 * Every node renders inside a boundary of its own, so a View that throws, or a
 * name that has no view, costs that node's place and leaves its siblings
 * standing. A container's View receives its children already rendered.
 *
 * This is the reader half of the composition layer: it imports neither
 * `@wordpress/block-editor` nor `@wordpress/blocks`, so a reader's page loads
 * no editor script.
 */

import { Component } from '@wordpress/element';

/**
 * One node of the tree `compositions get` answers.
 *
 * @typedef {Object} CompositionNode
 * @property {string}            name       The block name.
 * @property {Object}            attributes Its attributes, laid over their defaults.
 * @property {CompositionNode[]} inner      A container's children; empty otherwise.
 */

/**
 * What a block registers: the View a page renders and, for the editor, the
 * Controls its inspector holds.
 *
 * @typedef {Object} CompositionBlockView
 * @property {import('react').ComponentType<{attributes: Object, editing: boolean, children?: import('react').ReactNode}>}                View       The block's rendering.
 * @property {import('react').ComponentType<{attributes: Object, setAttributes: (next: Object) => void, schema?: Object<string,Object>}>} [Controls] Its inspector controls, handed each attribute's declared schema.
 */

/**
 * Renders `renderError( error )` in place of a node whose View throws, until
 * the boundary is handed another node.
 */
class NodeBoundary extends Component {
	/**
	 * @param {Object} props The boundary's props.
	 */
	constructor( props ) {
		super( props );
		this.state = { node: props.node, error: null };
	}

	/**
	 * A new node object is a new chance to render.
	 *
	 * @param {Object} props The boundary's props.
	 * @param {Object} state Its state.
	 * @return {?Object} The reset state, or null to keep it.
	 */
	static getDerivedStateFromProps( props, state ) {
		return props.node === state.node
			? null
			: { node: props.node, error: null };
	}

	/**
	 * @param {Error} error What the View threw.
	 * @return {Object} The state that renders it.
	 */
	static getDerivedStateFromError( error ) {
		return { error };
	}

	/**
	 * @return {import('react').ReactNode} The node, or the refusal in its place.
	 */
	render() {
		return this.state.error
			? this.props.renderError( this.state.error )
			: this.props.children;
	}
}

/**
 * One node, by its View, its children rendered for a container.
 *
 * @param {Object}                                      props
 * @param {CompositionNode}                             props.node        The node.
 * @param {Object<string,CompositionBlockView>}         props.views       Block name => view.
 * @param {(error: Error) => import('react').ReactNode} props.renderError Renders a refusal.
 * @return {import('react').ReactNode} The rendered node.
 */
function CompositionNodeView( { node, views, renderError } ) {
	if ( ! Object.hasOwn( views, node.name ) ) {
		return renderError( new Error( `${ node.name } has no view` ) );
	}
	const { View } = views[ node.name ];
	return (
		<View attributes={ node.attributes } editing={ false }>
			<CompositionView
				blocks={ node.inner }
				views={ views }
				renderError={ renderError }
			/>
		</View>
	);
}

/**
 * Renders a layout's tree.
 *
 * @param {Object}                                      props
 * @param {CompositionNode[]}                           props.blocks      The tree `compositions get` answered.
 * @param {Object<string,CompositionBlockView>}         props.views       Block name => view.
 * @param {(error: Error) => import('react').ReactNode} props.renderError Renders a node that could not render.
 * @return {import('react').ReactNode} The layout.
 */
export default function CompositionView( { blocks, views, renderError } ) {
	return blocks.map( ( node, index ) => (
		<NodeBoundary
			key={ `${ index }:${ node.name }` }
			node={ node }
			renderError={ renderError }
		>
			<CompositionNodeView
				node={ node }
				views={ views }
				renderError={ renderError }
			/>
		</NodeBoundary>
	) );
}
