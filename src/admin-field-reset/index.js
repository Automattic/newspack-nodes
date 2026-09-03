/**
 * Per-field reset toggle for the settings forms built on `Config_System`.
 *
 * A resettable field is a wrapper `[data-nn-reset="<mark name>"]` holding its
 * control or controls and a `[data-nn-reset-toggle]` button. The wrapper's
 * value is the exact hidden-input name a Save must post, so no plugin's option
 * prefix is compiled in here: newspack-nodes builds this module once and every
 * settings admin offering per-field reset — nodes, event-logger-nodes,
 * pyrobase — enqueues that one bundle by URL through `Field_Reset_Assets`.
 *
 * Arming the toggle snapshots the controls, clears them, highlights the wrapper
 * and injects the hidden marker. Disarming restores the snapshot and drops both
 * the highlight and the marker. Editing a marked control drops the mark and
 * keeps the edit, because an operator typing a value is setting it rather than
 * resetting it.
 *
 * The browser decides nothing. The marker's PRESENCE in the POST is what tells
 * `Reset_Gate` to delete the option row, and deleting the row is how the
 * default declared in code wins again (ADR-20). Clearing the control previews
 * that outcome and nothing more.
 *
 * Importing the module wires the whole document, waiting for
 * `DOMContentLoaded` while the page is still parsing.
 */

/**
 * Wrapper class marking a field whose option Save will delete.
 *
 * `Field_Reset_Assets::highlight_style()` paints the toggle red under this
 * class, so the name is a contract with that PHP string, not a local detail.
 */
const MARKED = 'is-marked';

/**
 * One submittable control inside a resettable field.
 *
 * `controlsOf()` casts to this union because a selector string is opaque to the
 * type checker. `checked` belongs to the input alone, so every read of it
 * stands behind `isToggleState()`.
 *
 * @typedef {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} Control
 */

/**
 * Does this control carry its state in `checked` rather than `value`?
 *
 * Answering true narrows the control to an `input`, the one element carrying
 * `checked`.
 *
 * @param {Control} control One submittable control.
 * @return {control is HTMLInputElement} True for a checkbox or a radio.
 */
const isToggleState = ( control ) =>
	'checkbox' === control.type || 'radio' === control.type;

/**
 * Capture one control's current state.
 *
 * A snapshot carries `checked` or `value` and never both, so its shape is also
 * the discriminator `restore()` branches on.
 *
 * @param {Control} control Control to snapshot.
 * @return {{checked: boolean}|{value: string}} Its captured state.
 */
const snapshot = ( control ) =>
	isToggleState( control )
		? { checked: control.checked }
		: { value: control.value };

/**
 * Clear a control so the marked field previews the default Save will restore.
 *
 * A toggle reads `data-nn-reset-default`, which `Settings_Renderer::checkbox()`
 * and each consumer's own checkbox markup emit: a box whose default is checked
 * has to preview as checked, or the reset shows the operator the one state they
 * did not ask for. A toggle without the attribute previews unchecked.
 *
 * @param {Control} control Control to clear.
 */
const clear = ( control ) => {
	if ( isToggleState( control ) ) {
		control.checked =
			'1' === control.getAttribute( 'data-nn-reset-default' );
	} else {
		control.value = '';
	}
};

/**
 * Put a control back to what `snapshot()` captured.
 *
 * The branch reads the snapshot's shape rather than re-testing the control, so
 * capture and restore cannot disagree about which field holds the state. Only
 * a checkbox or a radio ever produced a `checked` snapshot, which is what the
 * cast states.
 *
 * @param {Control}                            control Control to restore.
 * @param {{checked: boolean}|{value: string}} snap    Its snapshot.
 */
const restore = ( control, snap ) => {
	if ( 'checked' in snap ) {
		/** @type {HTMLInputElement} */ ( control ).checked = snap.checked;
	} else {
		control.value = snap.value;
	}
};

