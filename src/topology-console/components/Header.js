/**
 * Top header — brand, subtitle, cwd path selector, mode toggle.
 */

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
	theme,
	onThemeChange,
	themes = [],
} ) {
	return (
		<header className="topology-header">
			<div className="topology-brand">
				NEWSPACK<span className="topology-brand__colon">::</span>NODES
			</div>
			<div className="topology-subtitle">
				Topology Console
				{ VERSION ? ` · v${ VERSION }` : '' }
				{ ' · ' }
				{ HOST }
			</div>
			<div className="topology-header__controls">
				{ /* Path selector applies only to the live feed, not edit mode. */ }
				{ mode !== 'edit' && (
					<>
						<span className="topology-ctl-label">Path</span>
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
				<span className="topology-ctl-label">Skin</span>
				<select
					className="topology-select topology-select--skin"
					aria-label="Skin"
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
							NEW
						</button>
					) }
					{ mode === 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--open"
							onClick={ () => onOpen && onOpen() }
						>
							OPEN
						</button>
					) }
					{ mode === 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--save"
							onClick={ () => onSave && onSave() }
						>
							SAVE
						</button>
					) }
					{ mode === 'edit' && canDelete && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--delete"
							onClick={ () => onDelete && onDelete() }
							title="Delete this user-saved topology (stock copies are protected)"
						>
							DELETE
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
							EDIT
						</button>
					) }
					<button
						type="button"
						className={ `topology-mode__btn topology-mode__btn--live${
							mode === 'view' && streamStatus === 'open'
								? ' is-active'
								: ''
						}` }
						onClick={ () => onModeChange && onModeChange( 'view' ) }
					>
						<span
							className={ `topology-live-led${
								mode === 'view' && streamStatus === 'open'
									? ' is-pulsing'
									: ''
							}` }
						/>
						LIVE
						{ /* Always-rendered slot (em-dash until first uptime) so the button width is stable. */ }
						<span className="topology-uptime">
							{ uptime || '—' }
						</span>
					</button>
				</div>
			</div>
		</header>
	);
}
