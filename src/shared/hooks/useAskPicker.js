import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

/** Marks the document while picking; the stylesheet turns the cursor into a `?`. */
export const ASKING_CLASS = 'newspack-nodes-asking';

/** The one attribute. Any element becomes askable by carrying it. */
const ASK_ATTR = 'data-ask';

/**
 * Every `[data-ask]` from $el outward, innermost first. DOM nesting already
 * expresses containment — a span sits inside its request, a row inside its URL
 * — so the chain is what makes the small descriptor vocabulary self-sufficient
 * without a second attribute for scope.
 *
 * @param {Element} el The clicked element.
 * @return {string[]} Descriptors, target first.
 */
function chainFrom( el ) {
	const chain = [];
	let node = el.closest?.( `[${ ASK_ATTR }]` ) ?? null;
	while ( node ) {
		const descriptor = node.getAttribute( ASK_ATTR );
		if ( descriptor && ! chain.includes( descriptor ) ) {
			chain.push( descriptor );
		}
		node = node.parentElement?.closest( `[${ ASK_ATTR }]` ) ?? null;
	}
	return chain;
}

/**
 * The `?` picker: click the Ask button, the cursor becomes a `?`, and the next
 * click asks about whatever you point at.
 *
 * A per-surface "Ask AI" button has to guess what you meant. This inverts it —
 * THE TARGET IS THE SCOPE — so the payload is that thing plus enough context to
 * explain it, and there is no per-surface branching at all: one button, and
 * what you click decides everything.
 *
 * While picking, the target's own handler is suppressed in the CAPTURE phase,
 * for modified and unmodified clicks alike. That matters more than it looks:
 * Cmd/Ctrl-click already MEANS something on exactly these elements — reveal the
 * log entry on a flame span, fold recursively on a log row — so both forms have
 * to be intercepted, and the modifier is re-read on `mousedown` because that is
 * the convention already shipping (macOS treats Control-click as a secondary
 * click, and the mousedown read is the working answer to it).
 *
 * @param {Object}   options
 * @param {Function} options.onPick Called `( descriptors, { additive } )`.
 * @return {{ active: boolean, start: () => void, cancel: () => void }} Picker controls.
 */
export function useAskPicker( { onPick } ) {
	const [ active, setActive ] = useState( false );
	const activeRef = useRef( false );
	const modifierRef = useRef( false );
	const onPickRef = useRef( onPick );
	onPickRef.current = onPick;

	const setPicking = useCallback( ( on ) => {
		activeRef.current = on;
		setActive( on );
		document.body.classList.toggle( ASKING_CLASS, on );
		// Keyboard parity: a mouse-only picker locks out keyboard users.
		for ( const el of document.querySelectorAll( `[${ ASK_ATTR }]` ) ) {
			if ( on ) {
				el.setAttribute( 'tabindex', '0' );
			} else {
				el.removeAttribute( 'tabindex' );
			}
		}
	}, [] );

	const start = useCallback( () => setPicking( true ), [ setPicking ] );
	const cancel = useCallback( () => setPicking( false ), [ setPicking ] );

	const ask = useCallback(
		( target, additive ) => {
			const chain = chainFrom( target );
			if ( 0 === chain.length ) {
				// Nothing askable: cancel, never ask about the page.
				setPicking( false );
				return;
			}
			onPickRef.current?.( chain, { additive } );
			// An additive pick keeps picking — that is what multi-select is.
			if ( ! additive ) {
				setPicking( false );
			}
		},
		[ setPicking ]
	);

	useEffect( () => {
		const onMouseDown = ( e ) => {
			modifierRef.current = e.metaKey || e.ctrlKey;
		};
		const onClick = ( e ) => {
			if ( ! activeRef.current ) {
				return;
			}
			// Capture phase: the row's own handler must not also fire.
			e.preventDefault();
			e.stopPropagation();
			ask( e.target, modifierRef.current );
			modifierRef.current = false;
		};
		const onKeyDown = ( e ) => {
			if ( ! activeRef.current ) {
				return;
			}
			if ( 'Escape' === e.key ) {
				e.preventDefault();
				setPicking( false );
				return;
			}
			if ( 'Enter' === e.key || ' ' === e.key ) {
				e.preventDefault();
				ask( e.target, e.metaKey || e.ctrlKey );
			}
		};

		document.addEventListener( 'mousedown', onMouseDown, true );
		document.addEventListener( 'click', onClick, true );
		document.addEventListener( 'keydown', onKeyDown, true );
		return () => {
			document.removeEventListener( 'mousedown', onMouseDown, true );
			document.removeEventListener( 'click', onClick, true );
			document.removeEventListener( 'keydown', onKeyDown, true );
			// Unmounting mid-pick must not leave the cursor or the tabindexes.
			setPicking( false );
		};
	}, [ ask, setPicking ] );

	return { active, start, cancel };
}
