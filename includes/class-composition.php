<?php
/**
 * Composition: the composition layer's declarations and its validator.
 *
 * A page composed of blocks is a layout: serialized block markup holding
 * the delimiters of the blocks a consumer declared and their JSON
 * attributes, and the core blocks every context admits (`CORE_BLOCKS`):
 * headings, paragraphs, lists, groups, columns, separators and spacers. A
 * declared block holds no HTML. A core block holds only the element core
 * writes it as, and the text of a heading, a paragraph or a list item inside
 * it, which holds no comment and which every read filters to `INLINE_HTML`
 * and hands on as its `content` attribute; `serialize()` stores that text
 * in the block's `text` element and every other core block with none, the
 * shape the editor writes, and refuses a layout that does not read back as
 * the tree it was handed. A consumer declares its blocks and the contexts
 * they compose on the `newspack_nodes/compositions` filter, a map of
 * namespace => `{ blocks, contexts }`:
 *
 *  - `blocks`: name => `{ title, contexts: list<string>, attributes: { name
 *    => JSON schema with a default }, container?: bool, multiple?: bool }`.
 *    A `container` holds blocks and stands only at the top, in a column or
 *    in a group; any other block stands there or in a container, no more
 *    than `MAX_DEPTH` blocks deep; `multiple: false` lets the block stand
 *    once, as block.json's
 *    `supports.multiple` does. `shared: true` takes the place of `contexts`:
 *    a shared block does not stand on any context of its own, only on those that
 *    admit it, from any namespace. The substrate declares its own shared
 *    blocks under `newspack-nodes/` through `declare_substrate_blocks()`.
 *  - `contexts`: name => `{ default: string, max_blocks: int, check?:
 *    \Closure, admits?: list<string> }`, `default` the absolute path of the
 *    consumer's markup file, `admits` the shared blocks, by name, that stand
 *    on the context beside its own, and `check( string $block, array
 *    $attributes, string $context ): void` a refusal of what the shape
 *    cannot see, thrown as a `\RuntimeException` naming the block and the
 *    field. `patterns?: slug => { title: string, file: string }` offers
 *    named layouts, `slug` matching `[a-z0-9-]+` and `file` the absolute path
 *    of the pattern's markup, which must pass `validate_shape()` for the
 *    context.
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
 * @phpstan-type Context array{namespace: string, default: string, max_blocks: int, check: \Closure|null, admits: list<string>, patterns: list<array{name: string, title: string, markup: string}>}
 * @phpstan-type Declarations array{blocks: array<string,Block>, contexts: array<string,Context>}
 * @phpstan-type Tree list<array{name: string, attributes: array<string,mixed>, inner: list<mixed>}>
 */
final class Composition {

	/** The filter a consumer declares its blocks and contexts on. */
	public const FILTER = 'newspack_nodes/compositions';

	/**
	 * The longest layout, in bytes, before it is parsed. A layout holds a
	 * page's prose beside its blocks, so it fits some sixty paragraphs of a
	 * thousand bytes; every read parses and filters the whole of it, and a
	 * save rides one command, whose body
	 * `Command_Interpreter_Node::MAX_BODY_BYTES` holds to 1 MiB.
	 */
	public const MAX_MARKUP_BYTES = 65536;

	/** The most blocks that may hold one block: a group, a column and its columns. */
	private const MAX_DEPTH = 3;

	/** The core blocks a container, a column or a group included, may stand in. */
	private const LAYOUT_HOLDERS = [ 'core/group', 'core/column' ];

	/** The inline markup a heading, paragraph or list item keeps, for `wp_kses()`. */
	private const INLINE_HTML = [
		'strong' => [],
		'em'     => [],
		'b'      => [],
		'i'      => [],
		'code'   => [],
		'a'      => [
			'href'   => true,
			'target' => true,
			'rel'    => true,
		],
		'br'     => [],
	];

	/** A CSS length or percentage, as a column's width or a layout's size. */
	private const WIDTH = '^[0-9]+(\\.[0-9]+)?(px|em|rem|vh|vw|%)$';

