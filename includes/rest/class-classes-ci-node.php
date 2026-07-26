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
	 * `list` verb handler — the editor palette catalog: every registered concrete Node class with its serializable schema fields, plus formatters.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_list(): array {
		$prefixes = Command_Interpreter_Node::registered_namespaces();
		$seen     = [];
		$classes  = [];
		foreach ( ClassLoader::getRegisteredLoaders() as $loader ) {
			foreach ( \array_keys( $loader->getClassMap() ) as $fqcn ) {
				if ( isset( $seen[ $fqcn ] ) ) {
					continue;
				}
				// (a) under a registered namespace prefix (string match).
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
				// (c) concrete Node subclass; node_schema() guaranteed by base.
				if ( ! \is_subclass_of( $fqcn, Node::class ) ) {
					continue;
				}
				if ( ( new \ReflectionClass( $fqcn ) )->isAbstract() ) {
					continue;
				}
				$schema = $fqcn::node_schema();
				$cat    = $schema['category'] ?? '';
				// (e) skip non-palette: Hidden, empty category, or hidden flag.
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
					// Strip non-serializable handler; keep palette fields.
					'commands'        => self::strip_commands( Core::arr( $schema_commands ) ),
					'requests'     => $schema['requests'] ?? [],
					// Valid register events; inspector UI lists them per node.
					'registrations' => $schema['registrations'] ?? [],
					'accepts_fill' => (bool) ( $schema['accepts_fill'] ?? true ),
					'has_target'   => (bool) ( $schema['has_target']   ?? true ),
					// Interpreter node → bare target, else <name>:config.
					'is_interpreter' => \is_subclass_of( $fqcn, Command_Interpreter_Node::class ),
					// Fan-out (target LIST) → multi-chip editor + tail.
					'fans_out'         => Core::class_fans_out( $fqcn ),
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
	}

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
			// Carry the multiple flag: console renders one row per invocation.
			if ( ! empty( $command['multiple'] ) ) {
				$stripped_command['multiple'] = true;
			}
			// Carry the hidden flag → inspector drops the standalone verb.
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
					'capability'  => 'read',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_list(),
				],
			],
		] );
	}

}
