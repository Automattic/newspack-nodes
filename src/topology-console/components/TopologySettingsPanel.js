/**
 * TopologySettingsPanel — edit-mode read/write editor for a topology's
 * `var name = value` frontmatter. Recognized substrate keys render as typed
 * inputs; every other var is a generic name/value row. Commits the whole map
 * to onChange whenever it changes (empty values are filtered, never emitted).
 */

import { useState, createPortal } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

export const RECOGNIZED_KEYS = [ 'num_partitions', 'stale_timeout' ];
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_PARTITIONS = 16;

function toEntries( frontmatter ) {
	return Object.entries( frontmatter || {} ).map( ( [ name, value ] ) => [
		name,
		String( value ),
	] );
}

// Parse int: empty stays empty, non-numeric clears, numeric clamped [min,max].
function clampInt( raw, min, max ) {
	const trimmed = String( raw ).trim();
	if ( '' === trimmed ) {
		return '';
	}
	const n = parseInt( trimmed, 10 );
	if ( ! Number.isFinite( n ) ) {
		return '';
	}
	const floored = Math.max( min, n );
	return String( undefined === max ? floored : Math.min( max, floored ) );
}

// Frontmatter values are line-per-entry and `;`-delimited — no newlines/`;`.
function sanitizeValue( v ) {
	return String( v ).replace( /[\r\n;]/g, '' );
}

// Portal to the hub root so the panel z-index clears the header's context.
function getPortalTarget() {
	if ( typeof document === 'undefined' ) {
		return null;
	}
	return document.querySelector( '.nodes-devtools-hub' ) || document.body;
}

