/**
 * The `close` glyph of `@wordpress/icons`, inlined because newspack-nodes
 * does not depend on that package: a 24 × 24 path filled with the text
 * colour, hidden from assistive technology, since the button carrying it
 * names itself.
 *
 * @return {import('react').ReactElement} The icon.
 */
export default function CloseIcon() {
	return (
		<svg
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M13 11.8l6.1-6.3-1-1-6.1 6.2-6.1-6.2-1 1 6.1 6.3-6.5 6.7 1 1 6.5-6.6 6.5 6.6 1-1z" />
		</svg>
	);
}
