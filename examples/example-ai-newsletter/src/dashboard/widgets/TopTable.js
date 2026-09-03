/**
 * The "Top items" card: the score-ranked table, and the three newsletter
 * actions that turn those items into something a publisher can send.
 *
 * The actions sit beside the table because they operate on exactly the rows it
 * renders — one `top` array feeds the preview, the markdown and the draft
 * post. Two of them are client-side; "Create draft post" is the only call that
 * leaves the browser.
 */

import apiFetch from '@wordpress/api-fetch';
import { useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';
import { draftNewsletter } from '../draftNewsletter';
import { newsletterPost } from '../newsletterPost';
import { itemLabel } from '../itemLabel';

/**
 * Create the draft post through the REST API.
 *
 * This is the default value of the `createDraft` prop, and the prop is the
 * seam: a test hands `<TopTable/>` a fake that resolves or rejects, so both
 * rendered outcomes are exercised without touching the network.
 *
 * @param {Object} draft         The post to create.
 * @param {string} draft.title   Post title.
 * @param {string} draft.content Post content, as HTML.
 * @return {Promise<Object>} Resolves with the created post, whose `id` builds
 *                           the "Edit draft" link.
 */
const defaultCreateDraft = ( { title, content } ) =>
	apiFetch( {
		path: '/wp/v2/posts',
		method: 'POST',
		data: { title, content, status: 'draft' },
	} );

/**
 * The "Top items" card.
 *
 * Reads ONLY the `top-table:view` node's slice (`{ top: […] }`) through
 * `useNodeState`, which is the one-slice-per-view rule of
 * `docs/writing-a-view-node.md`: a view holding every slice would put one
 * slice's error notice on all three cards. That slice produces three renders —
 * an error notice, an empty hint until the first scored items arrive, and the
 * table. The model arrives score-ordered, so the rows keep its order and the
 * rank column is the row index.
 *
 * Each score bar is sized against the highest score on screen rather than a
 * fixed ceiling, so the top row fills its track and the rest read as a
 * proportion of it.
 *
 * The preview, the "Copied" flag, the edit link and the error notice are local
 * `useState` rather than slice fields, because the next poll reply replaces the
 * whole model and would take an action's result with it.
 *
 * @param {Object}   props               Component props.
 * @param {Function} [props.createDraft] Seam for the draft-post REST call,
 *                                       taking `{ title, content }` and
 *                                       returning a promise. Defaults to
 *                                       `defaultCreateDraft`.
 * @return {import('react').ReactElement} Rendered component.
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

	/**
	 * Copy the markdown draft to the clipboard.
	 *
	 * `navigator.clipboard` is undefined on insecure origins and on older
	 * browsers, so the guard is the difference between a dead button and an
	 * explanation. "Copied" is flagged only once the write resolves, because
	 * `writeText` returns a promise that a denied permission or an unfocused
	 * document still rejects.
	 */
	const onCopy = () => {
		setDraftError( null );
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

	/**
	 * Create the WordPress draft post from the ranked items.
	 *
	 * A reply carrying no `id` gets an error notice instead of an "Edit draft"
	 * link, which would otherwise point at `post=undefined`. The button stays
	 * disabled across the round trip, so a second click cannot open a second
	 * draft.
	 */
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
