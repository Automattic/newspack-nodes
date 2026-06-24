/**
 * Top header — brand, subtitle, cwd path selector, mode toggle.
 *
 * The brand/subtitle and the path/mode controls are split so the brand can be
 * the ONE shared header (hub + overlay) while each tab's controls render
 * separately: `HeaderControls` is the control cluster on its own (portaled into
 * the shared header's slot by whichever tab owns it), and `Header` composes the
 * brand + (its own controls, or an empty slot the active tab portals into).
 */

import { __ } from '@wordpress/i18n';

const VERSION =
	( window.NewspackNodesData && window.NewspackNodesData.version ) || '';
const HOST = window.location.hostname;

// The path selector + mode/action buttons — the contents of
// `.topology-header__controls`, without the wrapper, so the active tab can
// portal it into the shared header's slot (which IS the
// `.topology-header__controls` element). Same props as Header's controls.
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
	onOpen,
	onNew,
	onDelete,
	canDelete,
	onSettings,
	settingsActive = false,
	onClose,
} ) {
	return (
		<>
			{ /* Path selector applies only to the live feed, not edit mode. Also
			     hidden when there's only one option (the overlay's local scope). */ }
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
						     the menu; surface it as an extra option so the control
						     reflects the real cwd instead of snapping to the first. */ }
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
				{ /* NEW is available from live mode too (start a fresh topology);
				     the editor's NEW lives in the edit toolbar above. Not in the
				     debug overlay (onClose), which has no editor to land in. */ }
				{ mode !== 'edit' && ! onClose && (
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
						onClick={ () => onModeChange && onModeChange( 'edit' ) }
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
						{ /* The standard WP `close` icon (the X ELN/pyrobase
						     modals use), inlined since @wordpress/icons isn't a
						     nodes dependency. */ }
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
							focusable="false"
						>
							<path d="M13 11.8l6.1-6.3-1-1-6.1 6.2-6.1-6.2-1 1 6.1 6.3-6.5 6.7 1 1 6.5-6.6 6.5 6.6 1-1z" />
						</svg>
					</button>
				) : (
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
						{ __( 'LIVE', 'newspack-nodes' ) }
						{ /* Always-rendered slot (em-dash until first uptime) so the button width is stable. */ }
						<span className="topology-uptime">
							{ uptime || '—' }
						</span>
					</button>
				) }
			</div>
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
				// The shared header's slot: the active tab portals its controls here.
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
