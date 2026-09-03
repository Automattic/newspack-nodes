/**
 * buttonClass — the one place a confirm button's class list is composed.
 *
 * `src/shared/styles/__tests__/styleOwnership.test.js` requires every native
 * `<button>` under `src/` to carry a canonical button class, and accepts a
 * className that calls this helper as satisfying that. Composing the list
 * here keeps the disabled-state rule in one file rather than in each dialog
 * that happens to remember it.
 */

/**
 * Class list for a confirm/primary button.
 *
 * A disabled button must NOT carry `button-primary`. WordPress core styles
 * `.wp-core-ui .button-primary:disabled` with `!important` on background,
 * border-color and color, so no selector we can write outranks it, and what
 * it paints is a #e2e2e2 slab that out-glows every enabled control in the
 * dialog under a dark skin. Core's plain disabled `.button` rule forces
 * `background: transparent` instead, letting the panel behind show through,
 * so the button roles' 0.5 opacity is what reads as disabled.
 *
 * @param {boolean} disabled Whether the button is disabled.
 * @param {string}  extra    Additional classes, such as `is-danger`.
 * @return {string} The space-joined class list.
 */
export function primaryButtonClass( disabled = false, extra = '' ) {
	const classes = [ 'button' ];
	if ( ! disabled ) {
		classes.push( 'button-primary' );
	}
	if ( extra ) {
		classes.push( extra );
	}
	return classes.join( ' ' );
}
