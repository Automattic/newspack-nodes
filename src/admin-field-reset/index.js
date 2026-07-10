/**
 * Per-field reset toggle for the substrate settings form.
 *
 * Each resettable field is a wrapper `[data-nn-reset="<marker name>"]` holding
 * its control(s) and a `[data-nn-reset-toggle]` button. The marker name is the
 * exact hidden-input name to submit (e.g. `newspack_nodes_reset[<option>]`), so
 * this module carries no plugin-specific constant and is copied verbatim across
 * plugins.
 *
 * Toggle on  → snapshot + clear the control(s), highlight (`is-marked`), inject
 *              the hidden marker so Save deletes the option (file default wins).
 * Toggle off → restore the snapshot, drop the highlight + marker.
 * Edit a marked field → drop the mark but keep the edit (presence-based: the
 *              operator is now setting a value, not resetting).
 */

const MARKED = 'is-marked';

const isToggleState = ( control ) =>
	'checkbox' === control.type || 'radio' === control.type;

const snapshot = ( control ) =>
	isToggleState( control )
		? { checked: control.checked }
		: { value: control.value };

// Clearing a marked field previews the file default Save will produce.
const clear = ( control ) => {
	if ( isToggleState( control ) ) {
		control.checked =
			'1' === control.getAttribute( 'data-nn-reset-default' );
	} else {
		control.value = '';
	}
};

const restore = ( control, snap ) => {
	if ( 'checked' in snap ) {
		control.checked = snap.checked;
	} else {
		control.value = snap.value;
	}
};

// Every submittable control in the wrapper except the injected hidden marker.
const controlsOf = ( wrapper ) =>
	[ ...wrapper.querySelectorAll( 'input, textarea, select' ) ].filter(
		( el ) => 'hidden' !== el.type
	);

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
	const dropMarkOnEdit = () => snaps && unmark( false );
	controls.forEach( ( control ) => {
		control.addEventListener( 'input', dropMarkOnEdit );
		control.addEventListener( 'change', dropMarkOnEdit );
	} );
}

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
