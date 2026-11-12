import { useEffect } from '@wordpress/element';
import { paintSkinGutters } from '../skinStore';

/**
 * `paintSkinGutters` for a component: paints from the skin root `ref` points
 * at once it mounts, and restores `<body>` on unmount. `ThemedRoot` calls it
 * on the wrapper it renders.
 *
 * @param {{current: ?Element}} ref The skin root to resolve the tokens in.
 */
export default function useSkinGutters( ref ) {
	useEffect( () => paintSkinGutters( ref.current ), [ ref ] );
}
