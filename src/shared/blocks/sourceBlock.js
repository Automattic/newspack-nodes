/**
 * The one shape every substrate block that reads a source takes: its View
 * reads the source its `source` attribute names, with the page state that
 * source declares as its params, and shows it through the block's own
 * `Render` once a model stands, the read error or a loading line before.
 * Its Controls pick the source by its label, the fields by theirs and the
 * block's own settings by their declared schemas, in the block inspector,
 * writing the fields' keys. A stream renders at once, because its rows
 * arrive in its view node rather than its model. A block with no source
 * asks for one.
 *
 * A source declares its `params` as page-state keys and its `fields` as
 * `{ key: { label, kind, format?, formatFor? } }`, so a block names no
 * consumer, labels each field as the source does, and shows only the fields
 * of its own kind.
 */

import {
	FormTokenField,
	SelectControl,
	TextControl,
	ToggleControl,
} from '@wordpress/components';
import { useMemo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { usePageState } from '../composition/page/pageState';
import { declaredSources, sourceDeclaration, useSource } from '../sources';
import Skeleton from '../components/Skeleton';
import Unread from '../components/Unread';

/**
 * One field a block shows, as its source declares it.
 *
 * @typedef  {Object}                   BlockField
 * @property {string}                key         The model's key.
 * @property {string}                label       The declared label.
 * @property {string}                kind        The declared kind.
 * @property {(value: *) => *}       [format]    The declared formatter.
 * @property {(peak: number) => *}   [formatFor] A chart field's axis formatter for a peak.
 * @property {string}                [axis]      A chart field's axis title.
 * @property {(model: Object) => *}  [value]     Derives the field from the model.
 * @property {(value: *) => string}  [modifier]  Names a tile's `nodes-card--<modifier>`.
 * @property {(value: *) => boolean} [shown]     False leaves the figure out.
 * @property {(row: Object) => *}    [cell]      A log column's whole cell.
 * @property {string}                [width]     A log column's grid track.
 * @property {string}                [tooltip]   A log column's header hover text.
 */

/**
 * How a block built by `sourceBlock()` reads its attributes.
 *
 * @typedef  {Object}   BlockShape
 * @property {string}   kind       The kind of field it shows.
 * @property {string}   list       The attribute naming its fields: a list, or one name.
 * @property {string[]} [settings] Its other attributes the inspector edits.
 */

/** The words each setting a block's inspector edits is labelled with. */
const SETTING_LABELS = {
	title: __( 'Title', 'newspack-nodes' ),
	description: __( 'Description', 'newspack-nodes' ),
	columns: __( 'Tiles per row', 'newspack-nodes' ),
	perPage: __( 'Rows per page', 'newspack-nodes' ),
	stacked: __( 'Stack the series', 'newspack-nodes' ),
	toolbar: __( 'Toolbar', 'newspack-nodes' ),
};

/** The words each choice of a setting with a fixed set of values reads as. */
const SETTING_CHOICES = {
	toolbar: {
		inline: __( 'In the block', 'newspack-nodes' ),
		header: __( 'In the page header', 'newspack-nodes' ),
	},
};

/** What every control in a block's inspector takes. */
const CONTROL = {
	__next40pxDefaultSize: true,
	__nextHasNoMarginBottom: true,
};

/**
 * The fields a block names, as a list whether its attribute holds a list or
 * one name.
 *
 * @param {string|string[]} named The attribute's value.
 * @return {string[]} The names.
 */
const namesOf = ( named ) => {
	if ( Array.isArray( named ) ) {
		return named;
	}
	return named ? [ named ] : [];
};

/**
 * The fields a block names, in its order, each as the source declares it;
 * every declared field of the block's kind, in declared order, when it names
 * none. Given a model, a field whose `shown` answers false for its value
 * there is left out.
 *
 * @param {string}   source  The source.
 * @param {string[]} names   The fields named.
 * @param {string}   kind    The kind the block shows.
 * @param {?Object}  [model] The model the fields are shown for.
 * @return {BlockField[]} The fields; at least one unless a model is given.
 * @throws {Error} Naming a field the source does not declare, one of another
 *                 kind, or a source with no field to show.
 */
export function namedFields( source, names, kind, model = null ) {
	const decl = sourceDeclaration( source );
	const fields = decl.fields ?? {};
	const keys = names.length
		? names
		: fieldsOfKind( decl, kind ).map( ( [ key ] ) => key );
	const named = keys.map( ( key ) => {
		if ( ! Object.hasOwn( fields, key ) ) {
			throw new Error( `${ source } declares no field '${ key }'` );
		}
		if ( kind !== fields[ key ].kind ) {
			throw new Error(
				`${ source } field '${ key }' is a ${ fields[ key ].kind }, not a ${ kind }`
			);
		}
		return { key, ...fields[ key ] };
	} );
	if ( 0 === named.length ) {
		throw new Error( `${ source } declares no field to show` );
	}
	return null === model
		? named
		: named.filter( ( field ) => isShown( field, model ) );
}

/**
 * Whether a field shows for a model: unless its `shown` answers false for
 * its value there.
 *
 * @param {BlockField} field The field.
 * @param {Object}     model The model.
 * @return {boolean} Whether it shows.
 */
const isShown = ( field, model ) =>
	! field.shown || field.shown( fieldValue( field, model ) );

/**
 * Each model's derived fields, by key, so a field is derived once a model
 * however many blocks show it.
 *
 * @type {WeakMap<Object, Map<string, *>>}
 */
const derived = new WeakMap();

/**
 * A field's value in a model: what its `value( model )` derives, once per
 * model, or the model's own key; nothing for no model.
 *
 * @param {BlockField} field The field.
 * @param {?Object}    model The source's model.
 * @return {*} The value.
 */
export function fieldValue( field, model ) {
	if ( ! model ) {
		return undefined;
	}
	if ( ! field.value ) {
		return model[ field.key ];
	}
	if ( ! derived.has( model ) ) {
		derived.set( model, new Map() );
	}
	const values = derived.get( model );
	if ( ! values.has( field.key ) ) {
		values.set( field.key, field.value( model ) );
	}
	return values.get( field.key );
}

/**
 * A value as its field shows it.
 *
 * @param {BlockField} field The field.
 * @param {*}          value The value.
 * @return {*} What the block shows.
 */
export const display = ( field, value ) =>
	field.format ? field.format( value ) : String( value ?? '' );

/**
 * The params a source is read with: each page-state key it declares, by its
 * value now. The keys are fixed for a source, and a block remounts when its
 * source changes, so the hooks run in one order for the block's life.
 *
 * @param {string[]} keys The page-state keys.
 * @return {Object<string,*>} Key => value.
 */
function usePageParams( keys ) {
	const params = {};
	for ( const key of keys ) {
		// eslint-disable-next-line react-hooks/rules-of-hooks -- keys fixed per mount
		params[ key ] = usePageState( key )[ 0 ];
	}
	return params;
}

/**
 * A number a box holds, held to its schema's bounds, or null for a box
 * holding none.
 *
 * @param {string} typed  What the box holds.
 * @param {Object} schema The attribute's schema.
 * @return {?number} The number.
 */
function boundedNumber( typed, schema ) {
	const number = Number.parseInt( typed, 10 );
	if ( Number.isNaN( number ) ) {
		return null;
	}
	return Math.min(
		schema.maximum ?? Infinity,
		Math.max( schema.minimum ?? -Infinity, number )
	);
}

/**
 * A control for each setting named, by the type its declared schema names:
 * a toggle for a boolean, a select of its choices for an enum, a number box
 * held to its bounds for an integer, a text box otherwise.
 *
 * @param {Object}                 props
 * @param {string[]}               props.names         The settings.
 * @param {Object}                 props.attributes    The block's attributes.
 * @param {(next: Object) => void} props.setAttributes Writes them.
 * @param {Object<string,Object>}  props.schema        Each attribute's declared schema.
 * @return {import('react').ReactElement[]} The controls.
 */
export function SettingControls( {
	names,
	attributes,
	setAttributes,
	schema,
} ) {
	return names.map( ( name ) => {
		const declared = schema[ name ];
		const label = SETTING_LABELS[ name ];
		if ( 'boolean' === declared.type ) {
			return (
				<ToggleControl
					key={ name }
					__nextHasNoMarginBottom
					label={ label }
					checked={ attributes[ name ] }
					onChange={ ( next ) => setAttributes( { [ name ]: next } ) }
				/>
			);
		}
		if ( declared.enum ) {
			return (
				<SelectControl
					key={ name }
					{ ...CONTROL }
					label={ label }
					value={ attributes[ name ] }
					options={ declared.enum.map( ( value ) => ( {
						label: SETTING_CHOICES[ name ]?.[ value ] ?? value,
						value,
					} ) ) }
					onChange={ ( next ) => setAttributes( { [ name ]: next } ) }
				/>
			);
		}
		if ( 'integer' === declared.type ) {
			return (
				<TextControl
					key={ name }
					{ ...CONTROL }
					type="number"
					label={ label }
					value={ attributes[ name ] }
					min={ declared.minimum }
					max={ declared.maximum }
					onChange={ ( typed ) => {
						const next = boundedNumber( typed, declared );
						if ( null !== next ) {
							setAttributes( { [ name ]: next } );
						}
					} }
				/>
			);
		}
		return (
			<TextControl
				key={ name }
				{ ...CONTROL }
				label={ label }
				value={ attributes[ name ] }
				onChange={ ( next ) => setAttributes( { [ name ]: next } ) }
			/>
		);
	} );
}

/**
 * The fields of one kind a declaration holds, by key.
 *
 * @param {Object} decl A source's declaration.
 * @param {string} kind The kind.
 * @return {Array<[string, Object]>} `[ key, field ]` pairs.
 */
const fieldsOfKind = ( decl, kind ) =>
	Object.entries( decl.fields ?? {} ).filter(
		( [ , field ] ) => kind === field.kind
	);

/**
 * Build a block's View and inspector Controls over the source its
 * attributes name.
 *
 * @param {import('react').ComponentType<{attributes: Object, model: *, fields: BlockField[], stream?: Object}>} Render Shows the model.
 * @param {BlockShape}                                                                                           shape  How the block reads its attributes.
 * @return {import('../composition/CompositionView').CompositionBlockView} The View and Controls.
 */
export function sourceBlock( Render, { kind, list, settings = [] } ) {
	/**
	 * @param {{attributes: Object}} props The block's attributes.
	 * @return {import('react').ReactElement} The block.
	 */
	function Read( { attributes } ) {
		const names = namesOf( attributes[ list ] );
		const { params = [] } = sourceDeclaration( attributes.source );
		const { model, error, stream } = useSource(
			attributes.source,
			usePageParams( params )
		);
		const fields = useMemo(
			() => namedFields( attributes.source, names, kind, model ),
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the joined names key the list
			[ attributes.source, names.join( ',' ), kind, model ]
		);
		if ( error ) {
			return <Unread error={ error } />;
		}
		if ( null === model && ! stream ) {
			return <Skeleton shape="line" count={ 1 } />;
		}
		return (
			<Render
				attributes={ attributes }
				model={ model }
				fields={ fields }
				stream={ stream }
			/>
		);
	}

	/**
	 * @param {{attributes: Object, editing: boolean}} props The block's attributes.
	 * @return {import('react').ReactElement} The block, read afresh for a new source.
	 */
	function View( { attributes } ) {
		if ( ! attributes.source ) {
			return (
				<p className="newspack-nodes-empty-state">
					{ __(
						'Choose a source in the block settings.',
						'newspack-nodes'
					) }
				</p>
			);
		}
		return <Read key={ attributes.source } attributes={ attributes } />;
	}

	/**
	 * @param {Object}                 props
	 * @param {Object}                 props.attributes    The block's attributes.
	 * @param {(next: Object) => void} props.setAttributes Writes them.
	 * @param {Object<string,Object>}  props.schema        Each attribute's declared schema.
	 * @return {import('react').ReactElement} The controls.
	 */
	function Controls( { attributes, setAttributes, schema } ) {
		const sources = declaredSources().filter(
			( [ , decl ] ) => fieldsOfKind( decl, kind ).length
		);
		const decl = new Map( sources ).get( attributes.source );
		const offered = decl ? fieldsOfKind( decl, kind ) : [];
		const labels = Object.fromEntries(
			offered.map( ( [ key, field ] ) => [ key, field.label ] )
		);
		const keys = Object.fromEntries(
			offered.map( ( [ key, field ] ) => [ field.label, key ] )
		);
		const many = Array.isArray( attributes[ list ] );
		return (
			<>
				<SelectControl
					{ ...CONTROL }
					label={ __( 'Source', 'newspack-nodes' ) }
					value={ attributes.source }
					options={ [
						{
							label: __( 'Choose a source', 'newspack-nodes' ),
							value: '',
						},
						...sources.map( ( [ name, source ] ) => ( {
							label: source.label ?? name,
							value: name,
						} ) ),
					] }
					onChange={ ( source ) =>
						setAttributes( { source, [ list ]: many ? [] : '' } )
					}
				/>
				{ decl && many && (
					<FormTokenField
						{ ...CONTROL }
						label={ __( 'Fields', 'newspack-nodes' ) }
						value={ attributes[ list ].map(
							( key ) => labels[ key ] ?? key
						) }
						suggestions={ Object.keys( keys ) }
						__experimentalExpandOnFocus
						__experimentalValidateInput={ ( label ) =>
							Object.hasOwn( keys, label )
						}
						onChange={ ( tokens ) =>
							setAttributes( {
								[ list ]: tokens.map( ( token ) => {
									const label =
										'string' === typeof token
											? token
											: token.value;
									return keys[ label ] ?? label;
								} ),
							} )
						}
					/>
				) }
				{ decl && ! many && (
					<SelectControl
						{ ...CONTROL }
						label={ __( 'Field', 'newspack-nodes' ) }
						value={ attributes[ list ] }
						options={ [
							{
								label: sprintf(
									// translators: %s: the first field's label.
									__( 'The first: %s', 'newspack-nodes' ),
									offered[ 0 ]?.[ 1 ].label ?? ''
								),
								value: '',
							},
							...offered.map( ( [ key, field ] ) => ( {
								label: field.label,
								value: key,
							} ) ),
						] }
						onChange={ ( field ) =>
							setAttributes( { [ list ]: field } )
						}
					/>
				) }
				<SettingControls
					names={ settings }
					attributes={ attributes }
					setAttributes={ setAttributes }
					schema={ schema }
				/>
			</>
		);
	}

	return { View, Controls };
}
