import apiFetch from '@wordpress/api-fetch';
import { useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';
import { useInsightsGraph } from './hooks/useInsightsGraph';
import { emptyModel } from './nodes/insightsView';
import { draftNewsletter } from './draftNewsletter';
import { newsletterPost } from './newsletterPost';
import { itemLabel } from './itemLabel';
import './styles/insights.scss';

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
 * Publisher Insights — the thin view over the `insights:view` node graph. The
 * graph (mounted by useInsightsGraph) owns the data: the page-visibility-gated
 * poll fires the `insights` command, and `insights:view` holds the model React
 * reads via useNodeState. This component renders that model — an error notice,
 * an empty state, or the populated analytics dashboard (KPI stat cards,
 * proportion bars, a score-ranked table, and a draft section that previews the
 * items, copies markdown, or creates a real WordPress draft). Styling follows
 * the Newspack in-product design system (docs/DESIGN.product.md): light
 * surfaces, a Cobalt accent, Inter, laid out in flow within wp-admin.
 *
 * @param {Object}   props
 * @param {number}   [props.refreshMs]     Poll interval in ms (default 4000).
 * @param {Object}   [props.commandClient] CommandClient seam forwarded to the hook (tests).
 * @param {Function} [props.createDraft]   REST-call seam: ({title,content}) => Promise (tests).
 */
export default function PublisherInsights( {
	refreshMs = 4000,
	commandClient,
	createDraft = defaultCreateDraft,
} ) {
	useInsightsGraph( { refreshMs, commandClient } );
	// One fallback to the canonical empty shape; the node guarantees the data
	// fields on every publish (model, error-model, or empty), so no per-field guards.
	const model = useNodeState( 'insights:view', 'view' ) || emptyModel();
	const [ draft, setDraft ] = useState( null );
	const [ copied, setCopied ] = useState( false );
	const [ editLink, setEditLink ] = useState( null );
	const [ draftError, setDraftError ] = useState( null );
	const [ creating, setCreating ] = useState( false );

	const error = model.error || null;
	// Defensive ?? {}/[]: emptyModel + the CI guarantee these, but a malformed
	// 200 reply could publish a partial object — never crash the page on it.
	const sources = Object.entries( model.sources ?? {} );
	const top = model.top ?? [];
	const isEmpty = ! model.accumulated && 0 === top.length;

	const topScore = top.reduce(
		( max, item ) => Math.max( max, item.score || 0 ),
		0
	);
	const sourceTotal = sources.reduce(
		( sum, [ , count ] ) => sum + count,
		0
	);

	const onCopy = () => {
		setDraftError( null );
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

	// One branch wins: an error notice, the empty state, or the populated
	// dashboard. (if/else, not a nested ternary — keeps each branch readable.)
	let content;
	if ( error ) {
		content = (
			<div
				className="eai-insights__notice eai-insights__notice--error"
				role="alert"
			>
				{ error }
			</div>
		);
	} else if ( isEmpty ) {
		content = (
			<div className="eai-insights__empty">
				<p>{ __( 'No scored items yet.', 'example-ai-newsletter' ) }</p>
				<p className="eai-insights__empty-hint">
					{ __(
						'Drive the pipeline — tick the sources — and this updates on the next poll.',
						'example-ai-newsletter'
					) }
				</p>
			</div>
		);
	} else {
		content = (
			<div className="eai-insights__grid">
				<div className="eai-insights__stats">
					<div className="eai-insights__stat">
						<span className="eai-insights__stat-num">
							{ model.accumulated }
						</span>
						<span className="eai-insights__stat-label">
							{ __( 'Total items', 'example-ai-newsletter' ) }
						</span>
					</div>
					<div className="eai-insights__stat">
						<span className="eai-insights__stat-num">
							{ topScore }
						</span>
						<span className="eai-insights__stat-label">
							{ __( 'Top score', 'example-ai-newsletter' ) }
						</span>
					</div>
					<div className="eai-insights__stat">
						<span className="eai-insights__stat-num">
							{ sources.length }
						</span>
						<span className="eai-insights__stat-label">
							{ __( 'Sources', 'example-ai-newsletter' ) }
						</span>
					</div>
				</div>

				<section className="eai-insights__card eai-insights__sources">
					<h2>{ __( 'By source', 'example-ai-newsletter' ) }</h2>
					<ul>
						{ sources.map( ( [ name, count ] ) => (
							<li key={ name }>
								<div className="eai-insights__bar-head">
									<span className="eai-insights__source-name">
										{ name }
									</span>
									<span className="eai-insights__source-count">
										{ count }
									</span>
								</div>
								<div
									className="eai-insights__bar"
									aria-hidden="true"
								>
									<div
										className="eai-insights__bar-fill"
										style={ {
											width: `${
												sourceTotal
													? ( count / sourceTotal ) *
													  100
													: 0
											}%`,
										} }
									/>
								</div>
							</li>
						) ) }
					</ul>
				</section>

				<section className="eai-insights__card eai-insights__top">
					<h2>{ __( 'Top items', 'example-ai-newsletter' ) }</h2>
					<table>
						<thead>
							<tr>
								<th className="eai-insights__rank-col">
									{ __( '#', 'example-ai-newsletter' ) }
								</th>
								<th>
									{ __( 'Source', 'example-ai-newsletter' ) }
								</th>
								<th>
									{ __( 'Title', 'example-ai-newsletter' ) }
								</th>
								<th>
									{ __( 'Score', 'example-ai-newsletter' ) }
								</th>
							</tr>
						</thead>
						<tbody>
							{ top.map( ( item, i ) => (
								<tr key={ `${ item.source }-${ i }` }>
									<td className="eai-insights__rank">
										{ sprintf(
											/* translators: %d: the item's rank in the score-ordered list. */
											__(
												'#%d',
												'example-ai-newsletter'
											),
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
															? ( ( item.score ||
																	0 ) /
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
				</section>

				<section className="eai-insights__card eai-insights__draft">
					<h2>{ __( 'Newsletter', 'example-ai-newsletter' ) }</h2>
					<div className="eai-insights__actions">
						<button
							type="button"
							className="eai-insights__btn"
							onClick={ () => setDraft( top ) }
						>
							{ __(
								'Draft newsletter',
								'example-ai-newsletter'
							) }
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
							{ __(
								'Create draft post',
								'example-ai-newsletter'
							) }
						</button>
						{ copied && (
							<span
								className="eai-insights__copied"
								role="status"
							>
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
			</div>
		);
	}

	return (
		<div className="eai-insights">
			<header className="eai-insights__header">
				<h1>{ __( 'Publisher Insights', 'example-ai-newsletter' ) }</h1>
				<p className="eai-insights__sub">
					{ sprintf(
						/* translators: %d: total items accumulated across the pipeline. */
						__( 'Accumulated items: %d', 'example-ai-newsletter' ),
						model.accumulated
					) }
				</p>
			</header>
			{ content }
		</div>
	);
}
