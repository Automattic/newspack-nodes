<?php
/**
 * Composition: the composition layer's declarations and its validator.
 *
 * A page composed of blocks is a layout: serialized block markup holding only
 * the delimiters of the blocks a consumer declared, and their JSON
 * attributes, never HTML. A consumer declares its blocks and the contexts
 * they compose on the `newspack_nodes/compositions` filter, a map of
 * namespace => `{ blocks, contexts }`:
 *
 *  - `blocks`: name => `{ title, contexts: list<string>, attributes: { name
 *    => JSON schema with a default }, container?: bool, multiple?: bool }`.
 *    A `container` holds blocks and stands only at the top level;
 *    `multiple: false` lets the block stand once, as block.json's
 *    `supports.multiple` does. `shared: true` takes the place of `contexts`:
 *    a shared block does not stand on any context of its own, only on those that
 *    admit it, from any namespace.
 *  - `contexts`: name => `{ default: string, max_blocks: int, check?:
 *    \Closure, admits?: list<string> }`, `default` the absolute path of the
 *    consumer's markup file, `admits` the shared blocks, by name, that stand
 *    on the context beside its own, and `check( string $block, array
 *    $attributes, string $context ): void` a refusal of what the shape
 *    cannot see, thrown as a `\RuntimeException` naming the block and the
 *    field.
 *
 * Every name sits under `<namespace>/`. A declaration that breaks a rule is
 * a consumer's bug, so it throws `\LogicException`, refusing the whole set;
 * markup that breaks one is data, so it throws `\RuntimeException`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The declared blocks and contexts, and the one validator of a layout.
 *
 * @phpstan-type Block array{title: string, contexts: list<string>, shared: bool, attributes: array<string,array<string,mixed>>, container: bool, multiple: bool}
 * @phpstan-type Context array{namespace: string, default: string, max_blocks: int, check: \Closure|null, admits: list<string>}
 * @phpstan-type Declarations array{blocks: array<string,Block>, contexts: array<string,Context>}
 * @phpstan-type Tree list<array{name: string, attributes: array<string,mixed>, inner: list<mixed>}>
 */
final class Composition {

	/** The filter a consumer declares its blocks and contexts on. */
	public const FILTER = 'newspack_nodes/compositions';

	/** The longest layout, in bytes, before it is parsed. */
	public const MAX_MARKUP_BYTES = 4096;

	/** The global the editor bundle reads its page data from. */
	public const EDITOR_GLOBAL = 'NewspackNodesComposition';

	/** A namespace, as block.json spells one. */
	private const NAMESPACE_PATTERN = '/^[a-z0-9-]+$/D';

	/** A block name, as `registerBlockType()` accepts one. */
	private const BLOCK_NAME_PATTERN = '/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/D';

	/**
	 * What the filter declared, once it stood, or null before first use.
	 *
	 * @var Declarations|null
	 */
	private static ?array $declarations = null;

	/**
	 * Validate a layout for `$context` and answer its tree, each block's
	 * attributes laid over their defaults: every shape rule, then the
	 * context's `check` on every block.
	 *
	 * @param string $context The context the layout composes.
	 * @param string $markup  Serialized block markup.
	 * @return Tree
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the markup breaks a rule, naming the block and the field.
	 */
	public static function validate( string $context, string $markup ): array {
		$tree  = self::validate_shape( $context, $markup );
		$check = self::context_of( $context )['check'];
		if ( null !== $check ) {
			foreach ( self::flatten( $tree ) as $node ) {
				$check( $node['name'], $node['attributes'], $context );
			}
		}
		return $tree;
	}

