<?php
/**
 * Classes_CI: command-dispatch for substrate class-catalog commands.
 *
 * Command `list` scans the composer classmap for concrete `*_Node` classes under
 * a registered namespace prefix, inlines each node_schema(), drops the Hidden
 * category, sorts by `[category, shell_name]`, and bundles the Formatters
 * registry for the topology-editor palette's arg dropdown.
 *
 * Like the other service interpreters, this extends Service_CI_Node: each verb is
 * declared once in node_schema() carrying its handler, and the base constructor
 * derives the dispatch table from it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Composer\Autoload\ClassLoader;
use Newspack_Nodes\Core;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Formatters;
use Newspack_Nodes\Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tee_Node;

\defined( 'ABSPATH' ) || exit;

class Classes_CI_Node extends Service_CI_Node {

	/**
	 * Strip a node_schema's commands[] to the serializable palette shape
	 * `{name, description, args}`, dropping the non-serializable `handler`.
	 *
	 * Fail-soft: a malformed command (non-array entry, or one with no/empty name)
	 * is skipped rather than throwing — a single bad class must not fatal the
	 * whole catalog `list`, which scans every registered class. Returns a
	 * sequential list (JSON array) so the editor palette consumes it as-is.
	 *
	 * @param array<int|string,mixed> $commands Raw commands[] from a node_schema.
	 * @return array<int,array{name:string,description:string,args:mixed}>
	 */
	private static function strip_commands( array $commands ): array {
		$stripped = [];
		foreach ( $commands as $command ) {
			if ( ! \is_array( $command ) ) {
				continue;
			}
			$raw_name = $command['name'] ?? '';
			$name     = Core::as_string( $raw_name );
			if ( '' === $name ) {
				continue;
			}
			$raw_desc        = $command['description'] ?? '';
			$stripped_command = [
				'name'        => $name,
				'description' => Core::as_string( $raw_desc ),
				'args'        => $command['args'] ?? [],
			];
			// Carry the multi-invocation flag so the topology console renders one
			// row per invocation (N add_setting mappings), not just the first. Added
			// only when set so single-verb catalog entries keep their lean shape.
			if ( ! empty( $command['multiple'] ) ) {
				$stripped_command['multiple'] = true;
			}
			// Carry the hidden flag so the inspector can drop the standalone verb
			// button (transport verbs are driven by their own UI). Added only when
			// set so visible verbs keep their lean shape.
			if ( ! empty( $command['hidden'] ) ) {
				$stripped_command['hidden'] = true;
			}
			$stripped[] = $stripped_command;
		}
		return $stripped;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Class catalog: enumerate every registered node class with its inlined node_schema, plus the formatter registry.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'description' => 'List registered classes (with schemas) and formatters.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
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
								// A node may also opt out of the palette while keeping a
								// functional category (SSE_In_Node: I/O but patron-configured).
								if ( 'Hidden' === $cat || '' === $cat || ! empty( $schema['hidden'] ) ) {
									continue;
								}
								$seen[ $fqcn ]   = true;
								$schema_commands = $schema['commands'] ?? [];
								$classes[]       = [
									'shell_name'   => \substr( $short, 0, -\strlen( '_Node' ) ),
									'fqcn'         => $fqcn,
									'category'     => $cat,
									'description'  => $schema['description'] ?? '',
									'arguments'    => $schema['arguments']   ?? [],
									// Strip the non-serializable `handler` closure: each command
									// is declared once in node_schema (carrying its handler for the
									// base interpreter's dispatch derivation); the catalog inlines only the
									// serializable fields the editor palette consumes. Skip any
									// malformed command (non-array, or no name) rather than fatal
									// the whole list (which scans every registered class) on a TypeError.
									'commands'        => self::strip_commands( \is_array( $schema_commands ) ? $schema_commands : [] ),
									'requests'     => $schema['requests'] ?? [],
									'accepts_fill' => (bool) ( $schema['accepts_fill'] ?? true ),
									'has_target'   => (bool) ( $schema['has_target']   ?? true ),
									// A node that IS a Command_Interpreter_Node handles its
									// commands directly (no `<name>:config` sibling), so the
									// console targets the bare node; otherwise `<name>:config`.
									'is_interpreter' => \is_subclass_of( $fqcn, Command_Interpreter_Node::class ),
									// A Tee-family node fans out to many targets — the Inspector
									// renders the multi-chip editor + tail button off this flag
									// (not the runtime target shape, which is a string in edit mode).
									'is_tee'         => \is_a( $fqcn, Tee_Node::class, true ),
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
				],
			],
		] );
	}
}
