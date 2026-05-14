<?php
/**
 * ClassesController — GET /newspack-nodes/v1/classes
 *
 * Returns the topology editor's palette catalog: one entry per class
 * registered via CommandInterpreter::register_class(), with the full
 * node_schema() inlined. Classes whose category is `'Hidden'` are
 * filtered out (plumbing — Shell, Dumper, CI, Router, test fixtures).
 *
 * Read-only; idempotent; manage_options cap; no nonce.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\CommandInterpreter;

\defined( 'ABSPATH' ) || exit;

class ClassesController {
	private const REST_NAMESPACE = 'newspack-nodes/v1';

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			'/classes',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_classes' ],
				'permission_callback' => [ $this, 'check_permission' ],
			]
		);
	}

	public function check_permission(): bool|\WP_Error {
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

	public function get_classes( \WP_REST_Request $request ): \WP_REST_Response {
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
				'shell_name'  => $shell_name,
				'fqcn'        => $fqcn,
				'category'    => $cat,
				'description' => $schema['description'] ?? '',
				'ctor'        => $schema['ctor']  ?? [],
				'verbs'       => $schema['verbs'] ?? [],
			];
		}
		\usort(
			$classes,
			static fn ( $a, $b ) =>
				[ $a['category'], $a['shell_name'] ] <=>
				[ $b['category'], $b['shell_name'] ]
		);
		return new \WP_REST_Response( [ 'classes' => $classes ], 200 );
	}
}
