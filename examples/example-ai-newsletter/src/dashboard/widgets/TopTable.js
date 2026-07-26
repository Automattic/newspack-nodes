import apiFetch from '@wordpress/api-fetch';
import { useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';
import { draftNewsletter } from '../draftNewsletter';
import { newsletterPost } from '../newsletterPost';
import { itemLabel } from '../itemLabel';

// @longform
// REST-call seam for the "Create draft post" action. Lazily defaulted to a
// thin apiFetch wrapper; tests inject a fake so the suite never hits the
// network but still exercises the success/failure rendering paths.
const defaultCreateDraft = ( { title, content } ) =>
	apiFetch( {
		path: '/wp/v2/posts',
		method: 'POST',
		data: { title, content, status: 'draft' },
	} );

/**
 * TopTable — the "Top items" card. Reads ONLY the `top-table:view` node's slice
 * ({ top:[…] }) via useNodeState and renders the score-ranked table with inline
 * score bars, plus the client-side newsletter actions (draft preview, copy
 * markdown, create draft post) that operate on those `top` items.
 *
 * @param {Object}   props
 * @param {Function} [props.createDraft] REST-call seam: ({title,content}) => Promise (tests).
 */
export function TopTable( { createDraft = defaultCreateDraft } = {} ) {
	const slice = useNodeState( 'top-table:view', 'view' ) || { top: [] };
	const top = slice.top ?? [];
	const topScore = top.reduce(
		( max, item ) => Math.max( max, item.score || 0 ),
		0
	);

	const [ draft, setDraft ] = useState( null );
	const [ copied, setCopied ] = useState( false );
	const [ editLink, setEditLink ] = useState( null );
	const [ draftError, setDraftError ] = useState( null );
	const [ creating, setCreating ] = useState( false );

	const onCopy = () => {
		setDraftError( null );
		// @longform
		// navigator.clipboard is undefined on insecure (non-HTTPS) origins and
		// older browsers — guard it, and only flag "Copied" once the write
		// actually resolves.
		const clipboard = window.navigator.clipboard;
		if ( ! clipboard || ! clipboard.writeText ) {
			setCopied( false );
			setDraftError(
				__(
					'Clipboard unavailable here — copy from the preview instead.',
					'example-ai-newsletter'
				)
			);
			return;
		}
		clipboard
			.writeText( draftNewsletter( top ) )
			.then( () => setCopied( true ) )
			.catch( () => {
				setCopied( false );
				setDraftError(
					__(
						'Could not copy to the clipboard.',
						'example-ai-newsletter'
					)
				);
			} );
	};

	const onCreateDraft = () => {
		setCreating( true );
		setDraftError( null );
		setEditLink( null );
		createDraft( newsletterPost( top ) )
			.then( ( post ) => {
				setCreating( false );
				if ( ! post || ! post.id ) {
					setDraftError(
						__(
							'Draft created, but no post id was returned.',
							'example-ai-newsletter'
						)
					);
					return;
				}
				setEditLink(
					`${ window.location.origin }/wp-admin/post.php?post=${ post.id }&action=edit`
				);
			} )
			.catch( ( err ) => {
				setCreating( false );
				setDraftError(
					err && err.message
						? err.message
						: __(
								'Could not create the draft.',
								'example-ai-newsletter'
						  )
				);
			} );
	};

	if ( slice.error ) {
		return (
			<section className="eai-insights__card eai-insights__top">
				<h2>{ __( 'Top items', 'example-ai-newsletter' ) }</h2>
				<div
					className="eai-insights__notice eai-insights__notice--error"
					role="alert"
				>
					{ slice.error }
				</div>
			</section>
		);
	}

	if ( 0 === top.length ) {
		return (
			<section className="eai-insights__card eai-insights__top">
				<h2>{ __( 'Top items', 'example-ai-newsletter' ) }</h2>
				<div className="eai-insights__empty">
					<p>
						{ __(
							'No scored items yet.',
							'example-ai-newsletter'
						) }
					</p>
					<p className="eai-insights__empty-hint">
						{ __(
							'Drive the pipeline — tick the sources — and this updates on the next poll.',
							'example-ai-newsletter'
						) }
					</p>
				</div>
			</section>
		);
	}

	return (
		<section className="eai-insights__card eai-insights__top">
			<h2>{ __( 'Top items', 'example-ai-newsletter' ) }</h2>
			<table>
				<thead>
					<tr>
						<th className="eai-insights__rank-col">
							{ __( '#', 'example-ai-newsletter' ) }
						</th>
						<th>{ __( 'Source', 'example-ai-newsletter' ) }</th>
						<th>{ __( 'Title', 'example-ai-newsletter' ) }</th>
						<th>{ __( 'Score', 'example-ai-newsletter' ) }</th>
					</tr>
				</thead>
				<tbody>
					{ top.map( ( item, i ) => (
						<tr key={ `${ item.source }-${ i }` }>
							<td className="eai-insights__rank">
								{ sprintf(
									/* translators: %d: the item's rank in the score-ordered list. */
									__( '#%d', 'example-ai-newsletter' ),
									i + 1
								) }
							</td>
							<td>{ item.source }</td>
							<td>{ item.title }</td>
							<td className="eai-insights__score-cell">
								<div
									className="eai-insights__score-bar-track"
									aria-hidden="true"
								>
									<div
										className="eai-insights__score-bar"
										style={ {
											width: `${
												topScore
													? ( ( item.score || 0 ) /
															topScore ) *
													  100
													: 0
											}%`,
										} }
									/>
								</div>
								<span className="eai-insights__score-num">
									{ item.score }
								</span>
							</td>
						</tr>
					) ) }
				</tbody>
			</table>

			<div className="eai-insights__actions">
				<button
					type="button"
					className="eai-insights__btn"
					onClick={ () => setDraft( top ) }
				>
					{ __( 'Draft newsletter', 'example-ai-newsletter' ) }
				</button>
				<button
					type="button"
					className="eai-insights__btn eai-insights__btn--secondary"
					onClick={ onCopy }
				>
					{ __( 'Copy markdown', 'example-ai-newsletter' ) }
				</button>
				<button
					type="button"
					className="eai-insights__btn eai-insights__btn--secondary"
					onClick={ onCreateDraft }
					disabled={ creating }
				>
					{ __( 'Create draft post', 'example-ai-newsletter' ) }
				</button>
				{ copied && (
					<span className="eai-insights__copied" role="status">
						{ __( 'Copied', 'example-ai-newsletter' ) }
					</span>
				) }
			</div>

			{ null !== editLink && (
				<p className="eai-insights__draft-result">
					<a href={ editLink }>
						{ __( 'Edit draft', 'example-ai-newsletter' ) }
					</a>
				</p>
			) }
			{ null !== draftError && (
				<div
					className="eai-insights__notice eai-insights__notice--error"
					role="alert"
				>
					{ draftError }
				</div>
			) }

			{ null !== draft && (
				<ul
					className="eai-insights__preview"
					data-testid="eai-insights-preview"
				>
					{ draft.map( ( item, i ) => {
						const { title, source } = itemLabel( item );
						return (
							<li key={ `${ source }-${ i }` }>
								<span className="eai-insights__preview-title">
									{ title }
								</span>
								<span className="eai-insights__preview-source">
									{ source }
								</span>
							</li>
						);
					} ) }
				</ul>
			) }
		</section>
	);
}
