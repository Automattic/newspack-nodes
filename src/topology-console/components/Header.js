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

/**
 * `window` carrying the payload PHP localizes before any bundle runs. `version`
 * is the plugin version the subtitle stamps, absent on a page that enqueued a
 * bundle without it.
 *
 * @typedef {Window & {
 *     NewspackNodesData?: { version?: string },
 * }} NodesDataWindow
 */

/** @type {NodesDataWindow} */
const NODES_WINDOW = window;

const VERSION =
	( NODES_WINDOW.NewspackNodesData &&
		NODES_WINDOW.NewspackNodesData.version ) ||
	'';
const HOST = window.location.hostname;

/**
 * The control cluster — path selector plus the mode and action buttons — with
 * no wrapper element, so a tab can portal it into the shared header's slot.
 *
 * Every prop is optional. The debug overlay passes only `mode` and `onClose`,
 * which swaps the whole button row for a single close X; every other handler
 * is guarded at its call site.
 *
 * @param {Object}                 props
 * @param {string[]}               [props.pathOptions]    Selectable cwds; the selector is hidden unless there are at least two.
 * @param {string}                 [props.path]           Current cwd. A value not in `pathOptions` (set by `cd`) is appended as an extra option.
 * @param {(path: string) => void} [props.onPathChange]   Called with the newly selected cwd.
 * @param {string}                 [props.streamStatus]   SSE status; `'open'` in view mode lights the LIVE LED.
 * @param {string|null}            [props.uptime]         Worker uptime for the LIVE button; an em-dash holds the slot until the first value.
 * @param {string}                 [props.mode]           `'view'` (live) or `'edit'` (editor); gates which buttons render.
 * @param {boolean}                [props.canEdit]        Whether the cwd resolves to a worker, so EDIT is offered.
 * @param {(mode: string) => void} [props.onModeChange]   Switch to `'edit'` or `'view'`.
 * @param {() => void}             [props.onSave]         SAVE: snapshot the live graph, or save the draft in edit mode.
 * @param {() => void}             [props.onDownload]     DOWNLOAD the editor topology as a .tsl file.
 * @param {(file: File) => void}   [props.onUpload]       Receives the .tsl the hidden file input picked up.
 * @param {() => void}             [props.onOpen]         OPEN the topology picker, which lands in edit mode.
 * @param {() => void}             [props.onNew]          NEW: start a blank topology.
 * @param {() => void}             [props.onDelete]       DELETE the current user-saved topology.
 * @param {boolean}                [props.canDelete]      Whether the current topology is user-saved, so DELETE renders.
 * @param {() => void}             [props.onSettings]     Toggle the topology settings panel.
 * @param {boolean}                [props.settingsActive] Whether that panel is open, which highlights SETTINGS.
 * @param {() => void}             [props.onClose]        Overlay only: renders a lone close X in place of the mode buttons.
 * @return {import('react').ReactElement} The controls, as a Fragment.
 */
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
					{ /* NEW + OPEN work from live too (OPEN lands you in edit).
					     The debug overlay has no editor and takes the onClose
					     branch above, so neither renders there without a guard.
					     Live is a PREFIX of edit — a control never moves on you. */ }
					<button
						type="button"
						className="topology-mode__btn topology-mode__btn--new"
						onClick={ () => onNew && onNew() }
					>
						{ __( 'NEW', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="topology-mode__btn topology-mode__btn--open"
						onClick={ () => onOpen && onOpen() }
					>
						{ __( 'OPEN', 'newspack-nodes' ) }
					</button>
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
 * Callback ref receiving the empty controls slot element, or null on unmount.
 * The hub hands it a `useState` setter so the active tab can portal into it.
 *
 * @typedef {import('react').RefCallback<HTMLDivElement>} ControlsSlotRef
 */

/**
 * @param {Object}          props
 * @param {boolean}         [props.showBrand]       Render the brand + subtitle (default true).
 * @param {boolean}         [props.showControls]    Render the controls cluster inline (default true).
 * @param {ControlsSlotRef} [props.controlsSlotRef] Callback ref for an EMPTY `.topology-header__controls` slot — when set, the active tab portals its controls in (the shared header), and the inline controls are not rendered.
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
