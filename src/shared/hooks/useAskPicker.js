/**
 * useAskPicker — ask-about-this-element picking, shared by every dashboard.
 *
 * One `data-ask` attribute is the whole opt-in, so a surface needs no
 * per-element wiring and the picker needs no per-surface branching. The class
 * and attribute names are exported because two outside parties name them too:
 * `src/shared/styles/_components.scss` and a consumer's own trigger button.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

/** Marks the ROOT while picking; the stylesheet paints the armed state off it. */
export const ASKING_CLASS = 'newspack-nodes-asking';

/**
 * The opt-in attribute. Any element becomes askable by carrying it, and its
 * value is the descriptor the consumer asks about.
 */
const ASK_ATTR = 'data-ask';

/**
 * Marks the picker's own controls, which it must NOT swallow: the capture-phase
 * handler suppresses every click and keypress while armed, so a trigger without
 * this attribute never receives its own `onClick` and could not cancel the mode
 * it opened.
 */
export const ASK_TRIGGER_ATTR = 'data-ask-trigger';

/**
 * Marks each element picked in the current selection. It names a descriptor,
 * not an element: whatever carries a picked descriptor wears it, so a row a
 * surface re-renders onto another entry gives the mark up.
 */
export const ASK_PICKED_ATTR = 'data-ask-picked';

/**
 * Marks a `tabindex` the picker set itself, so disarming removes only those:
 * a row that sets its own keeps it, and React would never put it back.
 */
const ASK_TABINDEX_ATTR = 'data-ask-tabindex';

/**
 * Marks a target the size of the page. It rings the viewport rather than its
 * own border, which on a scrolled page is off-screen — the stylesheet owns
 * that, and names this attribute to do it.
 */
export const ASK_PAGE_ATTR = 'data-ask-page';

/**
 * Collect every `[data-ask]` descriptor from `el` outward, innermost first and
 * each one once. DOM nesting already expresses containment — a span sits
 * inside its request, a row inside its URL — so the chain is what makes the
 * small descriptor vocabulary self-sufficient without a second attribute for
 * scope.
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
 * Bring one element in line with the mode: an askable is focusable while
 * armed, and marked while its descriptor is picked. Only a value that differs
 * is written, because the observer repaints on every render while armed.
 *
 * @param {Element}     el     The element to paint.
 * @param {boolean}     armed  Whether the picker is armed.
 * @param {Set<string>} picked Target descriptors picked this session.
 */
function paintOne( el, armed, picked ) {
	const askable = armed && el.hasAttribute( ASK_ATTR );
	// Keyboard parity: a mouse-only picker locks out keyboard users.
	if ( askable && ! el.hasAttribute( 'tabindex' ) ) {
		el.setAttribute( 'tabindex', '0' );
		el.setAttribute( ASK_TABINDEX_ATTR, '' );
	} else if ( ! askable && el.hasAttribute( ASK_TABINDEX_ATTR ) ) {
		el.removeAttribute( 'tabindex' );
		el.removeAttribute( ASK_TABINDEX_ATTR );
	}
	const mark = askable && picked.has( el.getAttribute( ASK_ATTR ) );
	if ( mark !== el.hasAttribute( ASK_PICKED_ATTR ) ) {
		el.toggleAttribute( ASK_PICKED_ATTR, mark );
	}
}

/**
 * Paint the whole page, on arming and disarming only. Whatever the picker
 * left behind is matched too, so it comes off with the mode.
 *
 * @param {boolean}     armed  Whether the picker is armed.
 * @param {Set<string>} picked Target descriptors picked this session.
 */
function paintAll( armed, picked ) {
	for ( const el of document.querySelectorAll(
		`[${ ASK_ATTR }], [${ ASK_PICKED_ATTR }], [${ ASK_TABINDEX_ATTR }]`
	) ) {
		paintOne( el, armed, picked );
	}
}

/**
 * Every element carrying one descriptor: the picks a toggle repaints.
 *
 * @param {string} descriptor The descriptor, as `data-ask` spells it.
 * @return {Iterable<Element>} Its carriers.
 */
