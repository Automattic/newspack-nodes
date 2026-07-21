/**
 * Top header — brand, subtitle, cwd path selector, mode toggle.
 *
 * The brand/subtitle and the path/mode controls are split so the brand can be
 * the ONE shared header (hub + overlay) while each tab's controls render
 * separately: `HeaderControls` is the control cluster on its own (portaled into
 * the shared header's slot by whichever tab owns it), and `Header` composes the
 * brand + (its own controls, or an empty slot the active tab portals into).
 */

import { useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

const VERSION =
	( window.NewspackNodesData && window.NewspackNodesData.version ) || '';
const HOST = window.location.hostname;

// Path selector + mode/action buttons, sans wrapper, so a tab can portal them.
export function HeaderControls( {
	pathOptions = [],
	path = '',
	onPathChange,
	streamStatus,
	uptime,
	mode = 'view',
	canEdit,
	onModeChange,
	onSave,
	onDownload,
	onUpload,
	onOpen,
	onNew,
	onDelete,
	canDelete,
	onSettings,
	settingsActive = false,
	onClose,
} ) {
	// Hidden file input the UPLOAD button proxies its click onto.
	const uploadInputRef = useRef( null );
	return (
		<>
			{ /* Live feed only; hidden when there is a single option. */ }
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
						{ /* Surface a `cd`-set off-menu cwd as an extra option. */ }
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
			{ onClose ? (
				<div className="topology-overlay-mode">
					<button
						type="button"
						className="topology-mode__btn topology-mode__btn--close"
						onClick={ onClose }
						aria-label={ __( 'Close', 'newspack-nodes' ) }
						title={ __( 'Close', 'newspack-nodes' ) }
					>
						{ /* Inlined WP `close` X (@wordpress/icons is not a nodes dep). */ }
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
							focusable="false"
						>
							<path d="M13 11.8l6.1-6.3-1-1-6.1 6.2-6.1-6.2-1 1 6.1 6.3-6.5 6.7 1 1 6.5-6.6 6.5 6.6 1-1z" />
						</svg>
					</button>
				</div>
			) : (
				<div className="topology-mode">
					{ /* NEW + OPEN work from live too (OPEN lands you in edit);
					     neither belongs in the debug overlay, which has no editor.
					     Live is a PREFIX of edit — a control never moves on you. */ }
					{ ! onClose && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--new"
							onClick={ () => onNew && onNew() }
						>
							{ __( 'NEW', 'newspack-nodes' ) }
						</button>
					) }
					{ ! onClose && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--open"
							onClick={ () => onOpen && onOpen() }
						>
							{ __( 'OPEN', 'newspack-nodes' ) }
						</button>
					) }
					{ /* SAVE works from live too — it snapshots the live graph's
					     dump_config; in edit it saves the draft. Same slot in both. */ }
					<button
						type="button"
						className="topology-mode__btn topology-mode__btn--save"
						onClick={ () => onSave && onSave() }
					>
						{ __( 'SAVE', 'newspack-nodes' ) }
					</button>
					{ mode === 'edit' && (
						<button
							type="button"
							className="topology-mode__btn topology-mode__btn--download"
							onClick={ () => onDownload && onDownload() }
							title={ __(
								'Download the editor topology as a .tsl file',
								'newspack-nodes'
							) }
						>
							{ __( 'DOWNLOAD', 'newspack-nodes' ) }
						</button>
					) }
					{ mode === 'edit' && (
						<>
							<button
								type="button"
								className="topology-mode__btn topology-mode__btn--upload"
								onClick={ () =>
									uploadInputRef.current &&
									uploadInputRef.current.click()
								}
								title={ __(
									'Load a .tsl file into the editor (replaces the draft)',
									'newspack-nodes'
								) }
							>
								{ __( 'UPLOAD', 'newspack-nodes' ) }
							</button>
							<input
								ref={ uploadInputRef }
								type="file"
								accept=".tsl,text/plain"
								style={ { display: 'none' } }
								onChange={ ( e ) => {
									const file =
										e.target.files && e.target.files[ 0 ];
									if ( file && onUpload ) {
										onUpload( file );
									}
									// Re-fire when the same file is re-picked.
									e.target.value = '';
								} }
							/>
						</>
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
					{
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
					}
				</div>
			) }
		</>
	);
}

/**
 * @param {Object}   props
 * @param {boolean}  [props.showBrand]       Render the brand + subtitle (default true).
 * @param {boolean}  [props.showControls]    Render the controls cluster inline (default true).
 * @param {Function} [props.controlsSlotRef] Callback ref for an EMPTY `.topology-header__controls` slot — when set, the active tab portals its controls in (the shared header), and the inline controls are not rendered.
 * @return {import('react').ReactElement} The header.
 */
export default function Header( {
	showBrand = true,
	showControls = true,
	controlsSlotRef,
	...controlProps
} ) {
	return (
		<header className="topology-header">
			{ showBrand && (
				<>
					<div className="topology-brand">
						NEWSPACK
						<span className="topology-brand__colon">::</span>
						NODES
					</div>
					<div className="topology-subtitle">
						{ __( 'Topology Console', 'newspack-nodes' ) }
						{ VERSION ? ` · v${ VERSION }` : '' }
						{ ' · ' }
						{ HOST }
					</div>
				</>
			) }
			{ controlsSlotRef ? (
				// Shared header's slot: active tab portals its controls here.
				<div
					className="topology-header__controls"
					ref={ controlsSlotRef }
				/>
			) : (
				showControls && (
					<div className="topology-header__controls">
						<HeaderControls { ...controlProps } />
					</div>
				)
			) }
		</header>
	);
}
