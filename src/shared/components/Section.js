/**
 * The one header a composed page's sections stand under, and one block's
 * part of a composed page's one surface: a region named and headed by its
 * heading, with any control the block keeps beside it.
 */

import { forwardRef, useId } from '@wordpress/element';

/**
 * A row in the shared section-heading role, which rules it: a title, a
 * muted line under it, and the actions at the end of the line. A caller
 * that focuses the heading hands it a ref, and only then does the heading
 * take `tabIndex` -1.
 *
 * @param {Object}                                  props
 * @param {string}                                  props.title         The heading, plain text.
 * @param {string}                                  [props.description] One muted line under it.
 * @param {import('react').ReactNode}               [props.actions]     Controls at the end of the line.
 * @param {string}                                  [props.id]          The heading's id, which names a region.
 * @param {import('react').Ref<HTMLHeadingElement>} ref                 The heading, for a caller that focuses it.
 * @return {import('react').ReactElement} The header.
 */
function SectionHeaderOf( { title, description, actions, id }, ref ) {
	return (
		<div className="newspack-nodes-composed-section-head newspack-nodes-section-heading">
			<div>
				<h2 ref={ ref } id={ id } tabIndex={ ref ? -1 : undefined }>
					{ title }
				</h2>
				{ description && (
					<p className="newspack-nodes-status is-muted">
						{ description }
					</p>
				) }
			</div>
			{ actions && (
				<div className="newspack-nodes-composed-section-actions">
					{ actions }
				</div>
			) }
		</div>
	);
}

export const SectionHeader = forwardRef( SectionHeaderOf );

/**
 * A region named by its `SectionHeader`, which heads its body.
 *
 * @param {Object}                                  props
 * @param {string}                                  props.heading       The heading, plain text.
 * @param {string}                                  [props.description] One muted line under it.
 * @param {import('react').ReactNode}               [props.actions]     Controls at the end of the line.
 * @param {string}                                  [props.className]   A class beside the section's own.
 * @param {import('react').ReactNode}               props.children      The body.
 * @param {import('react').Ref<HTMLHeadingElement>} ref                 The heading, for a caller that focuses it.
 * @return {import('react').ReactElement} The section.
 */
function SectionOf(
	{ heading, description, actions, className = '', children },
	ref
) {
	const id = useId();
	return (
		<section
			className={ `newspack-nodes-composed-section ${ className }`.trim() }
			aria-labelledby={ id }
		>
			<SectionHeader
				ref={ ref }
				id={ id }
				title={ heading }
				description={ description }
				actions={ actions }
			/>
			{ children }
		</section>
	);
}

export default forwardRef( SectionOf );
