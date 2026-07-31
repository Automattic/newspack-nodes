<?php
/**
 * ScaffoldCliCommand: `wp nodes scaffold <plugin|node|topology> <name>`.
 *
 * Generates the first-contact files a Nodes plugin needs, matching the
 * canonical shapes in docs/writing-a-plugin.md: composer classmap autoload,
 * `Topology_Registry::register_plugin()` bootstrap, `{Prefix}_{Name}_Node`
 * class naming (ADR-10), and a minimal working TSL topology.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Scaffold_CLI_Command {

	/** Starter version stamped into the generated plugin header. */
	private const STARTER_VERSION = '0.1.0';

	/**
	 * Generate starter files for a Nodes plugin, node class, or topology.
	 *
	 * `plugin` creates `./<slug>/` with a bootstrap, composer.json, one working
	 * example node, a topology wiring it, and a README. `node` and `topology`
	 * write a single file into the current plugin directory. Existing targets
	 * are never overwritten.
	 *
	 * ## OPTIONS
	 *
	 * <what>
	 * : What to scaffold: plugin, node, or topology.
	 *
	 * <name>
	 * : Plugin/topology slug (`[a-z0-9-]+`) or node class name (`[A-Za-z_]+`).
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes scaffold plugin my-pipeline
	 *     wp nodes scaffold node My_Filter
	 *     wp nodes scaffold topology nightly-sync
	 *
	 * @when after_wp_load
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function scaffold( array $args, array $assoc_args ): void {
		$what = $args[0] ?? '';
		$name = $args[1] ?? '';
		if ( '' === $what || '' === $name ) {
			\WP_CLI::error( 'Usage: wp nodes scaffold <plugin|node|topology> <name>' );
		}

		switch ( $what ) {
			case 'plugin':
				$files = $this->scaffold_plugin( $name );
				break;
			case 'node':
				$files = $this->scaffold_node( $name );
				break;
			case 'topology':
				$files = $this->scaffold_topology( $name );
				break;
			default:
				\WP_CLI::error( "Unknown scaffold target: {$what}. Use plugin, node, or topology." );
				return;
		}

		foreach ( $files as $file ) {
			\WP_CLI::log( "Created {$file}" );
		}
		\WP_CLI::log( 'Next steps:' );
		\WP_CLI::log( '  1. composer dump-autoload -o   (make_node and the console palette read the classmap)' );
		\WP_CLI::log( '  2. wp nodes activate <topology>, then wp nodes status' );
		\WP_CLI::success( \sprintf( 'Generated %d file(s).', \count( $files ) ) );
	}

	/**
	 * Create `./<slug>/` with the five canonical starter files.
	 *
	 * @param string $slug Plugin slug.
	 * @return array<int, string> Paths written, relative to cwd.
	 */
	private function scaffold_plugin( string $slug ): array {
		self::require_slug( $slug );
		$prefix = self::prefix_from_slug( $slug );

		$files = [
			"{$slug}/{$slug}.php"                     => $this->plugin_bootstrap_template( $slug, $prefix ),
			"{$slug}/composer.json"                   => $this->composer_template( $slug ),
			"{$slug}/includes/class-{$slug}-node.php" => $this->node_template( $prefix, $prefix, $slug ),
			"{$slug}/topologies/{$slug}.tsl"          => $this->plugin_topology_template( $slug, $prefix ),
			"{$slug}/README.md"                       => $this->readme_template( $slug ),
		];

		self::refuse_existing( \array_keys( $files ) );
		foreach ( $files as $path => $content ) {
			self::write_file( $path, $content );
		}
		return \array_keys( $files );
	}

	/** `WP_CLI::error` (exits) unless $slug matches `[a-z0-9-]+`. */
	private static function require_slug( string $slug ): void {
		if ( 1 !== \preg_match( '/^[a-z0-9-]+$/', $slug ) ) {
			\WP_CLI::error( "Invalid slug: {$slug}. Use lowercase letters, digits, and dashes only, e.g. my-pipeline." );
		}
	}

	/** Derive the PHP namespace/class prefix from a slug: `my-pipeline` → `My_Pipeline`. */
	private static function prefix_from_slug( string $slug ): string {
		$slug  = (string) \preg_replace( '/[^a-z0-9-]+/', '-', \strtolower( $slug ) );
		$parts = \array_filter( \explode( '-', $slug ), static fn ( string $p ): bool => '' !== $p );
		return \implode( '_', \array_map( 'ucfirst', $parts ) );
	}

	/** The plugin bootstrap: header + deferred `register_plugin()` call (tutorial §1/§8). */
	private function plugin_bootstrap_template( string $slug, string $prefix ): string {
		$title   = \str_replace( '_', ' ', $prefix );
		$version = self::STARTER_VERSION;
		return <<<PHP
<?php
/**
 * Plugin Name: {$title}
 * Description: A Newspack Nodes plugin (scaffolded by `wp nodes scaffold`).
 * Version: {$version}
 * Requires PHP: 8.2
 * Requires Plugins: newspack-nodes
 *
 * @package {$prefix}
 */

namespace {$prefix};

\\defined( 'ABSPATH' ) || exit;

// Defer to plugins_loaded: the substrate may load after us; no-op without it.
\\add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! \\class_exists( '\\Newspack_Nodes\\Topology_Registry' ) ) {
			return;
		}
		require_once __DIR__ . '/vendor/autoload.php';

		// One call: the namespace (make_node resolves your *_Node classes)
		// and the topologies/ dir, whose *.tsl become catalog entries.
		\\Newspack_Nodes\\Topology_Registry::register_plugin(
			'{$prefix}\\\\',
			__DIR__ . '/topologies'
		);
	},
	12
);