	/** A group's or a columns block's layout, with only the keys core writes. */
	private const LAYOUT_ATTRIBUTE = [
		'type'                 => 'object',
		'properties'           => [
			'type'               => [
				'type' => 'string',
				'enum' => [ 'default', 'constrained', 'flex', 'grid' ],
			],
			'orientation'        => [
				'type' => 'string',
				'enum' => [ 'horizontal', 'vertical' ],
			],
			'justifyContent'     => [
				'type' => 'string',
				'enum' => [ 'left', 'center', 'right', 'space-between', 'stretch' ],
			],
			'verticalAlignment'  => [
				'type' => 'string',
				'enum' => [ 'top', 'center', 'bottom', 'stretch', 'space-between' ],
			],
			'flexWrap'           => [
				'type' => 'string',
				'enum' => [ 'wrap', 'nowrap' ],
			],
			'contentSize'        => [
				'type'    => 'string',
				'pattern' => self::WIDTH,
			],
			'wideSize'           => [
				'type'    => 'string',
				'pattern' => self::WIDTH,
			],
			'columnCount'        => [
				'type'    => 'integer',
				'minimum' => 1,
				'maximum' => 16,
			],
			'minimumColumnWidth' => [
				'type'    => 'string',
				'pattern' => self::WIDTH,
			],
		],
		'additionalProperties' => false,
	];

