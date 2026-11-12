/**
 * Browser entry for Settings → Nodes Runtime, a server-rendered form whose
 * `.wrap` is printed as the skin root: it paints the admin gutters from that
 * wrap through `paintSkinGutters`, with no React and nothing added to the page.
 * The head script has already put the stored skin on `<html>`.
 */
import { paintSkinGutters } from '@newspack-nodes/shared/skinStore';

const wrap = document.querySelector( '.newspack-nodes-settings-wrap' );
if ( wrap ) {
	paintSkinGutters( wrap );
}
