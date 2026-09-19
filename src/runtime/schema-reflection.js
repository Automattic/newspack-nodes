/**
 * `SchemaReflection` — the JS counterpart of PHP's `Schema_Reflection` trait:
 * a node mixing it in has its `arguments` tokens walked onto the properties
 * its `nodeSchema()` declares, each coerced to its declared type.
 *
 * `Node`'s own `arguments` accessor only stores the tokens, as Tachikoma's
 * does, so a node that wants positional config opts in here. One that does
 * more around the walk overrides `set arguments` and calls
 * `super.arguments = value` — `SseInNode` splits its `subscribe` list after.
 * Mix it in once, at the highest class that declares arguments.
 */

/**
 * THE bool parse for schema args and toggle verbs — the mirror of PHP
 * `Schema_Reflection::truthy()`. Exported because the PHP side names it as the
 * JS counterpart, and because a second spelling of this list elsewhere is how
 * a toggle verb such as `set_is_hub` ends up taking `true`/`1` and refusing
 * `yes`/`on`.
 *
 * @param {string} token A raw argument token.
 * @return {boolean} Whether the token reads as true.
 */
export function truthy( token ) {
	return [ '1', 'true', 'yes', 'on' ].includes(
		String( token ).toLowerCase()
	);
}

/**
 * Coerce a raw token to its declared schema type; unknown types pass through.
 *
 * The numeric types REFUSE rather than cast, mirroring PHP
 * `Schema_Reflection::coerce_argument()`: `parseInt( 'abc', 10 )` is NaN, which
 * poisons every later comparison silently, and `parseInt( '9.9', 10 )` is 9 —
 * neither is what the operator typed. `int` takes a canonical non-negative
 * decimal, which is what every declared int argument (a size, a count, a
 * duration) wants; `float` takes any finite number.
 *
 * @param {string} token A raw argument token.
 * @param {string} type  Declared schema type.
 * @param {string} name  Argument name, for the refusal.
 * @return {*} The coerced value.
 * @throws {Error} When an `int` or `float` token is not the number it declares.
 */
function coerceArgument( token, type, name ) {
	switch ( type ) {
		case 'int':
			if ( ! /^(?:0|[1-9][0-9]*)$/.test( token ) ) {
				throw new Error(
					`Bad argument ${ name }: wants a whole number, got '${ token }'`
				);
			}
			return parseInt( token, 10 );
		case 'float':
			if ( '' === token.trim() || ! Number.isFinite( Number( token ) ) ) {
				throw new Error(
					`Bad argument ${ name }: wants a number, got '${ token }'`
				);
			}
			return Number( token );
		case 'bool':
			return truthy( token );
		default:
			return token;
	}
}

/**
 * The positional walk (PHP trait `parse_schema_args`): assign each token of
 * `args` to the property its declared `nodeSchema().arguments` entry names,
 * coerced to the declared type. A node declaring no arguments is a no-op.
 *
 * Excess tokens are ignored. A blank token at an `int` or `float` position
 * reads as "not supplied", so a line can fill a later position without
 * inventing a number for an earlier one. An unfilled position takes its schema
 * default only once some token arrived, which leaves a node built with no
 * arguments at all on the defaults its constructor set. A required position
 * throws even when the input is empty.
 *
 * @param {import('./node').Node} node A node whose ctor exposes a static nodeSchema().
 * @param {string[]}              args Positional argument tokens (pre-split, quote-resolved).
 * @throws {Error} When a spec carries no name, names a property the node does
 *                 not own, or leaves a required position unfilled.
 */
function walkSchemaArgs( node, args ) {
	const ctor = /** @type {import('./node').NodeClass} */ ( node.constructor );
	const declared = ctor.nodeSchema?.().arguments || [];
	if ( declared.length === 0 ) {
		return;
	}
	const tokens = Array.isArray( args ) ? args : [];
	for ( let i = 0; i < declared.length; i++ ) {
		const spec = declared[ i ];
		if (
			null === spec ||
			'object' !== typeof spec ||
			Array.isArray( spec )
		) {
			continue;
		}
		const name =
			null === spec.name || undefined === spec.name
				? ''
				: String( spec.name );
		const type = spec.type ?? 'string';
		if ( '' === name ) {
			throw new Error(
				`Invalid argument specification: missing name at position ${ i }`
			);
		}
		if ( ! Object.prototype.hasOwnProperty.call( node, name ) ) {
			throw new Error( `Invalid argument specification: ${ name }` );
		}
		const token = i < tokens.length ? String( tokens[ i ] ) : null;
		// A blank numeric positional is a placeholder for "not supplied".
		const supplied =
			null !== token &&
			! ( '' === token && ( 'int' === type || 'float' === type ) );
		if ( supplied ) {
			node[ name ] = coerceArgument( token, type, name );
		} else if ( tokens.length > 0 && 'default' in spec ) {
			node[ name ] = spec.default;
		} else if ( spec.required ) {
			throw new Error( `Missing required argument: ${ name }` );
		}
	}
}

/**
 * Mix the positional walk into a node class.
 *
 * @template {new ( ...args: any[] ) => import('./node').Node} T
 * @param {T} Base The node class to extend; the result's `arguments` setter
 *                 walks the declared schema.
 */
export const SchemaReflection = ( Base ) =>
	class extends Base {
		/**
		 * @return {string[]} The argument tokens last assigned.
		 */
		get arguments() {
			return super.arguments;
		}

		/**
		 * Store the tokens, then walk them onto the declared properties.
		 *
		 * @param {string[]} value Positional argument tokens.
		 * @throws {Error} When a token or the schema is refused.
		 */
		set arguments( value ) {
			super.arguments = value;
			walkSchemaArgs( this, value );
		}
	};