	/**
	 * The core blocks every context admits, which carry no data, so no
	 * consumer declares them, each in a declared block's shape: its title,
	 * its attribute schemas, and its placement. Beside those, `reads` names
	 * the elements a read takes it in and, for one that holds text, `text`
	 * the element its text is stored in. `in` names the one block a block
	 * stands in, `holds` the one block a block holds, `part` marks a block
	 * that adds no depth to the one it stands in, and a `container` holds
	 * what a column or a group may.
	 */
	private const CORE_BLOCKS = [
		'core/heading'   => [
			'title'      => 'Heading',
			'contexts'   => [],
			'shared'     => true,
			'container'  => false,
			'multiple'   => true,
			'reads'      => 'h[1-6]',
			'text'       => 'h2',
			'attributes' => [
				'level' => [
					'type'    => 'integer',
					'minimum' => 1,
					'maximum' => 6,
					'default' => 2,
				],
			],
		],
		'core/paragraph' => [
			'title'      => 'Paragraph',
			'contexts'   => [],
			'shared'     => true,
			'container'  => false,
			'multiple'   => true,
			'reads'      => 'p',
			'text'       => 'p',
			'attributes' => [
				'direction' => [
					'type' => 'string',
					'enum' => [ 'ltr', 'rtl' ],
				],
			],
		],
		'core/list'      => [
			'title'      => 'List',
			'contexts'   => [],
			'shared'     => true,
			'container'  => false,
			'multiple'   => true,
			'reads'      => 'ul|ol',
			'holds'      => 'core/list-item',
			'attributes' => [
				'ordered'  => [
					'type'    => 'boolean',
					'default' => false,
				],
				'reversed' => [
					'type'    => 'boolean',
					'default' => false,
				],
				'start'    => [ 'type' => 'integer' ],
				'type'     => [
					'type' => 'string',
					'enum' => [ 'decimal', 'upper-alpha', 'lower-alpha', 'upper-roman', 'lower-roman' ],
				],
			],
		],
		'core/list-item' => [
			'title'      => 'List item',
			'contexts'   => [],
			'shared'     => true,
			'container'  => false,
			'multiple'   => true,
			'reads'      => 'li',
			'text'       => 'li',
			'in'         => 'core/list',
			'part'       => true,
			'attributes' => [],
		],
		'core/group'     => [
			'title'      => 'Group',
			'contexts'   => [],
			'shared'     => true,
			'container'  => true,
			'multiple'   => true,
			'reads'      => 'div|header|main|section|article|aside|footer',
			'attributes' => [
				'tagName' => [
					'type'    => 'string',
					'enum'    => [ 'div', 'header', 'main', 'section', 'article', 'aside', 'footer' ],
					'default' => 'div',
				],
				'layout'  => self::LAYOUT_ATTRIBUTE,
			],
		],
		'core/columns'   => [
			'title'      => 'Columns',
			'contexts'   => [],
			'shared'     => true,
			'container'  => true,
			'multiple'   => true,
			'reads'      => 'div',
			'holds'      => 'core/column',
			'attributes' => [
				'isStackedOnMobile' => [
					'type'    => 'boolean',
					'default' => true,
				],
				'verticalAlignment' => [
					'type' => 'string',
					'enum' => [ 'top', 'center', 'bottom' ],
				],
				'layout'            => self::LAYOUT_ATTRIBUTE,
			],
		],
		'core/column'    => [
			'title'      => 'Column',
			'contexts'   => [],
			'shared'     => true,
			'container'  => true,
			'multiple'   => true,
			'reads'      => 'div',
			'in'         => 'core/columns',
			'attributes' => [
				'verticalAlignment' => [
					'type' => 'string',
					'enum' => [ 'top', 'center', 'bottom', 'stretch' ],
				],
				'width'             => [
					'type'    => 'string',
					'pattern' => self::WIDTH,
				],
				'layout'            => self::LAYOUT_ATTRIBUTE,
			],
		],
		'core/separator' => [
			'title'      => 'Separator',
			'contexts'   => [],
			'shared'     => true,
			'container'  => false,
			'multiple'   => true,
			'reads'      => 'hr|div',
			'attributes' => [
				'tagName' => [
					'type'    => 'string',
					'enum'    => [ 'hr', 'div' ],
					'default' => 'hr',
				],
			],
		],
		'core/spacer'    => [
			'title'      => 'Spacer',
			'contexts'   => [],
			'shared'     => true,
			'container'  => false,
			'multiple'   => true,
			'reads'      => 'div',
			'attributes' => [
				'height' => [
					'type'    => 'string',
					'pattern' => '^[0-9]+(\\.[0-9]+)?(px|em|rem|vh|vw)$',
					'default' => '100px',
				],
				'width'  => [
					'type'    => 'string',
					'pattern' => self::WIDTH,
				],
				'style'  => [
					'type'                 => 'object',
					'properties'           => [
						'layout' => [
							'type'                 => 'object',
							'properties'           => [
								'flexSize'    => [
									'type'    => 'string',
									'pattern' => self::WIDTH,
								],
								'selfStretch' => [
									'type' => 'string',
									'enum' => [ 'fixed', 'fit', 'fill' ],
								],
							],
							'additionalProperties' => false,
						],
					],
					'additionalProperties' => false,
				],
			],
		],
	];

	/** The global the editor bundle reads its page data from. */
	public const EDITOR_GLOBAL = 'NewspackNodesComposition';

	/** A string attribute, empty by default. */
	private const NAME_ATTRIBUTE = [
		'type'    => 'string',
		'default' => '',
	];

	/** A block attribute naming a source's fields, all of them when empty. */
	private const NAMES_ATTRIBUTE = [
		'type'    => 'array',
		'items'   => [ 'type' => 'string' ],
		'default' => [],
	];

