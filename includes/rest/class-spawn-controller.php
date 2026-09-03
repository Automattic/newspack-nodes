<?php
/**
 * Spawn endpoint: the one gate every worker spawn crosses.
 *
 * `POST /newspack-nodes/v1/workers/spawn` takes `{type, partition, nonce}`. A
 * worker's own self-respawn, each worker's `_fleet` peer scan and the WP-Cron
 * cold-start pass all POST here, which is why the deploy hold and the
 * 15-second per-worker throttle are enforced at the endpoint rather than at
 * each spawner.
 *
 * Two ways in, both carrying `nonce`: the internal HMAC token minted for the
 * current 10-second window, or an external caller holding the `manage` role
 * and presenting a WordPress nonce.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Spawn_Coordinator;

\defined( 'ABSPATH' ) || exit;

/**
 * Admission control for the spawn endpoint.
 *
 * The controller authorizes the request, refuses a held or throttled fleet,
 * and fires `newspack_nodes/spawn_worker`. Building and running the worker
 * belongs to whichever handler that action reaches — in the substrate,
 * `Topology_Registry::spawn_worker`.
 */
class Spawn_Controller {

	/** WordPress nonce action name for external spawn requests. */
	public const NONCE_ACTION = 'newspack_nodes_spawn_worker';

	/** Per-user rate limit window for external spawn requests. */
	public const RATE_LIMIT_S = 2;

	/**
	 * The request's coordinator: it holds the salt the internal HMAC token
	 * validates against and the throttle window every spawner shares.
	 */
	private Spawn_Coordinator $coordinator;

	/**
	 * Bind the controller to the request's spawn coordinator.
	 *
	 * @param Spawn_Coordinator $coordinator Source of the HMAC salt and the throttle record.
	 */
	public function __construct( Spawn_Coordinator $coordinator ) {
		$this->coordinator = $coordinator;
	}

	/**
	 * Authorize a spawn request.
	 *
	 * A multisite subsite is refused first: locks, IPC and logs carry no blog
	 * namespace, so the fleet runs on the main site only. Then the internal
	 * HMAC token, accepted for the current or the previous 10-second window.
	 * Failing that, an external caller holding the `manage` role
	 * (`manage_options` until a site installs the granular capabilities) and
	 * presenting a valid WordPress nonce, one request per RATE_LIMIT_S.
	 *
	 * @param \WP_REST_Request $req Incoming spawn request.
	 * @return true|\WP_Error True when the caller may spawn; the refusal otherwise.
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		$raw_nonce = $req->get_param( 'nonce' );
		$nonce     = Core::as_string( $raw_nonce );
		if ( '' === $nonce ) {
			return new \WP_Error( 'invalid_token', 'Missing spawn token', [ 'status' => 403 ] );
		}

		// Internal HMAC path: no capability, no rate limit.
		if ( $this->coordinator->validate_spawn_token( $nonce, \time() ) ) {
			return true;
		}

		// Capability before rate limit, or any caller can write transients.
		if ( ! Capabilities::can( Capabilities::MANAGE ) ) {
			return new \WP_Error(
				'invalid_token',
				'Invalid spawn token',
				[ 'status' => 403 ]
			);
		}

		if ( ! \function_exists( 'wp_verify_nonce' ) || ! \wp_verify_nonce( $nonce, self::NONCE_ACTION ) ) {
			return new \WP_Error(
				'invalid_token',
				'Invalid spawn token',
				[ 'status' => 403 ]
			);
		}

		$rate_check = $this->check_rate_limit();
		if ( $rate_check instanceof \WP_Error ) {
			return $rate_check;
		}

		return true;
	}

	/**
	 * Hold external spawn requests to one per RATE_LIMIT_S per user.
	 *
	 * The transient lives 10 seconds so it outlives the window it guards and
	 * then expires on its own, leaving nothing to sweep. Where the transient
	 * API is absent the caller passes rather than fatals.
	 *
	 * @return true|\WP_Error True when the caller may proceed; the refusal otherwise.
	 */
	protected function check_rate_limit() {
		if ( ! \function_exists( 'get_transient' ) || ! \function_exists( 'set_transient' ) ) {
			return true;
		}
		$user_id = \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
		$key     = 'newspack_nodes_spawn_rate:' . $user_id;
		$last    = \get_transient( $key );
		if ( false !== $last && \is_scalar( $last ) ) {
			$elapsed = \time() - (int) $last;
			if ( $elapsed < self::RATE_LIMIT_S ) {
				return new \WP_Error(
					'rate_limited',
					'Too many spawn requests; please wait a moment.',
					[ 'status' => 429 ]
				);
			}
		}
		\set_transient( $key, \time(), 10 );
		return true;
	}