export default function TopologySettingsPanel( {
	frontmatter,
	configDefaultPartitions = 1,
	secureLevel = '',
	onChange,
	onSecureLevelChange = () => {},
	onClose,
} ) {
	// Seeded once per mount (the panel mounts on open, keyed by editing name).
	const [ entries, setEntries ] = useState( () => toEntries( frontmatter ) );
	const [ newName, setNewName ] = useState( '' );
	const [ newValue, setNewValue ] = useState( '' );
	const [ addError, setAddError ] = useState( '' );

	const valueOf = ( key ) => {
		const hit = entries.find( ( [ n ] ) => n === key );
		return hit ? hit[ 1 ] : '';
	};

	// Filter empty values so we never emit `var x =` (PHP wouldn't re-read it).
	const commit = ( next ) => {
		setEntries( next );
		const map = {};
		for ( const [ n, v ] of next ) {
			const tv = String( v ).trim();
			if ( '' !== tv ) {
				map[ n ] = tv;
			}
		}
		onChange( map );
	};

	// Set a key (recognized or generic). Preserves position if present.
	const setValue = ( key, value ) => {
		const existed = entries.some( ( [ n ] ) => n === key );
		if ( '' === value && ! existed ) {
			return;
		}
		commit(
			existed
				? entries.map( ( e ) =>
						e[ 0 ] === key ? [ key, value ] : e
				  )
				: [ ...entries, [ key, value ] ]
		);
	};

	const removeKey = ( key ) =>
		commit( entries.filter( ( [ n ] ) => n !== key ) );

	const addVar = () => {
		const name = newName.trim();
		if ( ! NAME_RE.test( name ) ) {
			setAddError(
				__(
					'Name must start with a letter or underscore and use only letters, numbers, and underscores.',
					'newspack-nodes'
				)
			);
			return;
		}
		const taken =
			RECOGNIZED_KEYS.includes( name ) ||
			entries.some( ( [ n ] ) => n === name );
		if ( taken ) {
			setAddError(
				sprintf(
					// translators: %s: variable name.
					__( '"%s" is already in use.', 'newspack-nodes' ),
					name
				)
			);
			return;
		}
		if ( '' === newValue.trim() ) {
			setAddError( __( 'Value cannot be empty.', 'newspack-nodes' ) );
			return;
		}
		commit( [ ...entries, [ name, sanitizeValue( newValue ) ] ] );
		setNewName( '' );
		setNewValue( '' );
		setAddError( '' );
	};

	const genericRows = entries.filter(
		( [ n ] ) => ! RECOGNIZED_KEYS.includes( n )
	);

	const panel = (
		<div
			className="topology-settings-panel"
			role="dialog"
			aria-label={ __( 'Topology settings', 'newspack-nodes' ) }
		>
			<div className="topology-settings-panel__head">
				<span>{ __( 'Topology settings', 'newspack-nodes' ) }</span>
				<button
					type="button"
					className="topology-settings-panel__close"
					onClick={ onClose }
					aria-label={ __( 'Close', 'newspack-nodes' ) }
				>
					×
				</button>
			</div>

			<label
				className="topology-settings-field"
				htmlFor="ts-num-partitions"
			>
				<span>{ __( 'Partitions', 'newspack-nodes' ) }</span>
				<input
					id="ts-num-partitions"
					type="number"
					min={ 1 }
					max={ MAX_PARTITIONS }
					value={ valueOf( 'num_partitions' ) }
					placeholder={ String( configDefaultPartitions ) }
					onChange={ ( e ) =>
						setValue(
							'num_partitions',
							clampInt( e.target.value, 1, MAX_PARTITIONS )
						)
					}
				/>
				<small>
					{ sprintf(
						// translators: %d: configured default partition count.
						__(
							'Empty = config default (%d). Max 16.',
							'newspack-nodes'
						),
						configDefaultPartitions
					) }
				</small>
			</label>

			<label
				className="topology-settings-field"
				htmlFor="ts-stale-timeout"
			>
				<span>{ __( 'Stale timeout (s)', 'newspack-nodes' ) }</span>
				<input
					id="ts-stale-timeout"
					type="number"
					min={ 1 }
					value={ valueOf( 'stale_timeout' ) }
					onChange={ ( e ) =>
						setValue(
							'stale_timeout',
							clampInt( e.target.value, 1 )
						)
					}
				/>
				<small>{ __( 'Empty = default.', 'newspack-nodes' ) }</small>
			</label>

			<label
				className="topology-settings-field"
				htmlFor="ts-secure-level"
			>
				<span>{ __( 'Secure level', 'newspack-nodes' ) }</span>
				<select
					id="ts-secure-level"
					value={ secureLevel }
					onChange={ ( e ) => onSecureLevelChange( e.target.value ) }
				>
					<option value="">
						{ __( 'Not declared', 'newspack-nodes' ) }
					</option>
					<option value="insecure">
						{ __( 'insecure — no restrictions', 'newspack-nodes' ) }
					</option>
					<option value="1">
						{ __( '1 — no graph construction', 'newspack-nodes' ) }
					</option>
					<option value="2">
						{ __( '2 — also no reply_to', 'newspack-nodes' ) }
					</option>
					<option value="3">
						{ __( '3 — also no re-wiring', 'newspack-nodes' ) }
					</option>
				</select>
				<small>
					{ __(
						'Written as the last line. Undeclared logs a warning each tick.',
						'newspack-nodes'
					) }
				</small>
			</label>

			<div className="topology-settings-vars">
				<div className="topology-settings-vars__title">
					{ __( 'Other variables', 'newspack-nodes' ) }
				</div>
				{ genericRows.map( ( [ name, value ] ) => (
					<div key={ name } className="topology-settings-var-row">
						<span className="topology-settings-var-row__name">
							{ name }
						</span>
						<input
							type="text"
							value={ value }
							aria-label={ sprintf(
								// translators: %s: variable name.
								__( 'Value for %s', 'newspack-nodes' ),
								name
							) }
							onChange={ ( e ) =>
								setValue(
									name,
									sanitizeValue( e.target.value )
								)
							}
						/>
						<button
							type="button"
							onClick={ () => removeKey( name ) }
							aria-label={ sprintf(
								// translators: %s: variable name.
								__( 'Remove %s', 'newspack-nodes' ),
								name
							) }
						>
							×
						</button>
					</div>
				) ) }
				<div className="topology-settings-var-row topology-settings-var-row--add">
					<input
						type="text"
						value={ newName }
						placeholder={ __( 'name', 'newspack-nodes' ) }
						aria-label={ __(
							'New variable name',
							'newspack-nodes'
						) }
						onChange={ ( e ) => setNewName( e.target.value ) }
					/>
					<input
						type="text"
						value={ newValue }
						placeholder={ __( 'value', 'newspack-nodes' ) }
						aria-label={ __(
							'New variable value',
							'newspack-nodes'
						) }
						onChange={ ( e ) => setNewValue( e.target.value ) }
					/>
					<button type="button" onClick={ addVar }>
						{ __( 'Add', 'newspack-nodes' ) }
					</button>
				</div>
				{ addError && (
					<div className="topology-settings-error" role="alert">
						{ addError }
					</div>
				) }
			</div>
		</div>
	);

	const target = getPortalTarget();
	return target ? createPortal( panel, target ) : panel;
}