	/**
	 * The substrate's shared blocks: the five that each read one declared
	 * source, and the section, a container heading the blocks it holds.
	 * Block name => declaration, as `FILTER` takes one.
	 */
	private const SUBSTRATE_BLOCKS = [
		'newspack-nodes/stats'      => [
			'title'      => 'Stats',
			'shared'     => true,
			'attributes' => [
				'source'  => self::NAME_ATTRIBUTE,
				'fields'  => self::NAMES_ATTRIBUTE,
				'columns' => [
					'type'    => 'integer',
					'minimum' => 0,
					'maximum' => 12,
					'default' => 0,
				],
			],
		],
		'newspack-nodes/time-chart' => [
			'title'      => 'Time chart',
			'shared'     => true,
			'attributes' => [
				'source'  => self::NAME_ATTRIBUTE,
				'metrics' => self::NAMES_ATTRIBUTE,
				'stacked' => [
					'type'    => 'boolean',
					'default' => false,
				],
				'title'   => self::NAME_ATTRIBUTE,
			],
		],
		'newspack-nodes/table'      => [
			'title'      => 'Table',
			'shared'     => true,
			'attributes' => [
				'source'  => self::NAME_ATTRIBUTE,
				'columns' => self::NAMES_ATTRIBUTE,
				'sort'    => [
					'type'                 => 'object',
					'properties'           => [
						'field'     => [ 'type' => 'string' ],
						'direction' => [
							'type' => 'string',
							'enum' => [ 'asc', 'desc' ],
						],
					],
					'additionalProperties' => false,
					'default'              => [
						'field'     => '',
						'direction' => 'desc',
					],
				],
				'perPage' => [
					'type'    => 'integer',
					'minimum' => 1,
					'maximum' => 100,
					'default' => 20,
				],
				'title'   => self::NAME_ATTRIBUTE,
			],
		],
		'newspack-nodes/log-stream' => [
			'title'      => 'Log stream',
			'shared'     => true,
			'attributes' => [
				'source'  => self::NAME_ATTRIBUTE,
				'columns' => self::NAMES_ATTRIBUTE,
				'title'   => self::NAME_ATTRIBUTE,
				'toolbar' => [
					'type'    => 'string',
					'enum'    => [ 'inline', 'header' ],
					'default' => 'inline',
				],
			],
		],
		'newspack-nodes/sparkline'  => [
			'title'      => 'Sparkline',
			'shared'     => true,
			'attributes' => [
				'source' => self::NAME_ATTRIBUTE,
				'field'  => self::NAME_ATTRIBUTE,
				'title'  => self::NAME_ATTRIBUTE,
			],
		],
		'newspack-nodes/section'    => [
			'title'      => 'Section',
			'shared'     => true,
			'container'  => true,
			'attributes' => [
				'title'       => self::NAME_ATTRIBUTE,
				'description' => self::NAME_ATTRIBUTE,
			],
		],
	];

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
	 * A validated tree as the layout a context stores: every attribute, no
	 * whitespace between delimiters, held to `MAX_MARKUP_BYTES` as the
	 * delimiters escape it, and read back before it is answered, so a layout
	 * that would read as anything but `$tree` is never stored.
	 *
	 * @param string $context The context the tree composes.
	 * @param Tree   $tree    A tree `validate()` or `validate_shape()` answered.
	 * @throws \RuntimeException When the serialized layout is past the cap or does not read back as `$tree`.
	 */
	public static function serialize( string $context, array $tree ): string {
		$markup = \serialize_blocks( self::parsed( $tree ) );
		if ( self::validate_shape( $context, $markup ) !== $tree ) {
			self::refuse( $context, 'the layout does not read back as it was written' );
		}
		return $markup;
	}

	/**
	 * Tree nodes in `parse_blocks()`'s shape: a block's delimiters alone, and
	 * a core text block's text, out of its attributes, in its `text` element.
	 *
	 * @param Tree $tree Validated nodes.
	 * @return list<array{blockName: string, attrs: array<string,mixed>, innerBlocks: list<array<mixed>>, innerHTML: string, innerContent: list<?string>}>
	 */
	private static function parsed( array $tree ): array {
		$blocks = [];
		foreach ( $tree as $node ) {
			/** @var Tree $children */
			$children = $node['inner'];
			$inner    = self::parsed( $children );
			$attrs    = $node['attributes'];
			$content  = \array_fill( 0, \count( $inner ), null );
			$text     = self::core_key( $node['name'], 'text' );
			if ( null !== $text ) {
				$content = [ "<{$text}>" . Core::as_string( $attrs['content'] ) . "</{$text}>" ];
				unset( $attrs['content'] );
			}
			$blocks[] = [
				'blockName'    => $node['name'],
				'attrs'        => $attrs,
				'innerBlocks'  => $inner,
				'innerHTML'    => \implode( '', \array_filter( $content, 'is_string' ) ),
				'innerContent' => $content,
			];
		}
		return $blocks;
	}

