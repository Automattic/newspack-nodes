import { useContext } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { ComposedPage } from '../composition/page/pageContext';

/**
 * A read that was refused or failed, or nothing when it was not: one
 * sentence and, where asking again can help, a way to, and for an operator
 * the refusal's own words beneath, muted. It is a polite status, because
 * nothing the reader did failed. The caller says who is an operator, or
 * leaves it to the page the status stands on, so the words it already holds
 * reach only someone who can act on them; outside a page none is.
 *
 * @param {Object}     props
 * @param {?string}    props.error      The refusal.
 * @param {() => void} [props.refresh]  Asks the read again; absent where asking again refuses again.
 * @param {boolean}    [props.operator] Whether the reader can act on the refusal's own words; the page's `operator` when omitted.
 * @return {?import('react').ReactElement} The status.
 */
export default function Unread( { error, refresh, operator } ) {
	const page = useContext( ComposedPage );
	const shown = operator ?? true === page?.operator;
	if ( ! error ) {
		return null;
	}
	return (
		<div className="newspack-nodes-error-banner" role="status">
			<p>
				{ refresh ? (
					<>
						{ __(
							'This could not be read just now. Try again.',
							'newspack-nodes'
						) }{ ' ' }
						<button
							type="button"
							className="button"
							onClick={ refresh }
						>
							{ __( 'Try again', 'newspack-nodes' ) }
						</button>
					</>
				) : (
					__( 'This could not be read just now.', 'newspack-nodes' )
				) }
			</p>
			{ shown && (
				<p className="newspack-nodes-status is-muted">{ error }</p>
			) }
		</div>
	);
}
