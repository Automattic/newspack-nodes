/**
 * Class list for a confirm/primary button.
 *
 * A disabled button must NOT carry `button-primary`. WordPress core styles
 * `.wp-core-ui .button-primary:disabled` with `!important` on background,
 * border-color, and color, so no selector we can write outranks it — under a
 * dark skin that forces a bright #e2e2e2 block that out-glows every enabled
 * control in the dialog. Dropping the class lets the button style as an
 * ordinary disabled `.button`, which core leaves to us.
 *
 * @param {boolean} disabled Whether the button is disabled.
 * @param {string}  extra    Additional classes (e.g. `is-danger`).
 * @return {string} The className.
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