function carriersOf( descriptor ) {
	const quoted = descriptor
		.replace( /["\\]/g, '\\$&' )
		.replace( /\n/g, '\\a ' );
	return document.querySelectorAll( `[${ ASK_ATTR }="${ quoted }"]` );
}

/**
 * Repaint only what a batch of mutations touched: the element whose
 * descriptor changed, and every askable a render added.
 *
 * @param {MutationRecord[]} records The batch.
 * @param {Set<string>}      picked  Target descriptors picked this session.
 */
function paintChanged( records, picked ) {
	for ( const record of records ) {
		if ( 'attributes' === record.type ) {
			paintOne( /** @type {Element} */ ( record.target ), true, picked );
			continue;
		}
		for ( const node of record.addedNodes ) {
			if ( ! ( node instanceof window.Element ) ) {
				continue;
			}
			if ( node.hasAttribute( ASK_ATTR ) ) {
				paintOne( node, true, picked );
			}
			for ( const el of node.querySelectorAll( `[${ ASK_ATTR }]` ) ) {
				paintOne( el, true, picked );
			}
		}
	}
}

/**
 * The `?` picker: click an Ask button, the cursor becomes a `?`, and the next
 * click asks about whatever you point at.
 *
 * A per-surface "Ask AI" button has to guess what you meant. This inverts it —
 * THE TARGET IS THE SCOPE — so the payload is that thing plus enough context to
 * explain it, and there is no per-surface branching at all: what you click
 * decides everything.
 *
 * ONE picker, though, however many triggers open it. The mode is document-level
 * — it marks the root, makes every `[data-ask]` focusable and swallows the next
 * click in the capture phase — so a second instance fights the first over that
 * one mode, and an unmounting one clears the root class mid-pick. Hold it once
 * and render as many triggers as there are places worth asking from.
 *
 * A modified pick TOGGLES: Cmd/Ctrl-click adds a target to the selection and
 * a second one on it takes it back out, each marked with `ASK_PICKED_ATTR`
 * while it stands. A plain click finishes, asking about its target unless that
 * is already picked; Escape abandons. Every mark goes when the mode does.
 *
 * While picking, the target's own handler is suppressed in the CAPTURE phase,
 * for modified and unmodified clicks alike. That matters more than it looks:
 * Cmd/Ctrl-click already MEANS something on exactly these elements — reveal the
 * log entry on a flame span, fold recursively on a log row — so both forms have
 * to be intercepted, and the modifier is re-read on `mousedown` because that is
 * the convention already shipping (macOS treats Control-click as a secondary
 * click, and the mousedown read is the working answer to it). That modified
 * press also loses its default, or Firefox selects and outlines table cells.
 *
 * @param {Object}                                                     options
 * @param {(descriptors: string[], meta: {additive: boolean}) => void} options.onPick      Called with the descriptor chain, target first; an additive pick keeps the picker armed for the next one.
 * @param {(descriptors: string[]) => void}                            [options.onUnpick]  Called with a pick's chain when a second modified click takes it back out.
 * @param {() => void}                                                 [options.onAbandon] Called when Escape gives the selection up, which a finished pick never is.
 * @return {{ active: boolean, start: () => void, cancel: () => void }} Picker controls.
 */
export function useAskPicker( { onPick, onUnpick, onAbandon } ) {
	const [ active, setActive ] = useState( false );
	const activeRef = useRef( false );
	const modifierRef = useRef( false );
	const pickedRef = useRef( new Set() );
	const observerRef = useRef( null );
	const onPickRef = useRef( onPick );
	onPickRef.current = onPick;
	const onUnpickRef = useRef( onUnpick );
	onUnpickRef.current = onUnpick;
	const onAbandonRef = useRef( onAbandon );
	onAbandonRef.current = onAbandon;

	const setPicking = useCallback( ( on ) => {
		activeRef.current = on;
		pickedRef.current.clear();
		setActive( on );
		document.documentElement.classList.toggle( ASKING_CLASS, on );
		paintAll( on, pickedRef.current );
		observerRef.current?.disconnect();
		observerRef.current = null;
		if ( on ) {
			// A surface re-rendering while armed must not strand its paint.
			observerRef.current = new window.MutationObserver( ( records ) =>
				paintChanged( records, pickedRef.current )
			);
			observerRef.current.observe( document.body, {
				subtree: true,
				childList: true,
				attributeFilter: [ ASK_ATTR ],
			} );
		}
	}, [] );

	const start = useCallback( () => setPicking( true ), [ setPicking ] );
	const cancel = useCallback( () => setPicking( false ), [ setPicking ] );

	const ask = useCallback(
		( target, additive ) => {
			const chain = chainFrom( target );
			if ( 0 === chain.length ) {
				// Disarming would hand the next click to what is under it.
				return;
			}
			const picked = pickedRef.current;
			const [ descriptor ] = chain;
			if ( ! additive ) {
				if ( ! picked.has( descriptor ) ) {
					onPickRef.current?.( chain, { additive } );
				}
				setPicking( false );
				return;
			}
			// An additive pick keeps picking — that is what multi-select is.
			if ( picked.has( descriptor ) ) {
				picked.delete( descriptor );
				onUnpickRef.current?.( chain );
			} else {
				picked.add( descriptor );
				onPickRef.current?.( chain, { additive } );
			}
			for ( const el of carriersOf( descriptor ) ) {
				paintOne( el, true, picked );
			}
		},
		[ setPicking ]
	);

	useEffect( () => {
		const onMouseDown = ( e ) => {
			modifierRef.current = e.metaKey || e.ctrlKey;
			if (
				activeRef.current &&
				modifierRef.current &&
				! e.target?.closest?.( `[${ ASK_TRIGGER_ATTR }]` )
			) {
				// Firefox's accel-press selects table cells; this press picks.
				e.preventDefault();
				// A cancelled press moves no focus; Enter must reach the pick.
				e.target
					.closest?.( `[${ ASK_ATTR }]` )
					?.focus( { preventScroll: true } );
			}
		};
		const onClick = ( e ) => {
			if ( ! activeRef.current ) {
				return;
			}
			// The picker's own controls act normally while it is armed.
			if ( e.target?.closest?.( `[${ ASK_TRIGGER_ATTR }]` ) ) {
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
				// Giving up, not finishing: the holder drops it.
				onAbandonRef.current?.();
				setPicking( false );
				return;
			}
			// The picker's own controls act normally while armed.
			if ( e.target?.closest?.( `[${ ASK_TRIGGER_ATTR }]` ) ) {
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
