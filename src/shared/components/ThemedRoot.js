import { Popover, SlotFillProvider } from '@wordpress/components';
import { useRef } from '@wordpress/element';
import useSkinGutters from '../hooks/useSkinGutters';

/**
 * The classes every skinned root wears, this provider's own and every frame
 * portalled out of it: the skin root, the theme and the shared UI scope.
 */
export const SKIN_ROOT_CLASSES =
	'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui';

/**
 * No-box themed token-provider for standalone dashboard pages. It applies the
 * console-selected skin (persisted in localStorage) to `<html>` at mount and
 * wraps its children in a `display:contents` skinned non-graph provider,
 * putting the skin's universal tokens (--paper/--ink/--cyan/--font-mono/…) in
 * scope so the dashboard reskins onto them without inheriting topology layout.
 *
 * The three classes, `SKIN_ROOT_CLASSES`, are the whole contract.
 * `newspack-nodes-skin-root` + `newspack-nodes-theme` is the selector the
 * substrate's skin sheet emits every `--paper-*`/`--ink-*` token under, and
 * `newspack-nodes-ui` opts into the shared component appearance. Dropping
 * `topology-app` is what keeps the graph layout out.
 *
 * A stock Popover renders through a slot at the end of the wrapper rather
 * than the fallback container on `<body>`, so a dropdown, menu or popover
 * opened in the dashboard sits inside the skin root and takes its tokens.
 *
 * `display: contents` drops this wrapper's own box, but inheritance still
 * passes through, so the skin's `font-family: var(--font-mono)` cascades into
 * the dashboard (terminal-mono under decorative skins, the Newspack sans by
 * default).
 *
 * The dashboard's skinned surface covers only its own box; the WP-admin area
 * around it (the ~20px left gutter beside the menu, the right `max-width`
 * margin, the footer area below the content) otherwise shows the light body
 * background as stray strips. `useSkinGutters` paints `document.body` with
 * the skin surface resolved from inside this wrapper, and repaints on every
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

	useSkinGutters( ref );

	return (
		<div
			ref={ ref }
			className={ SKIN_ROOT_CLASSES }
			style={ { display: 'contents' } }
		>
			<SlotFillProvider>
				{ children }
				<Popover.Slot />
			</SlotFillProvider>
		</div>
	);
}