	/**
	 * Accept or refuse an authorized spawn, then run the worker.
	 *
	 * Three refusals, in order: a partition outside the type's range, a deploy
	 * hold, and the shared 15-second throttle. Recording the accepted spawn
	 * here is what gives every spawner one window to share.
	 *
	 * The action runs the worker inline for its whole lifetime — 595 seconds
	 * by default — which is why `ignore_user_abort()` and `set_time_limit()`
	 * come first: the caller POSTs fire-and-forget with a sub-second timeout
	 * and is long gone by the time this response is written.
	 *
	 * @param \WP_REST_Request $req Authorized spawn request.
	 * @return \WP_REST_Response|\WP_Error The accepted spawn, or the refusal.
	 */
	public function spawn( \WP_REST_Request $req ) {
		$raw_type      = $req->get_param( 'type' );
		$raw_partition = $req->get_param( 'partition' );
		$type          = Core::as_string( $raw_type );
		$partition     = Core::as_int( $raw_partition );

		if ( ! $this->validate_partition( $type, $partition ) ) {
			return new \WP_Error(
				'invalid_partition',
				'Partition out of range for worker type',
				[ 'status' => 400 ]
			);
		}

		// Held here: self_respawn() never touches the coordinator.
		$held = Spawn_Coordinator::hold();
		if ( $held > 0 ) {
			return new \WP_Error(
				'fleet_held',
				\sprintf( 'fleet held since %s; run `wp nodes start` to resume', \gmdate( 'c', $held ) ),
				[ 'status' => 409 ]
			);
		}

		$now = Core::right_now();
		if ( $this->coordinator->is_recently_spawned( $type, $partition, $now ) ) {
			return new \WP_Error(
				'spawn_throttled',
				\sprintf( '%s.p%d spawned less than %ds ago', $type, $partition, Spawn_Coordinator::MIN_SPAWN_INTERVAL_S ),
				[ 'status' => 429 ]
			);
		}
		$this->coordinator->record_spawn( $type, $partition, $now );

		\ignore_user_abort( true );
		\set_time_limit( 0 );

		// Worker context for sub-actions / logging.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;

		// Topology worker: owners hook this to build the graph and execute().
		\do_action( 'newspack_nodes/spawn_worker', $type, $partition );

		return new \WP_REST_Response(
			[
				'spawned'   => true,
				'type'      => $type,
				'partition' => $partition,
			],
			200
		);
	}

	/**
	 * Check a partition number against the type's active partition count.
	 *
	 * Valid is `[0, num_partitions)`, and never at or above MAX_PARTITIONS —
	 * the ceiling `Bootstrap::expand_workers()` clamps every topology to, past
	 * which a partition has no reader.
	 *
	 * @param string $type      Worker type, which is also the topology name.
	 * @param int    $partition Partition number.
	 * @return bool True when that partition of that type is spawnable.
	 */
	public function validate_partition( string $type, int $partition ): bool {
		if ( $partition < 0 ) {
			return false;
		}
		if ( $partition >= Spawn_Coordinator::MAX_PARTITIONS ) {
			return false;
		}

		$max = 0;
		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type && ( $w['partition'] + 1 ) > $max ) {
				$max = $w['partition'] + 1;
			}
		}
		if ( 0 === $max ) {
			// Unknown or deactivated type: no partition of it is spawnable.
			return false;
		}
		return $partition < $max;
	}

	/**
	 * Register `POST /newspack-nodes/v1/workers/spawn`.
	 *
	 * `type` is validated at the route, so an unknown one never reaches the
	 * handler. `partition` is only sanitized here: its legal range depends on
	 * `type`, so `spawn()` checks the pair.
	 */
	public function register_routes(): void {
		\register_rest_route(
			'newspack-nodes/v1',
			'/workers/spawn',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'spawn' ],
				'permission_callback' => [ $this, 'check_permission' ],
				'args'                => [
					'type'      => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
						'validate_callback' => [ $this, 'validate_worker_type' ],
					],
					'partition' => [
						'required'          => true,
						'sanitize_callback' => static fn ( $v ): int => Core::as_int( $v ),
					],
					'nonce'     => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					],
				],
			]
		);
	}

	/**
	 * Check a worker type against the active topology set.
	 *
	 * The route runs this as its `validate_callback`, so a type no active
	 * topology declares is refused before `spawn()` sees it. That is what
	 * keeps a POST from naming a topology the operator never activated:
	 * downstream, the type is the name `Topology_Loader` resolves to a `.tsl`.
	 *
	 * @param mixed $type Worker type, straight off the request.
	 * @return bool True when an active topology declares the type.
	 */
	public function validate_worker_type( $type ): bool {
		if ( ! \is_string( $type ) || '' === $type ) {
			return false;
		}

		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type ) {
				return true;
			}
		}
		return false;
	}
}