/**
 * Every submittable control in the wrapper, minus the hidden inputs.
 *
 * Hidden inputs are skipped because each one has to survive a reset untouched:
 * the injected marker itself, the `value="0"` sentinel that lets an unchecked
 * box turn a setting off, and the JSON carrier a React-owned field posts its
 * state through. Marking such a field flags its option for deletion without
 * disturbing the tree that owns it.
 *
 * @param {Element} wrapper A `[data-nn-reset]` wrapper.
 * @return {Control[]} Its visible submittable controls.
 */
const controlsOf = ( wrapper ) =>
	/** @type {Control[]} */ ( [
		...wrapper.querySelectorAll( 'input, textarea, select' ),
	] ).filter( ( el ) => 'hidden' !== el.type );

/**
 * A `[data-nn-reset]` wrapper, carrying the flag `wire()` stamps on it.
 *
 * @typedef {Element & { __nnResetWired?: boolean }} ResetWrapper
 */

/**
 * Bind one wrapper's toggle and its controls.
 *
 * `__nnResetWired` on the element is what makes a second `initFieldReset()`
 * harmless: rebinding would double every listener, so one click would mark and
 * immediately unmark. The control list is captured once here, so replacing the
 * controls inside an already-wired wrapper leaves them unbound. Re-render the
 * wrapper itself and the next call wires it cleanly.
 *
 * A wrapper missing its toggle or its mark name is left alone rather than
 * half-wired. The mark name is the hidden input's name, and there is no reset
 * to offer without it.
 *
 * @param {ResetWrapper} wrapper A `[data-nn-reset]` wrapper.
 */
function wire( wrapper ) {
	if ( wrapper.__nnResetWired ) {
		return;
	}
	const markerName = wrapper.getAttribute( 'data-nn-reset' );
	const toggle = wrapper.querySelector( '[data-nn-reset-toggle]' );
	if ( ! toggle || ! markerName ) {
		return;
	}
	wrapper.__nnResetWired = true;

	const controls = controlsOf( wrapper );
	let snaps = null; // non-null exactly while marked

	/**
	 * Arm the reset: snapshot, clear, highlight, inject the marker.
	 *
	 * The marker carries `data-nn-reset-marker` so `unmark()` can find its own
	 * input again without disturbing a hidden input the field already had.
	 */
	const mark = () => {
		snaps = controls.map( snapshot );
		controls.forEach( clear );
		wrapper.classList.add( MARKED );
		const hidden = document.createElement( 'input' );
		hidden.type = 'hidden';
		hidden.name = markerName;
		hidden.value = '1';
		hidden.setAttribute( 'data-nn-reset-marker', '' );
		wrapper.appendChild( hidden );
	};

	/**
	 * Disarm the reset, restoring the snapshot only when asked.
	 *
	 * Toggling off means "never mind", so it restores. An edit means the
	 * operator is supplying a value, so it keeps what they typed.
	 *
	 * @param {boolean} withRestore Whether to put the snapshot back.
	 */
	const unmark = ( withRestore ) => {
		if ( withRestore ) {
			controls.forEach( ( control, i ) =>
				restore( control, snaps[ i ] )
			);
		}
		snaps = null;
		wrapper.classList.remove( MARKED );
		wrapper.querySelector( '[data-nn-reset-marker]' )?.remove();
	};

	toggle.addEventListener( 'click', () =>
		snaps ? unmark( true ) : mark()
	);
	/** Drop the mark on an edit, keeping the value the operator entered. */
	const dropMarkOnEdit = () => snaps && unmark( false );
	controls.forEach( ( control ) => {
		control.addEventListener( 'input', dropMarkOnEdit );
		control.addEventListener( 'change', dropMarkOnEdit );
	} );
}

/**
 * Wire every reset-capable field found under `root`.
 *
 * Idempotent: a wrapper already wired is skipped, so this is safe to call
 * again after part of the settings form is re-rendered.
 *
 * @param {Document|Element} root Subtree to scan for `[data-nn-reset]`
 *                                wrappers. Defaults to the whole document.
 */
export function initFieldReset( root = document ) {
	root.querySelectorAll( '[data-nn-reset]' ).forEach( wire );
}

if ( 'undefined' !== typeof document ) {
	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', () => initFieldReset() );
	} else {
		initFieldReset();
	}
}