	/**
	 * Load the layout editor of the page `?edit=` names: register `$handle`
	 * from the build dir's `layout-editor.js` and `.asset.php`, hand it to
	 * `editor()`, and enqueue the build's `layout-editor.css` once it loads.
	 * A page `$pages` does not list, and an unbuilt bundle, load nothing.
	 *
	 * @param array<string,string> $pages     Page slug => context.
	 * @param string               $handle    The editor bundle's script handle.
	 * @param string               $build_dir The build directory.
	 * @param string               $build_url The build directory's URL.
	 * @api Called from consumer plugins' admin pages (cross-repo, invisible here).
	 * @return bool What `editor()` answered, false when nothing was asked of it.
	 */
	public static function enqueue_editor( array $pages, string $handle, string $build_dir, string $build_url ): bool {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- names which page's editor to load; the editor's writes are command-gated.
		$edit = isset( $_GET['edit'] ) && \is_string( $_GET['edit'] ) ? \sanitize_text_field( \wp_unslash( $_GET['edit'] ) ) : '';
		if ( ! \array_key_exists( $edit, $pages ) || ! \file_exists( "{$build_dir}/layout-editor.js" ) ) {
			return false;
		}
		$asset   = Core::arr( require "{$build_dir}/layout-editor.asset.php" );
		$deps    = \array_map( Core::as_string( ... ), \array_values( Core::arr( $asset['dependencies'] ) ) );
		$version = Core::as_string( $asset['version'] );
		\wp_register_script( $handle, "{$build_url}/layout-editor.js", $deps, $version, true );
		$loaded = self::editor( $pages[ $edit ], $handle );
		if ( $loaded && \file_exists( "{$build_dir}/layout-editor.css" ) ) {
			\wp_enqueue_style( $handle, "{$build_url}/layout-editor.css", [ 'wp-components', 'wp-block-editor' ], $version );
			\wp_style_add_data( $handle, 'rtl', 'replace' );
		}
		return $loaded;
	}

