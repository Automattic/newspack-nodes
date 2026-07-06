/**
 * CtorField — one schema-driven constructor-argument input, shared by the
 * edit-mode Inspector and the live-drop NewNodeModal so both render the same
 * node_schema-enriched widgets (formatter/node pickers, typed text, clear-×).
 */

import { __, sprintf } from '@wordpress/i18n';

function inputForType( type ) {
	switch ( type ) {
		case 'bool':
			// Text, not checkbox, so the field can hold a `<config:...>` token.
			return { type: 'text', placeholder: 'true | false | <config:...>' };
		// All types are text: substitution tokens are strings an
		// `input type="number"` would reject; loader coerces at runtime.
		case 'int':
			return { type: 'text', inputMode: 'numeric' };
		case 'float':
			return { type: 'text', inputMode: 'decimal' };
		default:
			return { type: 'text' };
	}
}

export function coerceValue( type, raw ) {
	if ( 'bool' === type ) {
		// Store strings as-is; normalize legacy JS booleans to "true"/"false".
		if ( 'boolean' === typeof raw ) {
			return raw ? 'true' : 'false';
		}
		return String( raw ?? '' );
	}
	if ( 'int' === type ) {
		if ( '' === raw ) {
			return '';
		}
		// Pure-integer strings → number; tokens/partial input pass through.
		return /^-?\d+$/.test( String( raw ).trim() )
			? parseInt( raw, 10 )
			: raw;
	}
	if ( 'float' === type ) {
		if ( '' === raw ) {
			return '';
		}
		return /^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test( String( raw ).trim() )
			? parseFloat( raw )
			: raw;
	}
	return String( raw );
}

export function CtorField( {
	spec,
	value,
	onChange,
	nodeNames = [],
	formatters = [],
	vaults = [],
} ) {
	const meta = inputForType( spec.type );
	const id = `topology-ctor-${ spec.name }`;
	if ( 'formatter_name' === spec.type ) {
		// Pick from registered formatters; empty list falls back to free text.
		if ( formatters.length === 0 ) {
			return (
				<div className="topology-edit-row">
					<label htmlFor={ id } className="topology-edit-row__label">
						{ spec.name }
						{ spec.required ? ' *' : '' }
					</label>
					<input
						id={ id }
						type="text"
						className="topology-edit-row__input"
						value={ value ?? '' }
						placeholder={ __(
							'(no formatters registered)',
							'newspack-nodes'
						) }
						onChange={ ( e ) => onChange( e.target.value ) }
					/>
				</div>
			);
		}
		return (
			<div className="topology-edit-row">
				<label htmlFor={ id } className="topology-edit-row__label">
					{ spec.name }
					{ spec.required ? ' *' : '' }
				</label>
				<select
					id={ id }
					className="topology-edit-row__input"
					value={ value ?? '' }
					onChange={ ( e ) => onChange( e.target.value ) }
				>
					<option value="">
						{ __( '(pick a formatter)', 'newspack-nodes' ) }
					</option>
					{ formatters.map( ( name ) => (
						<option key={ name } value={ name }>
							{ name }
						</option>
					) ) }
				</select>
			</div>
		);
	}
	if ( 'vault_id' === spec.type ) {
		// Pick from registered Vault entries; empty list falls back to free
		// text so a `<config:...>` token or not-yet-created id can be typed.
		if ( vaults.length === 0 ) {
			return (
				<div className="topology-edit-row">
					<label htmlFor={ id } className="topology-edit-row__label">
						{ spec.name }
						{ spec.required ? ' *' : '' }
					</label>
					<input
						id={ id }
						type="text"
						className="topology-edit-row__input"
						value={ value ?? '' }
						placeholder={ __(
							'(no vault entries)',
							'newspack-nodes'
						) }
						onChange={ ( e ) => onChange( e.target.value ) }
					/>
				</div>
			);
		}
		// Preserve a stored value that isn't in the fetched list (config-file
		// entry or a hand-typed token) so editing never silently blanks it.
		const current = value ?? '';
		const known = vaults.some( ( v ) => v.id === current );
		return (
			<div className="topology-edit-row">
				<label htmlFor={ id } className="topology-edit-row__label">
					{ spec.name }
					{ spec.required ? ' *' : '' }
				</label>
				<select
					id={ id }
					className="topology-edit-row__input"
					value={ current }
					onChange={ ( e ) => onChange( e.target.value ) }
				>
					<option value="">
						{ __( '(pick a vault)', 'newspack-nodes' ) }
					</option>
					{ '' !== current && ! known && (
						<option value={ current }>{ current }</option>
					) }
					{ vaults.map( ( v ) => (
						<option key={ v.id } value={ v.id }>
							{ v.url ? `${ v.id } — ${ v.url }` : v.id }
						</option>
					) ) }
				</select>
			</div>
		);
	}
	if ( 'node_name' === spec.type ) {
		// node_name args define a logical edge synthesized onto the canvas.
		return (
			<div className="topology-edit-row">
				<label htmlFor={ id } className="topology-edit-row__label">
					{ spec.name }
					{ spec.required ? ' *' : '' }
				</label>
				<select
					id={ id }
					className="topology-edit-row__input"
					value={ value ?? '' }
					onChange={ ( e ) => onChange( e.target.value ) }
				>
					<option value="">
						{ __( '(pick a node)', 'newspack-nodes' ) }
					</option>
					{ nodeNames.map( ( name ) => (
						<option key={ name } value={ name }>
							{ name }
						</option>
					) ) }
				</select>
			</div>
		);
	}
	// Normalize legacy JS-boolean bool args to "true"/"false" strings.
	const rawValue = value ?? spec.default ?? '';
	let currentValue = rawValue;
	if ( 'boolean' === typeof rawValue ) {
		currentValue = rawValue ? 'true' : 'false';
	}
	const hasContent = String( currentValue ).length > 0;
	return (
		<div className="topology-edit-row">
			<label htmlFor={ id } className="topology-edit-row__label">
				{ spec.name }
				{ spec.required ? ' *' : '' }
			</label>
			<div className="topology-edit-row__input-wrap">
				<input
					id={ id }
					type={ meta.type }
					inputMode={ meta.inputMode }
					step={ meta.step }
					className="topology-edit-row__input"
					value={ currentValue }
					placeholder={
						meta.placeholder ??
						( spec.default !== undefined
							? String( spec.default )
							: '' )
					}
					onChange={ ( e ) =>
						onChange( coerceValue( spec.type, e.target.value ) )
					}
				/>
				{ hasContent && (
					<button
						type="button"
						className="topology-edit-row__clear"
						aria-label={ sprintf(
							// translators: %s: constructor-argument name.
							__( 'Clear %s', 'newspack-nodes' ),
							spec.name
						) }
						onClick={ () => onChange( '' ) }
					>
						×
					</button>
				) }
			</div>
		</div>
	);
}
