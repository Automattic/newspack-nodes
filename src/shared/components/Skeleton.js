import { __ } from '@wordpress/i18n';

/**
 * One placeholder bar in the shared skeleton role, sized by the shared sheet
 * for the part of a row it stands for.
 *
 * @param {Object}                                props
 * @param {'title' | 'meta' | 'summary' | 'line'} props.part The part.
 * @return {import('react').ReactElement} The bar.
 */
function Bar( { part } ) {
	return (
		<span
			className={ `newspack-nodes-skeleton newspack-nodes-skeleton--${ part }` }
		/>
	);
}

/**
 * Placeholders for rows still owed, so the answer replaces them without the
 * page moving. The whole is announced as loading and carries no text of its
 * own.
 *
 * @param {Object}         props
 * @param {'row' | 'line'} [props.shape] An item row, or a line of prose.
 * @param {number}         [props.count] How many.
 * @return {import('react').ReactElement} The placeholders.
 */
export default function Skeleton( { shape = 'row', count = 3 } ) {
	const each = Array.from( { length: count }, ( _, n ) => n );
	return (
		<div role="status" aria-label={ __( 'Loading', 'newspack-nodes' ) }>
			{ 'line' === shape ? (
				each.map( ( n ) => (
					<p key={ n } aria-hidden="true">
						<Bar part="line" />
					</p>
				) )
			) : (
				<ul
					className="newspack-nodes-composed-skeleton-rows"
					aria-hidden="true"
				>
					{ each.map( ( n ) => (
						<li key={ n }>
							<Bar part="title" />
							<p className="newspack-nodes-status is-muted">
								<Bar part="meta" />
							</p>
							<p>
								<Bar part="summary" />
							</p>
						</li>
					) ) }
				</ul>
			) }
		</div>
	);
}