	/**
	 * Mount the editor for a `tune` caller: the block-editor canvas under
	 * `$context` with core's blocks registered, the consumer's editor bundle
	 * `$handle`, and `schemas()` localized on it as `EDITOR_GLOBAL`. Any
	 * other caller gets none of it.
	 *
	 * @param string $context A declared context.
	 * @param string $handle  The consumer's registered editor bundle.
	 * @api Called from consumer plugins' admin pages (cross-repo, invisible here).
	 * @return bool True when the editor loaded.
	 * @throws \LogicException When the context is not declared, or `$handle` is not registered.
	 * @throws \RuntimeException When a pattern's markup no longer validates.
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
		Block_Editor_Bootstrap::load_content_blocks();
		\wp_enqueue_script( $handle );
		\wp_localize_script( $handle, self::EDITOR_GLOBAL, $schemas );
		return true;
	}

	/**
	 * The editor's page data: the context, its block cap, and every block it
	 * admits with its title, attribute schemas and the two placement flags,
	 * the core blocks last, each marked `core` with the element an editor
	 * writes its text in (`text`), null for one that holds none, the
	 * patterns it offers, each as the tree `validate_shape()` answers for its
	 * markup, in declared order, so an editor builds its blocks without
	 * parsing, and the inline elements a text block keeps (`inline`).
	 *
	 * @param string $context A declared context.
	 * @return array{context: string, max_blocks: int, blocks: array<string,array{title: string, attributes: array<string,array<string,mixed>>, container: bool, multiple: bool, core: bool, text: ?string}>, patterns: list<array{name: string, title: string, blocks: Tree}>, inline: list<string>}
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When a pattern's markup no longer validates.
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
				'core'       => isset( self::CORE_BLOCKS[ $name ] ),
				'text'       => self::core_key( $name, 'text' ),
			];
		}
		$patterns = [];
		foreach ( $declared['patterns'] as $pattern ) {
			$patterns[] = [
				'name'   => $pattern['name'],
				'title'  => $pattern['title'],
				'blocks' => self::validate_shape( $context, $pattern['markup'] ),
			];
		}
		return [
			'context'    => $context,
			'max_blocks' => $declared['max_blocks'],
			'blocks'     => $blocks,
			'patterns'   => $patterns,
			'inline'     => \array_keys( self::INLINE_HTML ),
		];
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
		return self::read_file( $context, self::context_of( $context )['default'], 'its default layout' );
	}

	/**
	 * Declare the substrate's shared blocks on `FILTER` at priority 5, so a
	 * consumer at the default priority can admit them: the stats,
	 * time-chart, table, log-stream and sparkline blocks, each reading the
	 * source its `source` attribute names, and the section, a container, so
	 * it stands only at the top, in a column or in a group; and the
	 * station's composed pages and the blocks they alone hold
	 * (`Station_Pages`).
	 *
	 * @param array<mixed> $declared What the filter holds so far.
	 * @return array<mixed>
	 * @throws \LogicException When an earlier filter declared `newspack-nodes`.
	 */
	public static function declare_substrate_blocks( array $declared ): array {
		if ( isset( $declared['newspack-nodes'] ) ) {
			self::refuse_declaration( 'newspack-nodes', 'newspack-nodes', 'belongs to the substrate, which declares its own blocks there' );
		}
		$declared['newspack-nodes'] = [
			'blocks'   => self::SUBSTRATE_BLOCKS + Station_Pages::BLOCKS,
			'contexts' => Station_Pages::contexts(),
		];
		return $declared;
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
			if ( 'core' === $namespace ) {
				self::refuse_declaration( $namespace, $namespace, 'belongs to WordPress, whose blocks every context admits' );
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
			'patterns'   => self::patterns( $namespace, $name, $context['patterns'] ?? [] ),
		];
	}

	/**
	 * One context's patterns, each a slug, a title and the markup of an
	 * existing file, read once here.
	 *
	 * @param mixed $patterns Its `patterns`.
	 * @return list<array{name: string, title: string, markup: string}>
	 * @throws \LogicException When a pattern breaks a rule.
	 */
	private static function patterns( string $namespace, string $context, mixed $patterns ): array {
		if ( ! \is_array( $patterns ) || ( [] !== $patterns && \array_is_list( $patterns ) ) ) {
			self::refuse_declaration( $namespace, $context, 'declares patterns that are not a map of slug => { title, file }' );
		}
		$out = [];
		foreach ( $patterns as $slug => $pattern ) {
			$slug = (string) $slug;
			if ( 1 !== \preg_match( self::NAMESPACE_PATTERN, $slug ) ) {
				self::refuse_declaration( $namespace, $context, "pattern {$slug} is not a slug: lowercase letters, digits and hyphens" );
			}
			if ( ! \is_array( $pattern ) ) {
				self::refuse_declaration( $namespace, $context, "pattern {$slug} is not a { title, file } map" );
			}
			$title = $pattern['title'] ?? null;
			if ( ! \is_string( $title ) || '' === $title ) {
				self::refuse_declaration( $namespace, $context, "pattern {$slug} declares no title" );
			}
			$file = $pattern['file'] ?? null;
			if ( ! \is_string( $file ) || ! \str_starts_with( $file, '/' ) || ! \is_file( $file ) ) {
				Core::print_less_often( "composition declaration {$namespace}: {$context} pattern {$slug} names no layout file: ", Core::as_string( $file ) );
				self::refuse_declaration( $namespace, $context, "pattern {$slug} names no layout file" );
			}
			try {
				$markup = self::read_file( $context, $file, "the pattern {$slug}" );
			} catch ( \RuntimeException ) {
				self::refuse_declaration( $namespace, $context, "pattern {$slug} will not read" );
			}
			$out[] = [
				'name'   => $slug,
				'title'  => $title,
				'markup' => $markup,
			];
		}
		return $out;
	}