	/**
	 * Every rule `validate()` applies but the context's `check`, for a seed
	 * written before what `check` reads exists.
	 *
	 * @param string $context The context the layout composes.
	 * @param string $markup  Serialized block markup.
	 * @return Tree
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the markup breaks a rule.
	 */
	public static function validate_shape( string $context, string $markup ): array {
		$declared = self::context_of( $context );
		self::fit( $context, $markup );
		$singles = [];
		$tree    = self::nodes( $context, self::blocks_for( $context ), \parse_blocks( $markup ), 0, $singles );
		$count   = \count( self::flatten( $tree ) );
		if ( $count > $declared['max_blocks'] ) {
			self::refuse( $context, "{$count} blocks, more than the {$declared['max_blocks']} it holds" );
		}
		return $tree;
	}

	/**
	 * Every node of a tree, each before its children.
	 *
	 * @param Tree $tree The tree.
	 * @return list<array{name: string, attributes: array<string,mixed>, inner: list<mixed>}>
	 */
	private static function flatten( array $tree ): array {
		$nodes = [];
		foreach ( $tree as $node ) {
			$nodes[] = $node;
			/** @var Tree $inner */
			$inner = $node['inner'];
			\array_push( $nodes, ...self::flatten( $inner ) );
		}
		return $nodes;
	}

	/**
	 * Turn parsed blocks into tree nodes, refusing the first that breaks a
	 * shape rule. `$singles` carries the `multiple: false` names already seen.
	 *
	 * @param array<string,Block> $standing The blocks that stand on the context.
	 * @param array<mixed>        $blocks   What `parse_blocks()` answered, at one depth.
	 * @param int                 $depth    0 at the top level.
	 * @param array<string,true>  $singles  Seen single-standing names.
	 * @return Tree
	 * @throws \RuntimeException On the first rule broken.
	 */
	private static function nodes( string $context, array $standing, array $blocks, int $depth, array &$singles ): array {
		$declared = self::declarations()['blocks'];
		$nodes    = [];
		foreach ( $blocks as $block ) {
			$block = Core::arr( $block );
			$name  = $block['blockName'] ?? null;
			if ( null === $name ) {
				if ( '' !== \trim( Core::as_string( $block['innerHTML'] ?? '' ) ) ) {
					self::refuse( $context, 'HTML outside a block; a layout holds no HTML' );
				}
				continue;
			}
			$name = Core::as_string( $name );
			$spec = $declared[ $name ] ?? null;
			if ( null === $spec ) {
				self::refuse( $context, "{$name} is not a declared block" );
			}
			if ( ! isset( $standing[ $name ] ) ) {
				self::refuse( $context, "{$name} does not stand on {$context}" );
			}
			foreach ( Core::arr( $block['innerContent'] ?? [] ) as $chunk ) {
				if ( \is_string( $chunk ) && '' !== \trim( $chunk ) ) {
					self::refuse( $context, "{$name} holds HTML; a layout holds no HTML" );
				}
			}
			$inner = Core::arr( $block['innerBlocks'] ?? [] );
			if ( [] !== $inner && ! $spec['container'] ) {
				self::refuse( $context, "{$name} holds no blocks" );
			}
			if ( $spec['container'] && $depth > 0 ) {
				self::refuse( $context, "{$name} stands only at the top level" );
			}
			if ( ! $spec['multiple'] ) {
				if ( isset( $singles[ $name ] ) ) {
					self::refuse( $context, "a second {$name}; it stands once" );
				}
				$singles[ $name ] = true;
			}
			$nodes[] = [
				'name'       => $name,
				'attributes' => self::attributes( $context, $name, $block['attrs'] ?? null, $spec['attributes'] ),
				'inner'      => self::nodes( $context, $standing, $inner, $depth + 1, $singles ),
			];
		}
		return $nodes;
	}

