/**
 * Config Audit — the hub's change timeline over the durable settings.p0 log.
 *
 * A thin view over `useLogTailStream` in history mode plus the
 * `settingsaudit:view` model: a newest-first table of watched-option changes,
 * each row giving when the change landed, the option NAME, and an Old → New
 * value pair. `Settings_Event_Writer` records the name for every change, but
 * value excerpts only for options on the substrate's explicit allowlist, so a
 * non-allowlisted row shows the em dash on both sides — the note above the
 * table says so plainly, since a blank cell reads as a value someone emptied. A
 * text filter narrows by option name; the count line reports matched / total.
 *
 * The stream is seeded with the view CLASS, never its registered name: that map
 * is a per-bundle static, and a hub tab runs against whichever bundle's
 * interpreter it was handed (ADR-16).
 */

import { createPortal, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { useLogTailStream } from './hooks/useLogTailStream';
import { useNodeState } from '../runtime/react';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import './styles/config-audit.scss';
import { views } from './nodes/register';

/** The model node the stream publishes; `useStreamGraph` names it `<name>:view`. */
const VIEW_NODE = 'settingsaudit:view';

/** Stands in for what was never recorded: a missing instant, a missing value. */
const EM_DASH = '—';

/**
 * Render a change's instant as local date, time and zone.
 *
 * The date always rides and there is no today-elision: audit rows span days, so
 * a bare clock time cannot say whether a change landed this morning or last
 * month. A missing or zero timestamp renders the em dash rather than 1970.
 *
 * @param {?number} ts Unix seconds, as the view node copied them off TIMESTAMP.
 * @return {string} `YYYY-MM-DD HH:MM:SS ZZZ`, or the em dash.
 */
function formatWhen( ts ) {
	if ( ! ts ) {
		return EM_DASH;
	}
	return formatLocalDateTime( ts );
}

/**
 * Render one Old or New value cell, monospaced and clipped to a single line.
 *
 * The writer records a bounded excerpt and CSS ellipses whatever still
 * overflows, so the whole recorded text rides in `title`, where a hover reaches
 * it. The em dash covers both ways a value goes missing — the option sits off
 * the allowlist, or the writer halved the excerpt away to fit the record under
 * PIPE_BUF — and it beats a blank cell, which reads as a value someone emptied.
 *
 * @param {string} modifier BEM element class marking the cell Old or New.
 * @param {string} [value]  The recorded excerpt; absent when the option carries none.
 * @return {import('react').ReactElement} The rendered cell.
 */
function valueCell( modifier, value ) {
	const present = 'string' === typeof value && '' !== value;
	return (
		<td
			className={ `nodes-config-audit__value ${ modifier }` }
			title={ present ? value : undefined }
		>
			{ present ? value : EM_DASH }
		</td>
	);
}

/**
 * Config Audit hub tab.
 *
 * @param {Object}   props                      Props.
 * @param {?Element} [props.headerControlsSlot] Hub shared-header slot to portal the toolbar into; null renders none, undefined renders it inline.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function ConfigAudit( { headerControlsSlot } ) {
	// A TIMELINE: replay the whole retention, then follow.
	useLogTailStream( {
		name: 'settingsaudit',
		// Explicit .p0 hits the no-worker fallback (settings is 1-partition).
		subscribe: 'settings.p0',
		viewClass: views.SettingsAuditView,
		mode: 'history',
	} );
	const view = useNodeState( VIEW_NODE, 'view' );
	const entries = view?.entries ?? [];

	const [ filter, setFilter ] = useState( '' );
	const query = filter.trim().toLowerCase();
	const rows = query
		? entries.filter( ( e ) => e.option.toLowerCase().includes( query ) )
		: entries;

	const toolbar = (
		<div className="newspack-nodes-toolbar">
			<span className="newspack-nodes-toolbar-stats">
				<span className="newspack-nodes-toolbar-stats__count">
					{ query
						? sprintf(
								// translators: 1: matching changes, 2: total changes.
								_n(
									'%1$d / %2$d change',
									'%1$d / %2$d changes',
									entries.length,
									'newspack-nodes'
								),
								rows.length,
								entries.length
						  )
						: sprintf(
								// translators: %d: number of recorded changes.
								_n(
									'%d change',
									'%d changes',
									entries.length,
									'newspack-nodes'
								),
								entries.length
						  ) }
				</span>
			</span>
			<input
				type="text"
				className="newspack-nodes-search-input"
				placeholder={ __( 'Filter option names…', 'newspack-nodes' ) }
				value={ filter }
				onChange={ ( e ) => setFilter( e.target.value ) }
			/>
		</div>
	);
	// LogStreamViewer slot convention: portal / inline / null-slot nothing.
	let renderedToolbar = null;
	if ( headerControlsSlot ) {
		renderedToolbar = createPortal( toolbar, headerControlsSlot );
	} else if ( undefined === headerControlsSlot ) {
		renderedToolbar = toolbar;
	}

	return (
		<div
			className="nodes-config-audit"
			role="region"
			aria-label={ __( 'Config Audit', 'newspack-nodes' ) }
		>
			{ renderedToolbar }

			<p className="nodes-config-audit__note">
				{ __(
					'Values are recorded only for allowlisted options; other changes record the option name only.',
					'newspack-nodes'
				) }
			</p>

			{ 0 === rows.length ? (
				<p className="newspack-nodes-empty-state nodes-config-audit__empty">
					{ query
						? __(
								'No option names match the filter.',
								'newspack-nodes'
						  )
						: __(
								'No configuration changes recorded yet.',
								'newspack-nodes'
						  ) }
				</p>
			) : (
				<table className="nodes-config-audit__table newspack-nodes-table">
					<thead>
						<tr>
							<th>{ __( 'Time (UTC)', 'newspack-nodes' ) }</th>
							<th>{ __( 'Option', 'newspack-nodes' ) }</th>
							<th>{ __( 'Old', 'newspack-nodes' ) }</th>
							<th>{ __( 'New', 'newspack-nodes' ) }</th>
						</tr>
					</thead>
					<tbody>
						{ rows.map( ( row ) => (
							<tr key={ row.id }>
								<td className="nodes-config-audit__time">
									{ formatWhen( row.ts ) }
								</td>
								<td className="nodes-config-audit__option">
									{ row.option }
								</td>
								{ valueCell(
									'nodes-config-audit__old',
									row.old
								) }
								{ valueCell(
									'nodes-config-audit__new',
									row.new
								) }
							</tr>
						) ) }
					</tbody>
				</table>
			) }
		</div>
	);
}
