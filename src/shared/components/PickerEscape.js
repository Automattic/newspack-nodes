/**
 * Whether a key press belongs to an input method still composing text, which
 * takes its own Enter, Escape and Backspace.
 *
 * @param {import('react').KeyboardEvent} event The key press.
 * @return {boolean} Whether it does.
 */
export const composing = ( event ) =>
	event.nativeEvent.isComposing || 229 === event.keyCode;

/**
 * The picker it wraps, with an Escape pressed while the picker's list is
 * closed handed on to `onEscape`. A stock combobox or token field takes
 * every Escape, so the dialog around it never hears one; this hears it
 * before the picker does, and passes on only an Escape the list does not
 * need, read off the picker's input as `aria-expanded="false"`.
 *
 * @param {Object}                    props
 * @param {() => void}                [props.onEscape] Takes Escape while the list is closed.
 * @param {import('react').ReactNode} props.children   The picker.
 * @return {import('react').ReactElement} The picker.
 */
export default function PickerEscape( { onEscape, children } ) {
	return (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the picker inside takes the keys; this only listens.
		<div
			onKeyDownCapture={ ( event ) => {
				const input = event.currentTarget.querySelector( 'input' );
				if (
					'Escape' === event.key &&
					! composing( event ) &&
					'false' === input?.getAttribute( 'aria-expanded' )
				) {
					onEscape?.();
				}
			} }
		>
			{ children }
		</div>
	);
}
