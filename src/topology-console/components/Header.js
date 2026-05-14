/**
 * Top header — brand, subtitle, topology+partition selectors, mode toggle.
 *
 * The mode toggle is inert in v1 (LIVE is the only available mode;
 * EDIT is a v2 affordance). The pulsing LED dot on the LIVE button
 * doubles as a connection-health indicator.
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
				<span className="topology-ctl-label">Topology</span>
				<select
					className="topology-select"
					value={ topology }
					onChange={ ( e ) => onTopologyChange( e.target.value ) }
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
						onPartitionChange( parseInt( e.target.value, 10 ) )
					}
				>
					{ partitions.map( ( p ) => (
						<option key={ p } value={ String( p ) }>
							p{ p }
						</option>
					) ) }
				</select>
				<div className="topology-mode">
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
						{ /* Always-rendered right-aligned slot — shows an
						em-dash until the first `gui:uptime` poll lands
						(~5s after connect) so the button width doesn't
						jump on first appearance. Spatial separation is
						provided by the flex layout instead of a bullet. */ }
						<span className="topology-uptime">
							{ uptime || '—' }
						</span>
					</button>
				</div>
			</div>
		</header>
	);
}
