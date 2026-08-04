/**
 * CtorField — one schema-driven constructor-argument input, shared by the
 * edit-mode Inspector and the live-drop NewNodeModal so both render the same
 * node_schema-enriched widgets (formatter/node pickers, typed text, reset-↺).
 */

import { __, sprintf } from '@wordpress/i18n';

/**
 * Attributes the `<input>` for a schema type needs. Every type stays a text
 * input — any argument may hold a `<config:...>` token — so the type only
 * narrows the on-screen keyboard or supplies a placeholder.
 *
 * @param {string} type Schema argument type (`bool`, `int`, `float`, …).
 */
function inputForType( type ) {
	switch ( type ) {
		case 'bool':
			// Text, not checkbox, so the field can hold a `<config:...>` token.
			return { type: 'text', placeholder: 'true | false | <config:...>' };
		// All types are text; loader coerces at runtime (tokens are strings).
		case 'int':
			return { type: 'text', inputMode: 'numeric' };
		case 'float':
			return { type: 'text', inputMode: 'decimal' };
		default:
			return { type: 'text' };
	}
}

/**
 * Coerces what the user typed to what the TSL loader expects for the declared
 * type. Only a complete number becomes a number: a `<config:...>` token, a
 * `<partition>` token, and a half-typed number all pass through as the string
 * they are, so editing never destroys input the loader would have accepted.
 *
 * @param {string} type Schema argument type (`bool`, `int`, `float`, …).
 * @param {*}      raw  Raw input value.
 * @return {*} A number for a complete `int`/`float`, `'true'`/`'false'` for a
 *             `bool`, otherwise the value as a string or passed through.
 */
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

/**
 * One constructor argument, as a node's `node_schema()` declares it.
 *
 * @typedef  {Object}  CtorArgSpec
 * @property {string}  name          Argument name; labels the row and keys the
 *                                   input id.
 * @property {string}  [type]        Picks the widget: `formatter_name`,
 *                                   `vault_id` and `node_name` render pickers;
 *                                   `bool`, `int` and `float` render text with
 *                                   a narrowed keyboard.
 * @property {boolean} [required]    Marks the label with an asterisk.
 * @property {string}  [description] Label tooltip.
 * @property {*}       [default]     Fills the placeholder while the field is
 *                                   empty.
 */

/**
 * One entry of the credential store the `vault_id` picker offers.
 *
 * @typedef  {Object} VaultEntry
 * @property {string} id    Vault key stored as the argument value.
 * @property {string} [url] Remote URL, shown beside the id to disambiguate.
 */

/**
 * Renders one constructor argument. The `formatter_name`, `vault_id` and
 * `node_name` types get a picker — each falling back to free text when its list
 * is empty — and every other type gets a text input, since any argument may
 * hold a `<config:...>` token that a checkbox or number input would reject.
 *
 * @param {Object}       props              Component props.
 * @param {CtorArgSpec}  props.spec         Schema entry this field edits.
 * @param {*}            [props.value]      Current value; `spec.default` fills
 *                                          the placeholder when it is empty.
 * @param {Function}     props.onChange     Receives the new value, coerced to
 *                                          the declared type.
 * @param {string[]}     [props.nodeNames]  Node names the `node_name` picker
 *                                          offers.
 * @param {string[]}     [props.formatters] Registered formatter names.
 * @param {VaultEntry[]} [props.vaults]     Vault entries the `vault_id` picker
 *                                          offers.
 * @return {import('react').ReactElement} The field row.
 */
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
					<label
						htmlFor={ id }
						className="topology-edit-row__label"
						title={ spec.description || undefined }
					>
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
				<label
					htmlFor={ id }
					className="topology-edit-row__label"
					title={ spec.description || undefined }
				>
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
		// Registered Vault entries; empty list falls back to free text.
		if ( vaults.length === 0 ) {
			return (
				<div className="topology-edit-row">
					<label
						htmlFor={ id }
						className="topology-edit-row__label"
						title={ spec.description || undefined }
					>
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
		// Preserve a stored value not in the list so editing never blanks it.
		const current = value ?? '';
		const known = vaults.some( ( v ) => v.id === current );
		return (
			<div className="topology-edit-row">
				<label
					htmlFor={ id }
					className="topology-edit-row__label"
					title={ spec.description || undefined }
				>
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
				<label
					htmlFor={ id }
					className="topology-edit-row__label"
					title={ spec.description || undefined }
				>
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
			<label
				htmlFor={ id }
				className="topology-edit-row__label"
				title={ spec.description || undefined }
			>
				{ spec.name }
				{ spec.required ? ' *' : '' }
			</label>
			<div className="topology-edit-row__input-wrap">
				<input
					id={ id }
					type={ meta.type }
					inputMode={
						/** @type {'numeric'|'decimal'|undefined} */ (
							meta.inputMode
						)
					}
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
						className="button is-plain topology-edit-row__reset"
						aria-label={ sprintf(
							// translators: %s: constructor-argument name.
							__( 'Reset %s to its default', 'newspack-nodes' ),
							spec.name
						) }
						onClick={ () => onChange( '' ) }
					>
						↺
					</button>
				) }
			</div>
		</div>
	);
}