	/**
	 * A block's attributes, each checked against its schema and laid over
	 * the declared defaults.
	 *
	 * @param mixed                              $attrs   The parsed delimiter JSON.
	 * @param array<string,array<string,mixed>> $schemas The block's attribute schemas.
	 * @return array<string,mixed>
	 * @throws \RuntimeException When an attribute is undeclared or its schema refuses it.
	 */
	private static function attributes( string $context, string $name, mixed $attrs, array $schemas ): array {
		if ( ! \is_array( $attrs ) ) {
			self::refuse( $context, "{$name} carries attributes that are not a JSON object" );
		}
		$defaults = [];
		foreach ( $schemas as $attribute => $schema ) {
			$defaults[ $attribute ] = $schema['default'];
		}
		foreach ( $attrs as $attribute => $value ) {
			$attribute = (string) $attribute;
			$schema    = $schemas[ $attribute ] ?? null;
			if ( null === $schema ) {
				self::refuse( $context, "{$name} declares no attribute {$attribute}" );
			}
			$valid = \rest_validate_value_from_schema( $value, $schema, $attribute );
			if ( \is_wp_error( $valid ) ) {
				self::refuse( $context, "{$name} attribute {$attribute}: " . $valid->get_error_message() );
			}
			$defaults[ $attribute ] = \rest_sanitize_value_from_schema( $value, $schema, $attribute );
		}
		return $defaults;
	}

	/**
	 * A validated tree as the layout a context stores: every attribute, no
	 * whitespace between delimiters, held to `MAX_MARKUP_BYTES` as the
	 * delimiters escape it.
	 *
	 * @param string $context The context the tree composes.
	 * @param Tree   $tree    A tree `validate()` or `validate_shape()` answered.
	 * @throws \RuntimeException When the serialized layout is past the cap.
	 */
	public static function serialize( string $context, array $tree ): string {
		$markup = \serialize_blocks( self::parsed( $tree ) );
		self::fit( $context, $markup );
		return $markup;
	}

	/**
	 * Refuse a layout past `MAX_MARKUP_BYTES`, the one cap on what a caller
	 * sends and on what a context stores.
	 *
	 * @throws \RuntimeException When the layout is past the cap.
	 */
	private static function fit( string $context, string $markup ): void {
		$bytes = \strlen( $markup );
		if ( $bytes > self::MAX_MARKUP_BYTES ) {
			self::refuse( $context, "the layout is {$bytes} bytes, more than " . self::MAX_MARKUP_BYTES );
		}
	}

	/**
	 * Tree nodes in `parse_blocks()`'s shape.
	 *
	 * @param Tree $tree Validated nodes.
	 * @return list<array{blockName: string, attrs: array<string,mixed>, innerBlocks: list<array<mixed>>, innerHTML: string, innerContent: list<null>}>
	 */
	private static function parsed( array $tree ): array {
		$blocks = [];
		foreach ( $tree as $node ) {
			/** @var Tree $children */
			$children = $node['inner'];
			$inner    = self::parsed( $children );
			$blocks[] = [
				'blockName'    => $node['name'],
				'attrs'        => $node['attributes'],
				'innerBlocks'  => $inner,
				'innerHTML'    => '',
				'innerContent' => \array_fill( 0, \count( $inner ), null ),
			];
		}
		return $blocks;
	}

