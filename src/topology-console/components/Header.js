/**
 * Top header — brand, subtitle, cwd path selector, mode toggle.
 */

import { __ } from '@wordpress/i18n';

const VERSION =
	( window.NewspackNodesData && window.NewspackNodesData.version ) || '';
const HOST = window.location.hostname;

export default function Header( {
	pathOptions = [],
	path = '',
	onPathChange,
	streamStatus,
	uptime,
	mode = 'view',
	canEdit,
	onModeChange,
	onSave,
	onOpen,
	onNew,
	onDelete,
	canDelete,
	onSettings,
	settingsActive = false,
	theme,
	onThemeChange,
	themes = [],
	// When set, the LIVE button is replaced by an X close button (debug overlay).
	onClose,
} ) {
	return (
		<header className="topology-header">
			<div className="topology-brand">
				NEWSPACK<span className="topology-brand__colon">::</span>NODES
			</div>
			<div className="topology-subtitle">
				{ __( 'Topology Console', 'newspack-nodes' ) }
				{ VERSION ? ` · v${ VERSION }` : '' }
				{ ' · ' }
				{ HOST }
			</div>
			<div className="topology-header__controls">
				{ /* Path selector applies only to the live feed, not edit mode.
				     Also hidden when there's only one option to pick (the debug
				     overlay's local-only scope). */ }
				{ mode !== 'edit' && pathOptions.length > 1 && (
					<>
						<span className="topology-ctl-label">
							{ __( 'Path', 'newspack-nodes' ) }
						</span>
						<select
							className="topology-select"
							value={ path }
							onChange={ ( e ) =>
								onPathChange && onPathChange( e.target.value )
							}
						>
							{ /* The cwd can be moved by the REPL `cd` to a path not in
							     the menu (a deeper node, `_http/…`, etc.). Surface it as
							     an extra option so the control reflects the real cwd
							     instead of silently snapping to the first entry. */ }
							{ ( pathOptions.includes( path )
								? pathOptions
								: [ ...pathOptions, path ]
							).map( ( cwd ) => (
								<option key={ cwd } value={ cwd }>
									/{ cwd }
								</option>
							) ) }
						</select>
					</>
				) }
				{ /* Skin picker — global preference, shown in every mode. */ }
				<span className="topology-ctl-label">
					{ __( 'Skin', 'newspack-nodes' ) }
				</span>
				<select
					className="topology-select topology-select--skin"
					aria-label={ __( 'Skin', 'newspack-nodes' ) }
					value={ theme }
					onChange={ ( e ) =>
						onThemeChange && onThemeChange( e.target.value )
					}
				>
					{ themes.map( ( t ) => (
						<option key={ t.slug } value={ t.slug }>
							{ t.label }
						</option>
					) ) }
				</select>
				<div className="topology-mode">
					{ mode === 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--new"
							onClick={ () => onNew && onNew() }
						>
							{ __( 'NEW', 'newspack-nodes' ) }
						</button>
					) }
					{ mode === 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--open"
							onClick={ () => onOpen && onOpen() }
						>
							{ __( 'OPEN', 'newspack-nodes' ) }
						</button>
					) }
					{ mode === 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--save"
							onClick={ () => onSave && onSave() }
						>
							{ __( 'SAVE', 'newspack-nodes' ) }
						</button>
					) }
					{ mode === 'edit' && (
						<button
							type="button"
							className={ `topology-mode__btn topology-mode__btn--settings${
								settingsActive ? ' is-active' : ''
							}` }
							onClick={ () => onSettings && onSettings() }
							title={ __(
								'Topology settings (partitions and other frontmatter)',
								'newspack-nodes'
							) }
						>
							{ __( 'SETTINGS', 'newspack-nodes' ) }
						</button>
					) }
					{ mode === 'edit' && canDelete && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--delete"
							onClick={ () => onDelete && onDelete() }
							title={ __(
								'Delete this user-saved topology (stock copies are protected)',
								'newspack-nodes'
							) }
						>
							{ __( 'DELETE', 'newspack-nodes' ) }
						</button>
					) }
					{ /* NEW is available from live mode too (start a fresh
					     topology); the editor's NEW lives in the edit toolbar above. */ }
					{ mode !== 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--new"
							onClick={ () => onNew && onNew() }
						>
							{ __( 'NEW', 'newspack-nodes' ) }
						</button>
					) }
					{ canEdit && (
						<button
							type="button"
							className={ `topology-mode__btn${
								mode === 'edit' ? ' is-active' : ''
							}` }
							onClick={ () =>
								onModeChange && onModeChange( 'edit' )
							}
						>
							{ __( 'EDIT', 'newspack-nodes' ) }
						</button>
					) }
					{ onClose ? (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--close"
							onClick={ onClose }
							aria-label={ __( 'Close', 'newspack-nodes' ) }
							title={ __( 'Close', 'newspack-nodes' ) }
						>
							{ '×' }
						</button>
					) : (
						<button
							type="button"
							className={ `topology-mode__btn topology-mode__btn--live${
								mode === 'view' && streamStatus === 'open'
									? ' is-active'
									: ''
							}` }
							onClick={ () =>
								onModeChange && onModeChange( 'view' )
							}
						>
							<span
								className={ `topology-live-led${
									mode === 'view' && streamStatus === 'open'
										? ' is-pulsing'
										: ''
								}` }
							/>
							{ __( 'LIVE', 'newspack-nodes' ) }
							{ /* Always-rendered slot (em-dash until first uptime) so the button width is stable. */ }
							<span className="topology-uptime">
								{ uptime || '—' }
							</span>
						</button>
					) }
				</div>
			</div>
		</header>
	);
}
