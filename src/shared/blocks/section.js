/**
 * The section block: a container heading the blocks it holds with its title
 * and description, through the shared `Section`. Untitled, it holds them
 * with no heading. Its inspector edits both.
 */

import Section from '../components/Section';
import { SettingControls } from './sourceBlock';

/**
 * @param {Object}                    props
 * @param {Object}                    props.attributes `{ title, description }`.
 * @param {import('react').ReactNode} [props.children] Its blocks, rendered.
 * @return {import('react').ReactNode} The section.
 */
function View( { attributes, children } ) {
	const { title, description } = attributes;
	return title ? (
		<Section heading={ title } description={ description || undefined }>
			{ children }
		</Section>
	) : (
		children
	);
}

/**
 * @param {Object}                 props
 * @param {Object}                 props.attributes    `{ title, description }`.
 * @param {(next: Object) => void} props.setAttributes Writes them.
 * @param {Object<string,Object>}  props.schema        Each attribute's declared schema.
 * @return {import('react').ReactElement} The controls.
 */
function Controls( { attributes, setAttributes, schema } ) {
	return (
		<SettingControls
			names={ [ 'title', 'description' ] }
			attributes={ attributes }
			setAttributes={ setAttributes }
			schema={ schema }
		/>
	);
}

export default { View, Controls };