PHP;
	}

	/**
	 * composer.json with the classmap autoload `make_node` reads (tutorial §1).
	 *
	 * @param string $slug Plugin slug.
	 */
	private function composer_template( string $slug ): string {
		return <<<JSON
{
	"name": "{$slug}/{$slug}",
	"description": "A Newspack Nodes plugin.",
	"require": {
		"php": ">=8.2"
	},
	"autoload": {
		"classmap": [
			"includes/"
		]
	}
}

JSON;
	}

	/**
	 * One working example node: a TM_STRUCT transform with `fill()`,
	 * `arguments`, and `node_schema()` (tutorial §3 shape).
	 *
	 * @param string $namespace PHP namespace for the class.
	 * @param string $class     Class name without the `_Node` suffix.
	 * @param string $kebab     Kebab-case form, used as the default label.
	 */
	private function node_template( string $namespace, string $class, string $kebab ): string {
		return <<<PHP
<?php
/**
 * {$class}_Node: forwards each TM_STRUCT item with a label added.
 *
 * @package {$namespace}
 */

namespace {$namespace};

use Newspack_Nodes\\Node;
use Newspack_Nodes\\Message;

\\defined( 'ABSPATH' ) || exit;

class {$class}_Node extends Node {

	/** Label stamped onto each forwarded item; the node's one argument. */
	private string \$label = '{$kebab}';

	public function arguments( ?array \$args = null ): array {
		if ( null !== \$args ) {
			\$this->arguments = \$args;
			\$token           = \$args[0] ?? '';
			\$this->label     = '' !== \$token ? \$token : '{$kebab}';
		}
		return \$this->arguments;
	}

	public function fill( array \$message ): void {
		if ( 0 === ( \$message[ Message::TYPE ] & Message::TM_STRUCT ) ) {
			return;
		}
		\$item = \$message[ Message::VALUE ];
		if ( ! \\is_array( \$item ) ) {
			return;
		}
		\$item['label'] = \$this->label;

		\$out                   = Message::new_message();
		\$out[ Message::TYPE ]  = Message::TM_STRUCT;
		\$out[ Message::FROM ]  = \$this->name;
		\$out[ Message::VALUE ] = \$item;
		// parent::fill stamps TO from the connected target, then sinks.
		parent::fill( \$out );
	}

	public static function node_schema(): array {
		return \\array_merge( parent::node_schema(), [
			'category'    => 'Transform',
			'description' => 'Forwards each TM_STRUCT item with a label added.',
			'arguments'   => [
				[ 'name' => 'label', 'type' => 'string', 'default' => '{$kebab}', 'description' => 'Label added to each forwarded item.' ],
			],
		] );
	}
}

PHP;
	}

	/**
	 * The plugin topology: wire the scaffolded node into a stock Log (tutorial §5).
	 *
	 * @param string $slug   Plugin slug (node instance + file names).
	 * @param string $prefix Node type as `make_node` resolves it.
	 */
	private function plugin_topology_template( string $slug, string $prefix ): string {
		return <<<TSL
# {$slug} — scaffolded starter graph: {$slug} → log.
# Drive it by hand: wp nodes cli {$slug}.p0
var num_partitions = 1
make_node {$prefix} {$slug}
make_node Log       log <config:logs_dir>/{$slug}-out 1 2 7
connect_node {$slug} log

TSL;
	}

	/**
	 * README pointing back at the substrate docs.
	 *
	 * @param string $slug Plugin slug.
	 */
	private function readme_template( string $slug ): string {
		return <<<MD
# {$slug}

A [Newspack Nodes](https://github.com/Automattic/newspack-nodes) plugin,
scaffolded by `wp nodes scaffold plugin {$slug}`.

## Setup

```bash
composer dump-autoload -o    # rerun after adding or renaming a node class
wp plugin activate {$slug}
wp nodes activate {$slug}
wp nodes status
```

## Learn the substrate

Start with the newspack-nodes docs: `docs/getting-started.md`, then
`docs/writing-a-plugin.md` — this scaffold matches that walkthrough's shapes.

MD;
	}

	/**
	 * `WP_CLI::error` (exits) if any target already exists — never overwrite.
	 *
	 * @param array<int, string> $paths Paths relative to cwd.
	 */
	private static function refuse_existing( array $paths ): void {
		foreach ( $paths as $path ) {
			if ( \file_exists( $path ) ) {
				\WP_CLI::error( "Refusing to overwrite existing file: {$path}" );
			}
		}
	}

	/** Write $content to $path (relative to cwd), creating parent dirs; fail loud. */
	private static function write_file( string $path, string $content ): void {
		$dir = \dirname( $path );
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir -- CLI scaffolder writing into the operator's cwd.
			if ( ! @\mkdir( $dir, 0755, true ) && ! \is_dir( $dir ) ) {
				\WP_CLI::error( "Cannot create directory: {$dir}" );
			}
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents -- CLI scaffolder writing into the operator's cwd.
		if ( false === \file_put_contents( $path, $content ) ) {
			\WP_CLI::error( "Cannot write file: {$path}" );
		}
	}

	/**
	 * Write one node class into the cwd plugin's includes/.
	 *
	 * @param string $class Class name (with or without the `_Node` suffix).
	 * @return array<int, string> Paths written, relative to cwd.
	 */
	private function scaffold_node( string $class ): array {
		if ( 1 !== \preg_match( '/^[A-Za-z_]+$/', $class ) ) {
			\WP_CLI::error( "Invalid class name: {$class}. Use letters and underscores only, e.g. My_Filter." );
		}
		$class = (string) \preg_replace( '/_Node$/', '', $class );
		$kebab = \strtolower( \str_replace( '_', '-', $class ) );
		$path  = "includes/class-{$kebab}-node.php";

		self::refuse_existing( [ $path ] );
		self::write_file( $path, $this->node_template( self::prefix_from_slug( \basename( (string) \getcwd() ) ), $class, $kebab ) );
		return [ $path ];
	}

	/**
	 * Write one TSL topology (stock nodes only) into the cwd plugin's topologies/.
	 *
	 * @param string $name Topology name.
	 * @return array<int, string> Paths written, relative to cwd.
	 */
	private function scaffold_topology( string $name ): array {
		self::require_slug( $name );
		$path = "topologies/{$name}.tsl";

		self::refuse_existing( [ $path ] );
		self::write_file( $path, $this->stock_topology_template( $name ) );
		return [ $path ];
	}

	/**
	 * A stock-nodes-only topology so it runs before any custom class exists.
	 *
	 * @param string $name Topology name.
	 */
	private function stock_topology_template( string $name ): string {
		return <<<TSL
# {$name} — scaffolded starter graph (stock nodes only): echo → log.
# Replace Echo with your own node once `composer dump-autoload -o` knows it.
var num_partitions = 1
make_node Echo {$name}
make_node Log  log <config:logs_dir>/{$name}-out 1 2 7
connect_node {$name} log

TSL;
	}
}
