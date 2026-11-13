import { __ } from '@wordpress/i18n';

/**
 * A read that was refused or failed, or nothing when it was not: one
 * sentence and, where asking again can help, a way to, and for an operator
 * the refusal's own words beneath, muted. It is a polite status, because
 * nothing the reader did failed. The caller decides who is an operator and
 * hands it down, so the words it already holds reach only someone who can
 * act on them.
 *
 * @param {Object}     props
 * @param {?string}    props.error      The refusal.
 * @param {() => void} [props.refresh]  Asks the read again; absent where asking again refuses again.
 * @param {boolean}    [props.operator] Whether the reader can act on the refusal's own words.
 * @return {?import('react').ReactElement} The status.
 */
export default function Unread( { error, refresh, operator = false } ) {
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
			{ operator && (
				<p className="newspack-nodes-status is-muted">{ error }</p>
			) }
		</div>
	);
}
