import { Placeholder } from '@wordpress/components';
import { __ } from '@wordpress/i18n';
import './editor.scss';

/**
 * The fixture block's editor.
 *
 * @return {import('react').ReactElement} A placeholder.
 */
export default function Edit() {
	return <Placeholder label={ __( 'Kea card 4417', 'newspack-nodes' ) } />;
}
