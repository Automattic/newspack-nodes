/**
 * The sparkline block: one field of its source's model, a series of numbers
 * oldest first, null where unmeasured, drawn as a `Sparkline` named by the
 * field's declared label, under the block's title.
 */

import Sparkline from '../components/Sparkline';
import { sourceBlock } from './sourceBlock';
import './sparkline.scss';

/** The line's box width, in pixels. */
const WIDTH = 160;

/** The line's box height, in pixels. */
const HEIGHT = 36;

/**
 * The block, drawing the line it names, the source's first when it names nothing.
 *
 * @param {Object}                               props
 * @param {Object}                               props.attributes `{ source, field, title }`.
 * @param {Object}                               props.model      The source's model.
 * @param {import('./sourceBlock').BlockField[]} props.fields     The line, first.
 * @return {import('react').ReactElement} The line under its title.
 */
function SparklineBlock( { attributes, model, fields: [ line ] } ) {
	const { title } = attributes;
	return (
		<figure className="newspack-nodes-sparkline-block">
			{ title && (
				<figcaption className="newspack-nodes-stat-label">
					{ title }
				</figcaption>
			) }
			<Sparkline
				values={ model[ line.key ] ?? [] }
				width={ WIDTH }
				height={ HEIGHT }
				label={ line.label }
			/>
		</figure>
	);
}

export default sourceBlock( SparklineBlock, {
	kind: 'line',
	list: 'field',
	settings: [ 'title' ],
} );
