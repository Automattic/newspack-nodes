/**
 * Config Audit — the hub's change timeline over the durable settings.p0 log.
 *
 * A thin view over `useSettingsAuditStream` (full-replay) + the `settingsaudit:view`
 * model: a newest-first table of watched-option changes, each a Time (UTC) + the
 * option NAME. By design the log records option names ONLY — no value, actor, or
 * enrichment — so the table states that plainly. A text filter narrows by option
 * name; the count line reports matched / total.
 */

import { useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { useSettingsAuditStream } from './hooks/useSettingsAuditStream';
import { useNodeState } from '../runtime/react';
import './styles/config-audit.scss';

const VIEW_NODE = 'settingsaudit:view';

// UTC HH:MM:SS, prefixed with the UTC date only when the change wasn't today.
function formatWhen( ts ) {
	if ( ! ts ) {
		return '—';
	}
	const iso = new Date( ts * 1000 ).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
	const date = iso.slice( 0, 10 );
	const time = iso.slice( 11, 19 );
	const today = new Date().toISOString().slice( 0, 10 );
	return date === today ? time : `${ date } ${ time }`;
}

/**
 * Config Audit hub tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function ConfigAudit() {
	useSettingsAuditStream();
	const view = useNodeState( VIEW_NODE, 'view' );
	const entries = view?.entries ?? [];

	const [ filter, setFilter ] = useState( '' );
	const query = filter.trim().toLowerCase();
	const rows = query
		? entries.filter( ( e ) => e.option.toLowerCase().includes( query ) )
		: entries;

	return (
		<div
			className="nodes-config-audit"
			role="region"
			aria-label={ __( 'Config Audit', 'newspack-nodes' ) }
		>
			<div className="newspack-nodes-toolbar">
				<input
					type="text"
					className="newspack-nodes-search-input"
					placeholder={ __(
						'Filter option names…',
						'newspack-nodes'
					) }
					value={ filter }
					onChange={ ( e ) => setFilter( e.target.value ) }
				/>
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
			</div>

			<p className="nodes-config-audit__note">
				{ __(
					'Option names only — values are never logged.',
					'newspack-nodes'
				) }
			</p>

			{ 0 === rows.length ? (
				<p className="nodes-config-audit__empty">
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
				<table className="nodes-config-audit__table wp-list-table widefat striped">
					<thead>
						<tr>
							<th>{ __( 'Time (UTC)', 'newspack-nodes' ) }</th>
							<th>{ __( 'Option', 'newspack-nodes' ) }</th>
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
							</tr>
						) ) }
					</tbody>
				</table>
			) }
		</div>
	);
}
