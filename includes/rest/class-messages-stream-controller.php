<?php
/**
 * Messages_Stream_Controller: one SSE endpoint for every subscription the
 * dashboards need (firehose / errors / completed / IPC worker outputs).
 * Replaces six legacy per-feed SSE controllers in
 * `newspack-event-logger-nodes` once M5 lands. The resolver treats log
 * partitions and worker IPC partitions uniformly — both surface as
 * `Consumer` instances the caller drains in a single loop.
 *
 * Task 17 (this file) wires the route, the CSV splitter, and the
 * subscription → Consumer resolver. Task 18 fills in the drain loop;
 * `stream()` returns a `{pending: true}` JSON placeholder until then.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Cli;
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer;

\defined( 'ABSPATH' ) || exit;

class Messages_Stream_Controller {
	use SSE_Helpers_Trait;

	public const REST_NAMESPACE = 'newspack-nodes/v1';
	public const ROUTE          = '/messages/stream';

	/**
	 * Test seam: overrides `Bootstrap::base_dir()` so unit tests can point
	 * the resolver at an isolated temp directory without touching Config.
	 */
	private ?string $base_dir = null;

	/**
	 * Test seam: overrides `Config::load_config()['num_partitions']` so
	 * log-partition subscriptions can be sized in a unit test without
	 * writing a per-test config file.
	 */
	private ?int $num_partitions = null;

	/**
	 * `Cli::attach_to_worker` seam. Lazily defaulted to a closure that
	 * wraps the real call; tests that need IPC isolation reassign in
	 * setUp. See `~/.claude/rules/test-seams.md`.
	 *
	 * Signature: `function ( string $reader_id, string $base_dir ): array`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $attach_to_worker = null;

	public function set_base_dir( string $dir ): void {
		$this->base_dir = $dir;
	}

	public function set_num_partitions( int $n ): void {
		$this->num_partitions = $n;
	}

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			self::ROUTE,
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'stream' ],
				'permission_callback' => static fn () => \current_user_can( 'manage_options' ),
				'args'                => [
					'subscribe' => [ 'required' => true,  'type' => 'string' ],
					'interval'  => [ 'required' => false, 'type' => 'integer', 'default' => 500 ],
					'positions' => [ 'required' => false, 'type' => 'string' ],
				],
			]
		);
	}

	/**
	 * Split the CSV `subscribe` query parameter into trimmed subscription
	 * names. Empty input → empty list; empty entries between commas are
	 * dropped so trailing/leading commas don't produce ghost entries.
	 *
	 * @return array<int,string>
	 */
	public function parse_subscriptions( string $raw ): array {
		if ( '' === $raw ) {
			return [];
		}
		$parts = \array_map( 'trim', \explode( ',', $raw ) );
		return \array_values( \array_filter( $parts, static fn ( $s ) => '' !== $s ) );
	}

	/**
	 * Resolve a subscription name to one-or-more `Consumer`s.
	 *
	 * Two shapes are recognized:
	 *   * `{type}.p{N}`         — IPC reader; one Consumer over the
	 *                             worker's output Partition (no offsetlog
	 *                             because cli/SSE sessions are ephemeral).
	 *                             Resolved via `Cli::attach_to_worker` so
	 *                             a missing worker fails fast.
	 *   * `{a-z0-9_-+}`         — log feed; one Consumer per partition
	 *                             rooted at `{base}/logs/{name}.log`. The
	 *                             caller's saved `$positions` (keyed by
	 *                             partition index) seed each Consumer's
	 *                             cursor; partitions without saved
	 *                             positions tail-seek with `'end'`.
	 *
	 * Anything that matches neither shape throws
	 * `InvalidArgumentException` (path-traversal guard for query input).
	 *
	 * @param string                $sub       Subscription name.
	 * @param array<int,mixed>|null $positions Saved positions, indexed by
	 *                                         partition number; each
	 *                                         value is whatever
	 *                                         `Consumer::next_offset`
	 *                                         accepts (magic string or
	 *                                         `{seg,off}` array).
	 *
	 * @return array<int,Consumer>
	 *
	 * @throws \InvalidArgumentException When `$sub` matches no allowed shape.
	 */
	public function open_subscription( string $sub, ?array $positions ): array {
		$base = $this->base_dir ?? Bootstrap::base_dir();

		if ( \preg_match( '/^[a-z0-9_-]+\.p\d+$/', $sub ) ) {
			$attach = self::$attach_to_worker ?? static function ( string $reader_id, string $base_dir ): array {
				return ( new Cli( $base_dir ) )->attach_to_worker( $reader_id );
			};
			$ipc = $attach( $sub, $base );
			// Empty offsetlog_base_dir disables checkpointing — cli/SSE
			// sessions tail-seek and never resume from a saved position.
			$consumer = new Consumer( $ipc['output'], 0, '' );
			$consumer->next_offset( 'end' );
			$consumer->set_stamp_as( $sub );
			return [ $consumer ];
		}

		if ( \preg_match( '/^[a-z0-9_-]+$/', $sub ) ) {
			$log_base   = "{$base}/logs/{$sub}.log";
			$partitions = $this->num_partitions ?? (int) ( Config::load_config()['num_partitions'] ?? 1 );
			$consumers  = [];
			for ( $p = 0; $p < $partitions; $p++ ) {
				$consumer = new Consumer( $log_base, $p, '' );
				if ( isset( $positions[ $p ] ) ) {
					$consumer->next_offset( $positions[ $p ] );
				} else {
					$consumer->next_offset( 'end' );
				}
				$consumer->set_stamp_as( $sub );
				$consumers[] = $consumer;
			}
			return $consumers;
		}

		throw new \InvalidArgumentException(
			\esc_html( "invalid subscription: {$sub}" )
		);
	}

	/**
	 * Stream handler — placeholder until Task 18 lands the drain loop.
	 * Returns a JSON `{pending: true}` body so a smoke check of the
	 * route's wiring + permission callback still surfaces a clean
	 * response while the SSE body is unimplemented.
	 */
	public function stream( \WP_REST_Request $request ) {
		\header( 'Content-Type: application/json' );
		echo \wp_json_encode( [ 'pending' => true ] );
		exit;
	}
}
