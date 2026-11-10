/** The `close` glyph's path. */
const CLOSE =
	'M13 11.8l6.1-6.3-1-1-6.1 6.2-6.1-6.2-1 1 6.1 6.3-6.5 6.7 1 1 6.5-6.6 6.5 6.6 1-1z';

/** The `closeSmall` glyph's path. */
const CLOSE_SMALL =
	'M12 13.06l3.712 3.713 1.061-1.06L13.061 12l3.712-3.712-1.06-1.06L12 10.938 8.288 7.227l-1.061 1.06L10.939 12l-3.712 3.712 1.06 1.061L12 13.061z';

/**
 * The `close` glyph of `@wordpress/icons`, or its `closeSmall` twin, inlined
 * because newspack-nodes does not depend on that package: a 24 × 24 path
 * filled with the text colour, hidden from assistive technology, since the
 * button carrying it names itself.
 *
 * @param {Object}  props
 * @param {boolean} [props.small] Draw `closeSmall`, the glyph DataViews' bulk
 *                                toolbar clears a selection with.
 * @return {import('react').ReactElement} The icon.
 */
export default function CloseIcon( { small = false } ) {
	return (
		<svg
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			<path d={ small ? CLOSE_SMALL : CLOSE } />
		</svg>
	);
}
