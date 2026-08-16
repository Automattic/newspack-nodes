/**
 * Config Audit — the hub's change timeline over the durable settings.p0 log.
 *
 * A thin view over `useLogTailStream` (full-replay) + the `settingsaudit:view`
 * model: a newest-first table of watched-option changes, each a Time (UTC), the
 * option NAME, and an Old → New value pair. The option name is recorded for every
 * change; values ride only for options on the substrate's explicit allowlist, so
 * non-allowlisted rows show the em dash — the note states that plainly. A text
 * filter narrows by option name; the count line reports matched / total.
 */

import { createPortal, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { useLogTailStream } from './hooks/useLogTailStream';
import { useNodeState } from '../runtime/react';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import './styles/config-audit.scss';
import { views } from './nodes/register';

const VIEW_NODE = 'settingsaudit:view';
const EM_DASH = '—';

// Local date + time + zone: audit rows span days, so no today-elision.
function formatWhen( ts ) {
	if ( ! ts ) {
		return EM_DASH;
	}
	return formatLocalDateTime( ts );
}

// Mono value cell: the excerpt (title = full text), em dash when absent.
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
 * @param {?Element} [props.headerControlsSlot] Hub shared-header slot to portal the toolbar into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function ConfigAudit( { headerControlsSlot } ) {
	// A TIMELINE: replay the whole retention, then follow.
	useLogTailStream( {
		name: 'settingsaudit',
		// Explicit .p0 hits the no-worker fallback (settings is 1-partition).
		subscribe: 'settings.p0',
		viewType: views.SettingsAuditView,
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
