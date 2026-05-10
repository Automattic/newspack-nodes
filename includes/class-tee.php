<?php
/**
 * Tee: fan-out to multiple targets via Router.
 *
 * Overrides Node's single-target connect_node to append to an array.
 * Dispatch sets TO per target and forwards through sink (typically _router).
 * Per-target try/catch isolates failures.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tee extends Node {
	/**
	 * Per-message persist response tracking. Mirrors Tachikoma Tee::handle_response:
	 * `answer` and `cancel` are tracked SEPARATELY. Whichever counter first hits
	 * the target count triggers a single aggregate of THAT type back to the
	 * producer. If neither type wins outright (mixed responses) the tracking is
	 * cleaned up after all responses arrive without forwarding — matches upstream
	 * behavior; the producer's max_unanswered slot will time out via its own
	 * timeout machinery rather than getting a synthetic verdict here.
	 *
	 * @var array<string,array{count:int,answer:int,cancel:int,original:array}>
	 */
	private array $messages = [];

	public function __construct() {
		$this->target = [];
	}

	public function connect_node( string $target ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = '' !== $this->target ? [ $this->target ] : [];
		}
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
		}
	}

	public function disconnect_node( string $target = '' ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = [];
			return;
		}
		$this->target = \array_values( \array_filter( $this->target, fn ( $t ) => $t !== $target ) );
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		// Persist response routing.
		if ( ( $type & Message::TM_PERSIST ) && ( $type & Message::TM_RESPONSE ) ) {
			$this->handle_response( $message );
			return;
		}

		// Snapshot live targets.
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive   = [];
		foreach ( $targets as $t ) {
			if ( Core::node( $t ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		if ( $type & Message::TM_PERSIST ) {
			$id = $message[ Message::ID ];
			if ( '' !== $id && \count( $alive ) > 0 ) {
				$this->messages[ $id ] = [
					'count'    => \count( $alive ),
					'answer'   => 0,
					'cancel'   => 0,
					'original' => $message,
				];
			}
		}

		foreach ( $alive as $t ) {
			try {
				$copy                = $message;
				$copy[ Message::TO ] = $t;
				$this->sink?->fill( $copy );
			} catch ( \Throwable $e ) {
				Core::print_less_often( "Tee {$this->name}: target $t threw: " . $e->getMessage() );
			}
		}
	}

	/**
	 * Aggregate a TM_PERSIST|TM_RESPONSE arriving from one of the fan-out targets.
	 *
	 * Mirrors real Tachikoma `Tee::handle_response`:
	 *   - track `answer` / `cancel` counts separately
	 *   - first counter to reach `count` wins; forward that aggregate via the
	 *     ORIGINAL message through Node::answer / Node::cancel so the response
	 *     uses the producer's stored FROM, ID, KEY (not whatever the latest
	 *     downstream response carries)
	 *   - if responses arrive mixed and neither type alone reached `count`,
	 *     clean up tracking once total responses == count and forward nothing
	 */
	private function handle_response( array &$message ): void {
		$id = $message[ Message::ID ];
		if ( '' === $id || ! isset( $this->messages[ $id ] ) ) {
			return;
		}
		$info     =& $this->messages[ $id ];
		$resp     = 'cancel' === $message[ Message::VALUE ] ? 'cancel' : 'answer';
		$total    = \is_array( $this->target ) ? \count( $this->target ) : 1;
		$count    = $info['count'];
		if ( $total < $count ) {
			$count = $total;
		}

		$prev               = $info[ $resp ];
		$info[ $resp ]      = $prev + 1;

		if ( $prev >= $count - 1 ) {
			$original = $info['original'];
			unset( $this->messages[ $id ] );
			if ( 'cancel' === $resp ) {
				$this->cancel( $original );
			} else {
				$this->answer( $original );
			}
			return;
		}

		if ( $info['answer'] + $info['cancel'] >= $count ) {
			unset( $this->messages[ $id ] );
		}
	}
}
