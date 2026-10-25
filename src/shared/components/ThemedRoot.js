import { useEffect, useRef } from '@wordpress/element';
import { SKIN_EVENT, initSkin } from '../theme';

/**
 * No-box themed token-provider for standalone dashboard pages. It applies the
 * console-selected skin (persisted in localStorage) to `<html>` at mount and
 * wraps its children in a `display:contents` skinned non-graph provider,
 * putting the skin's universal tokens (--paper/--ink/--cyan/--font-mono/…) in
 * scope so the dashboard reskins onto them without inheriting topology layout.
 *
 * The three classes are the whole contract. `newspack-nodes-skin-root` +
 * `newspack-nodes-theme` is the selector the substrate's skin sheet emits every
 * `--paper-*`/`--ink-*` token under, and `newspack-nodes-ui` opts into the
 * shared component appearance. Dropping `topology-app` is what keeps the graph
 * layout out.
 *
 * `display: contents` drops this wrapper's own box, but inheritance still
 * passes through, so the skin's `font-family: var(--font-mono)` cascades into
 * the dashboard (terminal-mono under decorative skins, the Newspack sans by
 * default).
 *
 * The dashboard's skinned surface covers only its own box; the WP-admin area
 * around it (the ~20px left gutter beside the menu, the right `max-width`
 * margin, the footer area below the content) otherwise shows the light body
 * background as stray strips. The effect below paints `document.body` with the
 * skin surface resolved from inside this wrapper, and repaints on every
 * `SKIN_EVENT` — the same-tab skin-change signal, which the `storage` event
 * never delivers — so every gutter tracks the live skin. Unmounting restores
 * the original background.
 *
 * @param {Object}                    props          Component props.
 * @param {import('react').ReactNode} props.children Dashboard root(s) to skin.
 * @return {import('react').ReactElement} The themed token provider.
 */
export default function ThemedRoot( { children } ) {
	const ref = useRef( null );

	// Paint the WP-admin gutters with the skin surface at mount and on change.
	useEffect( () => {
		// The gutter probe reads --paper-3, so apply the persisted skin first.
		initSkin();
		const host = ref.current;
		if ( ! host ) {
			return undefined;
		}
		let previous = null;
		/**
		 * Paint `document.body` with the skin's `--paper-3`, resolved by a
		 * throwaway probe span parented INSIDE the themed wrapper — the token
		 * exists only under the skin-root selector, so a probe anywhere else
		 * reads nothing.
		 *
		 * A token that fails to resolve computes as transparent; leave the body
		 * untouched rather than paint it see-through. The first successful
		 * paint captures the pre-paint background, so an unmount that never
		 * painted restores nothing.
		 */
		const paintGutters = () => {
			const probe = document.createElement( 'span' );
			host.appendChild( probe );
			let paper;
			try {
				probe.style.background = 'var(--paper-3)';
				paper = window.getComputedStyle( probe ).backgroundColor;
			} finally {
				probe.remove();
			}
			if ( ! paper || paper === 'rgba(0, 0, 0, 0)' ) {
				return;
			}
			if ( null === previous ) {
				previous = document.body.style.background;
			}
			document.body.style.background = paper;
		};
		paintGutters();
		window.addEventListener( SKIN_EVENT, paintGutters );
		return () => {
			window.removeEventListener( SKIN_EVENT, paintGutters );
			if ( null !== previous ) {
				document.body.style.background = previous;
			}
		};
	}, [] );

	return (
		<div
			ref={ ref }
			className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
			style={ { display: 'contents' } }
		>
			{ children }
		</div>
	);
}