	/**
	 * Mount the editor for a `tune` caller: the block-editor canvas under
	 * `$context`, the consumer's editor bundle `$handle`, and `schemas()`
	 * localized on it as `EDITOR_GLOBAL`. Any other caller gets none of it.
	 *
	 * @param string $context A declared context.
	 * @param string $handle  The consumer's registered editor bundle.
	 * @api Called from consumer plugins' admin pages (cross-repo, invisible here).
	 * @return bool True when the editor loaded.
	 * @throws \LogicException When the context is not declared, or `$handle` is not registered.
	 */
	public static function editor( string $context, string $handle ): bool {
		$schemas = self::schemas( $context );
		if ( ! Capabilities::can( Capabilities::TUNE ) ) {
			return false;
		}
		if ( ! \wp_script_is( $handle, 'registered' ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \LogicException( "composition {$context}: the editor bundle {$handle} is not registered" );
		}
		Block_Editor_Bootstrap::load_canvas( $context );
		\wp_enqueue_script( $handle );
		\wp_localize_script( $handle, self::EDITOR_GLOBAL, $schemas );
		return true;
	}

	/**
	 * The editor's page data: the context, its block cap, and every block it
	 * admits with its title, attribute schemas and the two placement flags.
	 *
	 * @param string $context A declared context.
	 * @return array{context: string, max_blocks: int, blocks: array<string,array{title: string, attributes: array<string,array<string,mixed>>, container: bool, multiple: bool}>}
	 * @throws \LogicException When the context is not declared.
	 */
	public static function schemas( string $context ): array {
		$declared = self::context_of( $context );
		$blocks   = [];
		foreach ( self::blocks_for( $context ) as $name => $block ) {
			$blocks[ $name ] = [
				'title'      => $block['title'],
				'attributes' => $block['attributes'],
				'container'  => $block['container'],
				'multiple'   => $block['multiple'],
			];
		}
		return [
			'context'    => $context,
			'max_blocks' => $declared['max_blocks'],
			'blocks'     => $blocks,
		];
	}

	/**
	 * The blocks that stand on a context: those declaring it among their
	 * `contexts`, and the shared blocks it admits.
	 *
	 * @param string $context A declared context.
	 * @return array<string,Block>
	 * @throws \LogicException When the context is not declared.
	 */
	public static function blocks_for( string $context ): array {
		$admits = self::context_of( $context )['admits'];
		$blocks = [];
		foreach ( self::declarations()['blocks'] as $name => $block ) {
			if ( \in_array( $context, $block['contexts'], true ) || \in_array( $name, $admits, true ) ) {
				$blocks[ $name ] = $block;
			}
		}
		return $blocks;
	}

	/**
	 * The default layout `$context` declares, as its file holds it.
	 *
	 * @param string $context A declared context.
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the file will not read, which names no path;
	 *                           the log carries the path and PHP's reason.
	 */
	public static function default_markup( string $context ): string {
		$path = self::context_of( $context )['default'];
		\error_clear_last();
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- a consumer's own markup file.
		$markup = @\file_get_contents( $path );
		if ( false === $markup ) {
			Core::print_less_often( "composition {$context}: its default layout will not read: ", \error_get_last()['message'] ?? 'no cause reported' );
			self::refuse( $context, 'its default layout will not read' );
		}
		return $markup;
	}

	/**
	 * Refuse a layout for `$context`.
	 *
	 * @throws \RuntimeException Always.
	 */
	private static function refuse( string $context, string $why ): never {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		throw new \RuntimeException( "composition {$context}: {$why}" );
	}

	/**
	 * A declared context, or a refusal naming it.
	 *
	 * @return Context
	 * @throws \LogicException When the context is not declared.
	 */
	public static function context_of( string $context ): array {
		$declared = self::declarations()['contexts'][ $context ] ?? null;
		if ( null === $declared ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \LogicException( "composition context {$context} is not declared" );
		}
		return $declared;
	}

	/**
	 * The declared blocks and contexts across every namespace, the filter
	 * applied once a process. A throw, the filter's own or a refusal, stores
	 * nothing, so the next call applies the filter again.
	 *
	 * @return Declarations
	 * @throws \LogicException When a declaration breaks a rule, naming its namespace and key.
	 */
	public static function declarations(): array {
		return self::$declarations ??= self::declare( \apply_filters( self::FILTER, [] ) );
	}

	/**
	 * Check every namespace's declaration and flatten them into one map of
	 * blocks and one of contexts.
	 *
	 * @param mixed $declared What the filter answered.
	 * @return Declarations
	 * @throws \LogicException On the first declaration breaking a rule.
	 */
	private static function declare( mixed $declared ): array {
		if ( ! \is_array( $declared ) ) {
			throw new \LogicException( self::FILTER . ' answered something other than a map of namespace => { blocks, contexts }' );
		}
		$out = [
			'blocks'   => [],
			'contexts' => [],
		];
		foreach ( $declared as $namespace => $declaration ) {
			$namespace = (string) $namespace;
			if ( 1 !== \preg_match( self::NAMESPACE_PATTERN, $namespace ) ) {
				self::refuse_declaration( $namespace, $namespace, 'is not a namespace: lowercase letters, digits and hyphens' );
			}
			if ( ! \is_array( $declaration ) || ! \is_array( $declaration['blocks'] ?? null ) || ! \is_array( $declaration['contexts'] ?? null ) ) {
				self::refuse_declaration( $namespace, $namespace, 'declares no { blocks, contexts } map' );
			}
			foreach ( $declaration['contexts'] as $name => $context ) {
				$name                     = self::owned( $namespace, (string) $name );
				$out['contexts'][ $name ] = self::context( $namespace, $name, $context );
			}
			foreach ( $declaration['blocks'] as $name => $block ) {
				$name = self::owned( $namespace, (string) $name );
				if ( 1 !== \preg_match( self::BLOCK_NAME_PATTERN, $name ) ) {
					self::refuse_declaration( $namespace, $name, 'is not a block name: lowercase letters, digits and hyphens, opening on a letter' );
				}
				$out['blocks'][ $name ] = self::block( $namespace, $name, $block, $out['contexts'] );
			}
		}
		foreach ( $out['contexts'] as $name => $context ) {
			foreach ( $context['admits'] as $admitted ) {
				if ( ! ( $out['blocks'][ $admitted ]['shared'] ?? false ) ) {
					self::refuse_declaration( $context['namespace'], $name, "admits {$admitted}, which is not a shared block" );
				}
			}
		}
		return $out;
	}

	/**
	 * One block's declaration, checked against the contexts declared so far.
	 *
	 * @param mixed                  $block    Its declaration.
	 * @param array<string,Context>  $contexts Every context declared.
	 * @return Block
	 * @throws \LogicException When a field breaks a rule.
	 */
	private static function block( string $namespace, string $name, mixed $block, array $contexts ): array {
		$block = \is_array( $block ) ? $block : [];
		$title = $block['title'] ?? null;
		if ( ! \is_string( $title ) || '' === $title ) {
			self::refuse_declaration( $namespace, $name, 'declares no title' );
		}
		if ( isset( $block['shared'] ) && ! \is_bool( $block['shared'] ) ) {
			self::refuse_declaration( $namespace, $name, 'declares a shared that is not a bool' );
		}
		$shared = true === ( $block['shared'] ?? false );
		$on     = [];
		if ( $shared ) {
			if ( \array_key_exists( 'contexts', $block ) ) {
				self::refuse_declaration( $namespace, $name, 'declares shared and contexts; a shared block stands where a context admits it' );
			}
		} else {
			$on = $block['contexts'] ?? null;
			if ( ! \is_array( $on ) || [] === $on || ! \array_is_list( $on ) ) {
				self::refuse_declaration( $namespace, $name, 'declares no list of contexts' );
			}
		}
		foreach ( $on as $context ) {
			$context = Core::as_string( $context );
			if ( ! \str_starts_with( $context, "{$namespace}/" ) ) {
				self::refuse_declaration( $namespace, $name, "names the context {$context}, outside {$namespace}/" );
			}
			if ( ! isset( $contexts[ $context ] ) ) {
				self::refuse_declaration( $namespace, $name, "names the undeclared context {$context}" );
			}
		}
		$attributes = $block['attributes'] ?? null;
		if ( ! \is_array( $attributes ) ) {
			self::refuse_declaration( $namespace, $name, 'declares no attributes map' );
		}
		$schemas = [];
		foreach ( $attributes as $attribute => $schema ) {
			$schemas[ (string) $attribute ] = self::attribute( $namespace, $name, (string) $attribute, $schema );
		}
		foreach ( [ 'container', 'multiple' ] as $flag ) {
			if ( isset( $block[ $flag ] ) && ! \is_bool( $block[ $flag ] ) ) {
				self::refuse_declaration( $namespace, $name, "declares a {$flag} that is not a bool" );
			}
		}
		return [
			'title'      => $title,
			'contexts'   => \array_map( Core::as_string( ... ), $on ),
			'shared'     => $shared,
			'attributes' => $schemas,
			'container'  => true === ( $block['container'] ?? false ),
			'multiple'   => false !== ( $block['multiple'] ?? true ),
		];
	}

	/**
	 * One attribute's schema, which declares a type and a default its own
	 * schema accepts.
	 *
	 * @param mixed $schema The attribute's JSON schema.
	 * @return array<string,mixed>
	 * @throws \LogicException When the schema declares no type or default, or refuses its default.
	 */
	private static function attribute( string $namespace, string $block, string $attribute, mixed $schema ): array {
		if ( ! \is_array( $schema ) || ! isset( $schema['type'] ) ) {
			self::refuse_declaration( $namespace, $block, "attribute {$attribute} declares no type" );
		}
		if ( ! \array_key_exists( 'default', $schema ) ) {
			self::refuse_declaration( $namespace, $block, "attribute {$attribute} declares no default" );
		}
		$valid = \rest_validate_value_from_schema( $schema['default'], $schema, $attribute );
		if ( \is_wp_error( $valid ) ) {
			self::refuse_declaration( $namespace, $block, "attribute {$attribute} has a default its schema refuses: " . $valid->get_error_message() );
		}
		$schema['default'] = \rest_sanitize_value_from_schema( $schema['default'], $schema, $attribute );
		/** @var array<string,mixed> $schema */
		return $schema;
	}

	/**
	 * One context's declaration, checked.
	 *
	 * @param mixed $context Its declaration.
	 * @return Context
	 * @throws \LogicException When a field breaks a rule.
	 */
	private static function context( string $namespace, string $name, mixed $context ): array {
		$context = \is_array( $context ) ? $context : [];
		$default = $context['default'] ?? null;
		if ( ! \is_string( $default ) || ! \str_starts_with( $default, '/' ) || ! \is_file( $default ) ) {
			Core::print_less_often( "composition declaration {$namespace}: {$name} names no default layout file: ", Core::as_string( $default ) );
			self::refuse_declaration( $namespace, $name, 'names no default layout file' );
		}
		$max_blocks = $context['max_blocks'] ?? null;
		if ( ! \is_int( $max_blocks ) || $max_blocks < 1 ) {
			self::refuse_declaration( $namespace, $name, 'declares no max_blocks of 1 or more' );
		}
		$check = $context['check'] ?? null;
		if ( null !== $check && ! $check instanceof \Closure ) {
			self::refuse_declaration( $namespace, $name, 'declares a check that is not a closure' );
		}
		$admits = $context['admits'] ?? [];
		if ( ! \is_array( $admits ) || ! \array_is_list( $admits ) || \array_filter( $admits, 'is_string' ) !== $admits ) {
			self::refuse_declaration( $namespace, $name, 'declares an admits that is not a list of block names' );
		}
		return [
			'namespace'  => $namespace,
			'default'    => $default,
			'max_blocks' => $max_blocks,
			'check'      => $check,
			'admits'     => $admits,
		];
	}

	/**
	 * Refuse a name outside `<namespace>/`, and answer it.
	 *
	 * @throws \LogicException When the name sits outside the namespace.
	 */
	private static function owned( string $namespace, string $name ): string {
		if ( ! \str_starts_with( $name, "{$namespace}/" ) || \strlen( $name ) === \strlen( $namespace ) + 1 ) {
			self::refuse_declaration( $namespace, $name, "sits outside {$namespace}/" );
		}
		return $name;
	}

	/**
	 * Refuse a declaration, naming its namespace and key.
	 *
	 * @throws \LogicException Always.
	 */
	private static function refuse_declaration( string $namespace, string $key, string $why ): never {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		throw new \LogicException( "composition declaration {$namespace}: {$key} {$why}" );
	}
}