	/**
	 * A consumer's markup file, as it holds.
	 *
	 * @param string $what What the file is, in the refusal's words.
	 * @throws \RuntimeException When the file will not read, which names no path.
	 */
	private static function read_file( string $context, string $path, string $what ): string {
		\error_clear_last();
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- a consumer's own markup file.
		$markup = @\file_get_contents( $path );
		if ( false === $markup ) {
			Core::print_less_often( "composition {$context}: {$what} will not read: ", \error_get_last()['message'] ?? 'no cause reported' );
			self::refuse( $context, "{$what} will not read" );
		}
		return $markup;
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
		$tree    = self::nodes( $context, self::blocks_for( $context ), \parse_blocks( $markup ), null, 0, $singles );
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
	 * @param ?string             $parent   The block holding them, null at the top.
	 * @param int                 $depth    How many blocks hold them, 0 at the top.
	 * @param array<string,true>  $singles  Seen single-standing names.
	 * @return Tree
	 * @throws \RuntimeException On the first rule broken.
	 */
	private static function nodes( string $context, array $standing, array $blocks, ?string $parent, int $depth, array &$singles ): array {
		$nodes = [];
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
			$spec = self::declarations()['blocks'][ $name ] ?? self::CORE_BLOCKS[ $name ] ?? null;
			if ( null === $spec ) {
				self::refuse( $context, "{$name} is not a declared block" );
			}
			if ( ! isset( $standing[ $name ] ) ) {
				self::refuse( $context, "{$name} does not stand on {$context}" );
			}
			$inner = Core::arr( $block['innerBlocks'] ?? [] );
			self::place( $context, $name, $spec, $parent, $depth, [] !== $inner );
			if ( ! $spec['multiple'] ) {
				if ( isset( $singles[ $name ] ) ) {
					self::refuse( $context, "a second {$name}; it stands once" );
				}
				$singles[ $name ] = true;
			}
			$html       = \trim( \implode( '', \array_filter( Core::arr( $block['innerContent'] ?? [] ), 'is_string' ) ) );
			$attributes = self::attributes( $context, $name, $block['attrs'] ?? null, $spec['attributes'] );
			$text       = self::text_of( $context, $name, $html );
			if ( null !== $text ) {
				$attributes['content'] = $text;
			}
			$nodes[] = [
				'name'       => $name,
				'attributes' => $attributes,
				'inner'      => self::nodes( $context, $standing, $inner, $name, $depth + 1, $singles ),
			];
		}
		return $nodes;
	}

	/**
	 * Refuse a block standing where it may not: deeper than `MAX_DEPTH`, a
	 * `part` of its parent excepted, outside the one block it stands in, in a
	 * block holding only another, a container anywhere but the top, a column
	 * or a group, and any other block holding blocks.
	 *
	 * @param Block   $spec      The block's declaration.
	 * @param ?string $parent    The block holding it, null at the top.
	 * @param int     $depth     How many blocks hold it.
	 * @param bool    $has_inner Whether it holds blocks.
	 * @throws \RuntimeException On the first rule broken.
	 */
	private static function place( string $context, string $name, array $spec, ?string $parent, int $depth, bool $has_inner ): void {
		$in = self::core_key( $name, 'in' );
		if ( $depth > self::MAX_DEPTH && ! isset( self::CORE_BLOCKS[ $name ]['part'] ) ) {
			self::refuse( $context, "{$name} stands deeper than " . self::MAX_DEPTH . ' blocks' );
		}
		if ( null !== $in && $parent !== $in ) {
			self::refuse( $context, "{$name} stands only in {$in}" );
		}
		$holds = null === $parent ? null : self::core_key( $parent, 'holds' );
		if ( null !== $holds && $holds !== $name ) {
			self::refuse( $context, "{$parent} holds only {$holds}" );
		}
		if ( $spec['container'] && null === $in && null !== $parent && ! \in_array( $parent, self::LAYOUT_HOLDERS, true ) ) {
			self::refuse( $context, "{$name} stands only at the top, in a column or in a group" );
		}
		if ( $has_inner && ! $spec['container'] && null === self::core_key( $name, 'holds' ) ) {
			self::refuse( $context, "{$name} holds no blocks" );
		}
	}

