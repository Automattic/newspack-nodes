<?php
/**
 * Classes_CI: command-dispatch for substrate class-catalog verbs.
 *
 * Replaces legacy class-classes-controller.php (the GET /classes REST
 * endpoint) with a CommandInterpreter the M3 Command_Controller mounts
 * alongside the other substrate-side CIs.
 *
 * Verbs:
 *   list — enumerate every class registered via
 *          CommandInterpreter::register_class(), inline its node_schema(),
 *          filter out the Hidden category (plumbing — Shell, Dumper, CI,
 *          Router), sort by `[category, shell_name]`, and bundle the
 *          Formatters registry alongside so the topology-editor palette
 *          can populate its `formatter_name` arg dropdown in one
 *          round-trip.
 *
 * Substrate state is process-global (CommandInterpreter's class_map and
 * Formatters' registry are static), so there are no constructor
 * dependencies to inject — the M2 dep-injection pattern (Workers_CI takes
 * Cli + Cache) doesn't apply here. The ctor is just a verb-table install.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Formatters;

\defined( 'ABSPATH' ) || exit;

class Classes_CI extends CommandInterpreter {

	public function __construct() {
		// Node + CommandInterpreter have no explicit __construct, so the
		// inherited no-op is implicit. Mirrors M2's Workers_CI (and
		// substrate's RequestBuilder / FlameBuilder), which extend Node
		// and also skip the parent call.
		$this->commands( $this->verb_table() );
	}

	private function verb_table(): array {
		return [
			'list' => static function ( CommandInterpreter $self, string $args, array $envelope = [] ): array {
				$classes = [];
				foreach ( CommandInterpreter::class_map() as $shell_name => $fqcn ) {
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
