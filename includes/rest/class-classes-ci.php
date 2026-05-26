<?php
/**
 * Classes_CI: command-dispatch for substrate class-catalog verbs.
 *
 * Verb `list` scans the composer classmap for concrete `*_Node` classes under
 * a registered namespace prefix, inlines each node_schema(), drops the Hidden
 * category, sorts by `[category, shell_name]`, and bundles the Formatters
 * registry for the topology-editor palette's arg dropdown.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Composer\Autoload\ClassLoader;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Formatters;
use Newspack_Nodes\Node;

\defined( 'ABSPATH' ) || exit;

class Classes_CI_Node extends Command_Interpreter_Node {

	public function __construct() {
		$this->commands( $this->verb_table() );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Class catalog: enumerate every registered node class with its inlined node_schema, plus the formatter registry.',
			'ctor'        => [],
			'verbs'       => [
				[ 'name' => 'list', 'description' => 'List registered classes (with schemas) and formatters.', 'args' => [] ],
			],
		];
	}

	private function verb_table(): array {
		return [
			'list' => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
				$prefixes = Command_Interpreter_Node::registered_namespaces();
				$seen     = [];
				$classes  = [];
				foreach ( ClassLoader::getRegisteredLoaders() as $loader ) {
					foreach ( \array_keys( $loader->getClassMap() ) as $fqcn ) {
						if ( isset( $seen[ $fqcn ] ) ) {
							continue;
						}
						// (a) under a registered namespace prefix (string match —
						// includes sub-namespaces like `…\Rest\` and `…\App\`).
						$under = false;
						foreach ( $prefixes as $prefix ) {
							if ( \str_starts_with( $fqcn, $prefix ) ) {
								$under = true;
								break;
							}
						}
						if ( ! $under ) {
							continue;
						}
						// (b) short name ends with `_Node`.
						$short = \strpos( $fqcn, '\\' ) !== false
							? \substr( (string) \strrchr( $fqcn, '\\' ), 1 )
							: $fqcn;
						if ( ! \str_ends_with( $short, '_Node' ) ) {
							continue;
						}
						// (c) is a concrete Node subclass. node_schema() is guaranteed
						// (declared on the Node base), so no separate method_exists check.
						if ( ! \is_subclass_of( $fqcn, Node::class ) ) {
							continue;
						}
						if ( ( new \ReflectionClass( $fqcn ) )->isAbstract() ) {
							continue;
						}
						$schema = $fqcn::node_schema();
						$cat    = $schema['category'] ?? '';
						// (e) not Hidden, and has a real category — a class that
						// inherits Node's empty-category default (e.g. SSE_Out_Node,
						// a pure HTTP response writer) isn't a palette participant.
						if ( 'Hidden' === $cat || '' === $cat ) {
							continue;
						}
						$seen[ $fqcn ] = true;
						$classes[]     = [
							'shell_name'   => \substr( $short, 0, -\strlen( '_Node' ) ),
							'fqcn'         => $fqcn,
							'category'     => $cat,
							'description'  => $schema['description'] ?? '',
							'ctor'         => $schema['ctor']     ?? [],
							// Strip the non-serializable `handler` closure: each verb is
							// declared once in node_schema (carrying its handler for the
							// base CI's dispatch derivation); the catalog inlines only the
							// serializable fields the editor palette consumes. Skip any
							// malformed verb (non-array, or no name) rather than fatal the
							// whole list (which scans every registered class) on a TypeError.
							'verbs'        => self::strip_verbs( $schema['verbs'] ?? [] ),
							'requests'     => $schema['requests'] ?? [],
							'accepts_fill' => (bool) ( $schema['accepts_fill'] ?? true ),
							'has_target'   => (bool) ( $schema['has_target']   ?? true ),
							// A node that IS a Command_Interpreter_Node handles its
							// verbs directly (no `<name>:config` sibling), so the
							// console targets the bare node; otherwise `<name>:config`.
							'is_interpreter' => \is_subclass_of( $fqcn, Command_Interpreter_Node::class ),
						];
					}
				}
				\usort(
					$classes,
					static fn ( $a, $b ) =>
						[ $a['category'], $a['shell_name'] ] <=>
						[ $b['category'], $b['shell_name'] ]
				);
				$formatters = Formatters::list_names();
				\sort( $formatters );
				return [
					'classes'    => $classes,
					'formatters' => $formatters,
				];
			},
		];
	}

	/**
	 * Strip a node_schema's verbs[] to the serializable palette shape
	 * `{name, description, args}`, dropping the non-serializable `handler`.
	 *
	 * Fail-soft: a malformed verb (non-array entry, or one with no/empty name)
	 * is skipped rather than throwing — a single bad class must not fatal the
	 * whole catalog `list`, which scans every registered class. Returns a
	 * sequential list (JSON array) so the editor palette consumes it as-is.
	 *
	 * @param array<int|string,mixed> $verbs Raw verbs[] from a node_schema.
	 * @return array<int,array{name:string,description:string,args:mixed}>
	 */
	private static function strip_verbs( array $verbs ): array {
		$stripped = [];
		foreach ( $verbs as $verb ) {
			if ( ! \is_array( $verb ) || '' === (string) ( $verb['name'] ?? '' ) ) {
				continue;
			}
			$stripped[] = [
				'name'        => $verb['name'] ?? '',
				'description' => $verb['description'] ?? '',
				'args'        => $verb['args'] ?? [],
			];
		}
		return $stripped;
	}
}