	/**
	 * The text of a heading, a paragraph or a list item, inside the element core
	 * writes it as, holding no comment, filtered to `INLINE_HTML`; null for
	 * any other block, whose HTML must be its own element alone, and a
	 * declared block's none.
	 *
	 * @param string $html The block's own HTML, its children's left out.
	 * @return ?string The text.
	 * @throws \RuntimeException When the block holds HTML it may not.
	 */
	private static function text_of( string $context, string $name, string $html ): ?string {
		$tag = self::core_key( $name, 'reads' );
		if ( null === $tag ) {
			if ( '' !== $html ) {
				self::refuse( $context, "{$name} holds HTML; a layout holds no HTML" );
			}
			return null;
		}
		if ( null !== self::core_key( $name, 'text' ) ) {
			if ( 1 !== \preg_match( "#^<({$tag})(?:\\s[^>]*)?>(.*)</\\1>\$#is", $html, $match ) ) {
				self::refuse( $context, "{$name} holds HTML outside its own element" );
			}
			// wp_kses() rebuilds a comment, which can then read as a delimiter.
			if ( \str_contains( $match[2], '<!--' ) ) {
				self::refuse( $context, "{$name} holds a comment; its text holds inline formatting only" );
			}
			return \wp_kses( $match[2], self::INLINE_HTML );
		}
		$element = "<({$tag})(?:\\s[^>]*)?(?:/>|>(?:\\s*</\\1>)?)";
		if ( 1 !== \preg_match( "#^(?:{$element})?\$#is", $html ) ) {
			self::refuse( $context, "{$name} holds HTML outside its own element" );
		}
		return null;
	}

	/**
	 * One of a core block's element or placement keys, null for a block that
	 * is not core or a key it does not declare.
	 *
	 * @param string $name A block name.
	 * @param string $key  `reads`, `text`, `in` or `holds`.
	 */
	private static function core_key( string $name, string $key ): ?string {
		$value = self::CORE_BLOCKS[ $name ][ $key ] ?? null;
		return null === $value ? null : Core::as_string( $value );
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
			if ( \array_key_exists( 'default', $schema ) ) {
				$defaults[ $attribute ] = $schema['default'];
			}
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
	 * The blocks that stand on a context: those declaring it among their
	 * `contexts`, the shared blocks it admits, and the core blocks every
	 * context admits.
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
		return $blocks + self::CORE_BLOCKS;
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
		if ( null !== self::$declarations ) {
			return self::$declarations;
		}
		$declared           = self::declare( \apply_filters( self::FILTER, [] ) );
		// Read by validate_shape() in the pattern pass; a throw clears it.
		self::$declarations = $declared;
		try {
			self::check_patterns( $declared['contexts'] );
		} catch ( \Throwable $refused ) {
			self::$declarations = null;
			throw $refused;
		}
		return $declared;
	}

	/**
	 * Hold every context's patterns to `validate_shape()`, which reads the
	 * declarations standing, so the pass runs once they are stored.
	 *
	 * @param array<string,Context> $contexts Every context declared.
	 * @throws \LogicException On the first pattern that will not read or validate.
	 */
	private static function check_patterns( array $contexts ): void {
		foreach ( $contexts as $name => $context ) {
			foreach ( $context['patterns'] as $pattern ) {
				$slug = $pattern['name'];
				try {
					self::validate_shape( $name, $pattern['markup'] );
				} catch ( \RuntimeException $refused ) {
					self::refuse_declaration( $context['namespace'], $name, "pattern {$slug} breaks the layout rules: " . $refused->getMessage() );
				}
			}
		}
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
