<?php
/**
 * Tee: fan-out to multiple targets via Router. Per-target try/catch isolates failures.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tee_Node extends Node {
	use Fanout_Targets;

	public function __construct() {
		parent::__construct();
		$this->target = [];
	}

	public function fill( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		++$this->counter;

		$to    = Core::as_string( $message[ Message::TO ] );
		$alive = $this->live_targets();

		// At least once.
		$deferred = null;
		foreach ( $alive as $t ) {
			$message[ Message::TO ] = $this->target_path( $t, $to );
			try {
				$this->sink->fill( $message );
			} catch ( \Throwable $e ) {
				if ( $this->outranks( $e, $deferred ) ) {
					$deferred = $e;
				}
			}
		}
		if ( null !== $deferred ) {
			throw $deferred;
		}
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Fan-out: copies each message to multiple targets via Router.',
			'arguments'   => [],
			'commands'    => [],
			'requests'    => [],
		];
	}
}
