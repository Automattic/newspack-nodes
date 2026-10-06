/**
 * The props a dialog's `<form>` takes so Enter in a text field runs the
 * dialog's default action, the same path its submit button's click takes.
 *
 * The handler prevents the navigation and stops the event there: React
 * bubbles a submit through a portal to every form above it in the tree, so a
 * dialog opened from inside another form would otherwise submit that one too.
 * `noValidate` leaves validation to the dialog, whose own refusal names the
 * field, where the browser's bubble would fire first on a `type="url"` or a
 * number's `min`.
 *
 * A field that must keep Enter for itself — a token box committing a draft, a
 * path refusing one — prevents the keydown's default, which is what cancels
 * the implicit submission. A disabled submit button blocks it too.
 *
 * @param {() => void} action The dialog's default action.
 * @return {{noValidate: true, onSubmit: (event: import('react').FormEvent) => void}} The form's props.
 */
export function submitProps( action ) {
	return {
		noValidate: true,
		onSubmit: ( event ) => {
			event.preventDefault();
			event.stopPropagation();
			action();
		},
	};
}
