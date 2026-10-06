/**
 * One schema-driven argument input, shared by the edit-mode Inspector, its
 * verb-argument modals and the live-drop NewNodeModal. All of them read the
 * same `node_schema()` declaration, so all of them render the same widget for
 * a given argument: a picker for a formatter, a vault or a vault group, a
 * suggesting text input for a node path, typed text everywhere else, and a
 * reset control. A second implementation would drift from the schema the
 * others read.
 */

import { useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { NodePathInput } from './NodePathInput';

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
 *                                   `vault_id` and `vault_group` render
 *                                   pickers; `node_name`
 *                                   renders text suggesting the local nodes;
 *                                   `bool`, `int` and `float` render text with
 *                                   a narrowed keyboard; `json` renders a
 *                                   textarea.
 * @property {boolean} [required]    Marks the label with an asterisk.
 * @property {string}  [description] Label tooltip.
 * @property {*}       [default]     Stands in for a value the draft has not
 *                                   set, and shows as the placeholder once the
 *                                   field is an empty string.
 *                                   `serializeCtorArgs` substitutes it when
 *                                   the draft becomes a `make_node` line.
 */

/**
 * One entry of the credential store the `vault_id` and `vault_group`
 * pickers offer.
 *
 * @typedef  {Object} VaultEntry
 * @property {string} id      Vault key stored as a `vault_id` value.
 * @property {string} [url]   Remote URL, shown beside the id to disambiguate.
 *                            An entry without one renders as the bare id.
 * @property {string} [group] Its group, offered once as a `vault_group`
 *                            value; '' or absent offers none.
 */

/**
 * One argument picked from a registry the console holds: a `<select>` over
 * `options`, or free text while the registry is empty so an install with
 * nothing registered can still type the value. A stored value the registry
 * does not list stays selectable, so editing never blanks it.
 *
 * @param {Object}                  props           Component props.
 * @param {string}                  props.id        Input id.
 * @param {CtorArgSpec}             props.spec      Schema entry this field edits.
 * @param {*}                       [props.value]   Current value.
 * @param {(value: *) => void}      props.onChange  Receives the picked value.
 * @param {Array<[string, string]>} props.options   Value and label pairs.
 * @param {string}                  props.emptyText Placeholder with no options.
 * @param {string}                  props.pickText  Label of the blank option.
 * @return {import('react').ReactElement} The field row.
 */
function CatalogPicker( {
	id,
	spec,
	value,
	onChange,
	options,
	emptyText,
	pickText,
} ) {
	const current = value ?? '';
	const label = (
		<label
			htmlFor={ id }
			className="topology-edit-row__label"
			title={ spec.description || undefined }
		>
			{ spec.name }
			{ spec.required ? ' *' : '' }
		</label>
	);
	if ( options.length === 0 ) {
		return (
			<div className="topology-edit-row">
				{ label }
				<input
					id={ id }
					type="text"
					className="topology-edit-row__input"
					value={ current }
					placeholder={ emptyText }
					onChange={ ( e ) => onChange( e.target.value ) }
				/>
			</div>
		);
	}
	const known = options.some( ( [ option ] ) => option === current );
	return (
		<div className="topology-edit-row">
			{ label }
			<select
				id={ id }
				className="topology-edit-row__input"
				value={ current }
				onChange={ ( e ) => onChange( e.target.value ) }
			>
				<option value="">{ pickText }</option>
				{ '' !== current && ! known && (
					<option value={ current }>{ current }</option>
				) }
				{ options.map( ( [ option, text ] ) => (
					<option key={ option } value={ option }>
						{ text }
					</option>
				) ) }
			</select>
		</div>
	);
}

/**
 * Renders one argument row. The `formatter_name`, `vault_id` and
 * `vault_group` types get a `CatalogPicker`. A `node_name` gets a
 * `NodePathInput`: the value is a path the Router resolves, which may name a
 * node in another process, so the local nodes are suggested, never imposed.
 * `json` gets a textarea and every other type a text input. The reset control writes an
 * empty string rather than the default itself, which is what leaves
 * `serializeCtorArgs` free to substitute the schema default when the draft
 * becomes a `make_node` line.
 *
 * @param {Object}                     props              Component props.
 * @param {CtorArgSpec}                props.spec         Schema entry this field edits.
 * @param {*}                          [props.value]      Current value. A nullish
 *                                                        value puts `spec.default` in
 *                                                        the field; an empty string
 *                                                        shows it as the placeholder.
 * @param {(value: *) => void}         props.onChange     Receives the new value,
 *                                                        coerced to the declared type.
 * @param {string[]}                   [props.nodeNames]  Node names the `node_name`
 *                                                        input suggests.
 * @param {(refusal: ?string) => void} [props.onRefusal]  The refusal a
 *                                                        `node_name` input shows, or
 *                                                        null, as it changes.
 * @param {string[]}                   [props.formatters] Registered formatter names.
 * @param {VaultEntry[]}               [props.vaults]     Vault entries the `vault_id`
 *                                                        and `vault_group` pickers
 *                                                        offer.
 * @return {import('react').ReactElement} The field row.
 */
export function CtorField( {
	spec,
	value,
	onChange,
	onRefusal,
	nodeNames = [],
	formatters = [],
	vaults = [],
} ) {
	const meta = inputForType( spec.type );
	const id = `topology-ctor-${ spec.name }`;
	if ( 'formatter_name' === spec.type ) {
		return (
			<CatalogPicker
				id={ id }
				spec={ spec }
				value={ value }
				onChange={ onChange }
				options={ formatters.map( ( name ) => [ name, name ] ) }
				emptyText={ __(
					'(no formatters registered)',
					'newspack-nodes'
				) }
				pickText={ __( '(pick a formatter)', 'newspack-nodes' ) }
			/>
		);
	}
	if ( 'vault_id' === spec.type ) {
		return (
			<CatalogPicker
				id={ id }
				spec={ spec }
				value={ value }
				onChange={ onChange }
				options={ vaults.map( ( v ) => [
					v.id,
					v.url ? `${ v.id } — ${ v.url }` : v.id,
				] ) }
				emptyText={ __( '(no vault entries)', 'newspack-nodes' ) }
				pickText={ __( '(pick a vault)', 'newspack-nodes' ) }
			/>
		);
	}
	if ( 'vault_group' === spec.type ) {
		const groups = [
			...new Set( vaults.map( ( v ) => v.group ).filter( Boolean ) ),
		].sort();
		return (
			<CatalogPicker
				id={ id }
				spec={ spec }
				value={ value }
				onChange={ onChange }
				options={ groups.map( ( group ) => [ group, group ] ) }
				emptyText={ __( '(no vault groups)', 'newspack-nodes' ) }
				pickText={ __( '(pick a vault group)', 'newspack-nodes' ) }
			/>
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
				<NodePathInput
					id={ id }
					value={ String( value ?? '' ) }
					suggestions={ nodeNames }
					placeholder={ __( '(node or path)', 'newspack-nodes' ) }
					onChange={ onChange }
					onRefusal={ onRefusal }
				/>
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
				{ 'json' === spec.type ? (
					<textarea
						id={ id }
						rows={ 4 }
						className="topology-edit-row__input"
						value={ currentValue }
						onChange={ ( e ) => onChange( e.target.value ) }
					/>
				) : (
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
				) }
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

/**
 * The refusals a dialog's fields show, for a dialog that submits their values.
 *
 * A `node_name` field hands on only the paths it accepts, so while one shows a
 * refusal the dialog holds the last path accepted, not the one on screen. The
 * dialog gives each field `report( spec.name )` as its `onRefusal` and refuses
 * to submit, by click or by Enter, while `refused` is true.
 *
 * @return {[boolean, (name: string) => (refusal: ?string) => void]} Whether
 *         any field refuses, and the reporter each field takes.
 */
export function useFieldRefusals() {
	const [ refusing, setRefusing ] = useState( () => new Set() );
	const report = ( name ) => ( refusal ) =>
		setRefusing( ( prev ) => {
			if ( Boolean( refusal ) === prev.has( name ) ) {
				return prev;
			}
			const next = new Set( prev );
			if ( refusal ) {
				next.add( name );
			} else {
				next.delete( name );
			}
			return next;
		} );
	return [ refusing.size > 0, report ];
}
