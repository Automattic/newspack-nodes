<?php
/**
 * TopologiesController
 *   GET  /newspack-nodes/v1/topologies         (Task 4)
 *   POST /newspack-nodes/v1/topologies/{name}  (Task 5)
 *
 * GET is read-only (manage_options cap, no nonce).
 * POST writes a TSL file and triggers fleet restart for active names
 * (manage_options cap + wp_verify_nonce).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Config;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class TopologiesController {
	private const REST_NAMESPACE = 'newspack-nodes/v1';
	public  const NONCE_ACTION   = 'newspack_nodes_save_topology';

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			'/topologies',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_topologies' ],
				'permission_callback' => [ $this, 'check_read_permission' ],
			]
		);
		// POST registration lands in Task 5.
	}

	public function check_read_permission(): bool|\WP_Error {
		if ( ! \function_exists( 'current_user_can' )
			|| ! \current_user_can( 'manage_options' ) ) {
			return new \WP_Error(
				'rest_forbidden',
				'manage_options capability required.',
				[ 'status' => 403 ]
			);
		}
		return true;
	}

	public function get_topologies( \WP_REST_Request $request ): \WP_REST_Response {
		$config = Config::load_config();
		$active = \is_array( $config['topologies'] ?? null )
			? \array_flip( $config['topologies'] )
			: [];

		$out = [];
		foreach ( Topology_Registry::describe() as $name => $sources ) {
			$has_user  = null !== $sources['user'];
			$has_stock = ! empty( $sources['stock'] );
			$source    = ( $has_user && $has_stock )
				? 'both'
				: ( $has_user ? 'user' : 'stock' );

			$out[] = [
				'name'        => $name,
				'source'      => $source,
				'active'      => isset( $active[ $name ] ),
				'frontmatter' => Topology_Registry::frontmatter( $name ),
			];
		}
		\usort( $out, static fn ( $a, $b ) => $a['name'] <=> $b['name'] );

		return new \WP_REST_Response(
			[
				'topologies' => $out,
				'user_dir'   => Topology_Registry::user_dir(),
			],
			200
		);
	}
}
