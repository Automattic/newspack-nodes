<?php
/**
 * Status_CI: command-dispatch for the health/version probe surface.
 *
 * Mounts at priority 11 alongside the rest of the M2 service CIs and
 * declares its verb via the v0.6.0 schema-driven pattern — the inherited
 * Service_CI_Node ctor builds the commands table from node_schema(), so
 * there's no per-class ctor and the catalog scan picks the verb up
 * automatically.
 *
 * Verbs:
 *   get — return runtime version, partition count, the substrate's active
 *         topology set, cache reachability, and a wall-clock timestamp.
 *         Enough for an admin dashboard to render a "is this thing alive?"
 *         surface without making a dozen separate calls.
 *
 * The substrate Config is a global accessed directly, matching the legacy
 * controller. `cache_available` reflects whether the shared `Core::$memd`
 * handle is configured.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

class Status_CI_Node extends Service_CI_Node {

	/** @api Used by the substrate to provide UI etc. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Health/version probe: runtime version, partition count, active topologies, cache reachability, timestamp.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'description' => 'Return a single-shot health snapshot for the admin "is this thing alive?" panel.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						$config          = RuntimeConfig::load_config();
						$cache_available = null !== Core::$memd;
						/** @var int|float|string|bool|null $num_partitions */
						$num_partitions = $config['num_partitions'] ?? 1;

						return [
							'status'          => 'ok',
							'runtime_version' => \defined( 'NEWSPACK_NODES_VERSION' ) ? \NEWSPACK_NODES_VERSION : 'unknown',
							'num_partitions'  => (int) $num_partitions,
							'topologies'      => \array_keys( Bootstrap::get_topologies() ),
							'cache_available' => $cache_available,
							'timestamp'       => \time(),
						];
					},
				],
			],
		] );
	}
}
