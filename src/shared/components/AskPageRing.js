/**
 * AskPageRing — the `?` picker's ring around a target the size of the page.
 *
 * Every other ask target wears an outline on `:hover`. The page box cannot:
 * an outline there is painted over by the box's own children, and on a
 * scrolled page its edges sit off screen. So this is an overlay — and one
 * that MOUNTS ONCE per armed session rather than appearing and vanishing as
 * the pointer crosses the rows inside it.
 *
 * It renders at body level through `ModalPortal`, the same escape the dialogs
 * take, since the shell it rings is a stacking context of its own.
 */

import { useEffect, useState } from '@wordpress/element';
import { ModalPortal } from './Modal';
import { ASK_PAGE_ATTR } from '../hooks/useAskPicker';
import useAdminMenuWidth from '../hooks/useAdminMenuWidth';

/**
 * The rectangle to ring: where the page box is, and how much of it is CONTENT.
 * `clientWidth` and `clientHeight` already exclude that box's own scrollbar,
 * so the line lands inside it rather than reading as a browser edge.
 *
 * @param {Element} el The page-sized ask target.
 * @return {{top: string, left: string, width: string, height: string}} Inline geometry.
 */
function boxOf( el ) {
	const rect = el.getBoundingClientRect();
	return {
		top: `${ rect.top + ( el.clientTop || 0 ) }px`,
		left: `${ rect.left + ( el.clientLeft || 0 ) }px`,
		width: `${ el.clientWidth }px`,
		height: `${ el.clientHeight }px`,
	};
}

/**
 * @param {Object}  props
 * @param {boolean} props.active Whether the picker is armed.
 * @return {?import('react').ReactElement} The ring, or null when there is
 *                                         nothing armed or nothing to ring.
 */
export default function AskPageRing( { active } ) {
	const [ box, setBox ] = useState( null );
	// The menu fold moves the box without resizing the window.
	const menuWidth = useAdminMenuWidth();

	useEffect( () => {
		if ( ! active ) {
			setBox( null );
			return undefined;
		}
		const measure = () => {
			const el = document.querySelector( `[${ ASK_PAGE_ATTR }]` );
			const next = el ? boxOf( el ) : null;
			// A fresh object every call; an unchanged box must not re-render.
			setBox( ( prev ) =>
				JSON.stringify( prev ) === JSON.stringify( next ) ? prev : next
			);
		};
		measure();
		window.addEventListener( 'resize', measure );
		// @longform The shell EASES `left` on a menu fold, so the fold's own
		// signal arrives while the box is still moving and a rect read there
		// is the value it started from. This is where it lands; the signal
		// above is what answers where no transition runs at all.
		document.addEventListener( 'transitionend', measure );
		return () => {
			window.removeEventListener( 'resize', measure );
			document.removeEventListener( 'transitionend', measure );
		};
	}, [ active, menuWidth ] );

	if ( ! box ) {
		return null;
	}

	return (
		<ModalPortal>
			<div className="newspack-nodes-ask-ring" style={ box } />
		</ModalPortal>
	);
}
