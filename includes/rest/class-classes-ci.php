<?php
/**
 * Classes_CI: command-dispatch for substrate class-catalog verbs.
 *
 * Verb `list` enumerates every registered class, inlines its node_schema(),
 * drops the Hidden category, sorts by `[category, shell_name]`, and bundles
 * the Formatters registry for the topology-editor palette's arg dropdown.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Formatters;

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
				$classes = [];
				foreach ( Command_Interpreter_Node::class_map() as $shell_name => $fqcn ) {
					if ( ! \method_exists( $fqcn, 'node_schema' ) ) {
						continue;
					}
					$schema = $fqcn::node_schema();
					$cat    = $schema['category'] ?? 'Unknown';
					if ( 'Hidden' === $cat ) {
						continue;
					}
					$classes[] = [
						'shell_name'   => $shell_name,
						'fqcn'         => $fqcn,
						'category'     => $cat,
						'description'  => $schema['description'] ?? '',
						'ctor'         => $schema['ctor']     ?? [],
						'verbs'        => $schema['verbs']    ?? [],
						'requests'     => $schema['requests'] ?? [],
						'accepts_fill' => (bool) ( $schema['accepts_fill'] ?? true ),
						'has_target'   => (bool) ( $schema['has_target']   ?? true ),
					];
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
}
