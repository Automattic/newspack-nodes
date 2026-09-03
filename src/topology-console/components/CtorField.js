/**
 * One schema-driven argument input, shared by the edit-mode Inspector, its
 * verb-argument modals and the live-drop NewNodeModal. All of them read the
 * same `node_schema()` declaration, so all of them render the same widget for
 * a given argument: a picker for the three name types, typed text everywhere
 * else, and a reset control. A second implementation would drift from the
 * schema the others read.
 */

import { __, sprintf } from '@wordpress/i18n';

/**
 * Attributes the `<input>` for a schema type needs. Every type renders a text
 * input, because any argument may hold a `<config:...>` token a checkbox or a
 * number input would reject, and the loader coerces each token to its declared
 * type when the node is constructed. The type only narrows the on-screen
 * keyboard or supplies a placeholder.
 *
 * @param {string} type Schema argument type (`bool`, `int`, `float`, …).
 */
function inputForType( type ) {
	switch ( type ) {
		case 'bool':
			return { type: 'text', placeholder: 'true | false | <config:...>' };
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
 * @param {*}      raw  Raw input value. A field hands over a string; a stored
 *                      argument can arrive as a JSON boolean.
 * @return {*} A number for a complete `int` or `float`, `''` for an empty
 *             numeric field, `'true'`/`'false'` for a JS boolean, and the
 *             string form of anything else.
 */
export function coerceValue( type, raw ) {
	if ( 'bool' === type ) {
		if ( 'boolean' === typeof raw ) {
			return raw ? 'true' : 'false';
		}
		return String( raw ?? '' );
	}
	if ( 'int' === type ) {
		if ( '' === raw ) {
			return '';
		}
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
 * One constructor argument, as a node's `node_schema()` declares it. A verb
 * argument carries the same shape, which is what lets the verb modals render
 * their arguments through this component too.
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
 * @property {*}       [default]     Stands in for a value the draft has not
 *                                   set, and shows as the placeholder once the
 *                                   field is an empty string.
 *                                   `serializeCtorArgs` substitutes it when
 *                                   the draft becomes a `make_node` line.
 */

/**
 * One entry of the credential store the `vault_id` picker offers.
 *
 * @typedef  {Object} VaultEntry
 * @property {string} id    Vault key stored as the argument value.
 * @property {string} [url] Remote URL, shown beside the id to disambiguate.
 *                          An entry without one renders as the bare id.
 */

/**
 * Renders one argument row. The `formatter_name`, `vault_id` and `node_name`
 * types get a picker, each falling back to free text when its list is empty so
 * an install with nothing registered can still type the value; every other
 * type gets a text input. The reset control writes an empty string rather than
 * the default itself, which is what leaves `serializeCtorArgs` free to
 * substitute the schema default when the draft becomes a `make_node` line.
 *
 * @param {Object}             props              Component props.
 * @param {CtorArgSpec}        props.spec         Schema entry this field edits.
 * @param {*}                  [props.value]      Current value. A nullish
 *                                                value puts `spec.default` in
 *                                                the field; an empty string
 *                                                shows it as the placeholder.
 * @param {(value: *) => void} props.onChange     Receives the new value,
 *                                                coerced to the declared type.
 * @param {string[]}           [props.nodeNames]  Node names the `node_name`
 *                                                picker offers.
 * @param {string[]}           [props.formatters] Registered formatter names.
 * @param {VaultEntry[]}       [props.vaults]     Vault entries the `vault_id`
 *                                                picker offers.
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
		// A node_name verb arg also draws a virtual edge on the canvas.
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
	// A stored arg can be a JSON boolean; the field shows "true"/"false".
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
