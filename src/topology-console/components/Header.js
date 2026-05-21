/**
 * Top header — brand, subtitle, topology+partition selectors, mode toggle.
 */

const VERSION =
	( window.NewspackNodesData && window.NewspackNodesData.version ) || '';
const HOST = window.location.hostname;

export default function Header( {
	topologies,
	topology,
	onTopologyChange,
	partitions,
	partition,
	onPartitionChange,
	streamStatus,
	uptime,
	mode = 'view',
	onModeChange,
	onSave,
	onOpen,
	onNew,
	onDelete,
	canDelete,
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
				{ /* Selectors apply only to the live feed, not edit mode. */ }
				{ mode !== 'edit' && (
					<>
						<span className="topology-ctl-label">Topology</span>
						<select
							className="topology-select"
							value={ topology }
							onChange={ ( e ) =>
								onTopologyChange( e.target.value )
							}
						>
							{ topologies.map( ( t ) => (
								<option key={ t } value={ t }>
									{ t }
								</option>
							) ) }
						</select>
						<span className="topology-ctl-label">Partition</span>
						<select
							className="topology-select"
							value={ String( partition ) }
							onChange={ ( e ) =>
								onPartitionChange(
									parseInt( e.target.value, 10 )
								)
							}
						>
							{ partitions.map( ( p ) => (
								<option key={ p } value={ String( p ) }>
									p{ p }
								</option>
							) ) }
						</select>
					</>
				) }
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
					<button
						type="button"
						className={ `topology-mode__btn${
							mode === 'edit' ? ' is-active' : ''
						}` }
						onClick={ () => onModeChange && onModeChange( 'edit' ) }
					>
						EDIT
					</button>
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
