<?php
/**
 * Timer: periodic / one-shot fire.
 *
 * Two scheduling modes:
 *  - EventFramework slot: $timer->set_timer( $ms, $oneshot ) — own slot, sub-second precision.
 *  - Router-hitchhike: $timer->set_timer() with no args — registers with Router's TIMER
 *    event using Node-name dispatch. Router's notify('TIMER', ...) fills a TM_INFO message
 *    into this Timer (TO=name, KEY='TIMER'); Timer::fill() detects it and calls fire_cb().
 *    Closure-based hitchhike was rejected because the closure returns void → coerced to
 *    null → falsy → listener self-unregistered after first tick (per Node::dispatch_listener
 *    "falsy return removes registration" rule). Node-name dispatch always returns true.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Timer extends Node {
	protected int $fire_count = 0;
	protected bool $active = false;
	protected bool $oneshot = false;

	/** @var string Tracks scheduling mode: 'inactive' | 'event_framework' | 'router'. */
	protected string $mode = 'inactive';

	/**
	 * Tag stamped onto each emitted message's KEY field — analogous to
	 * `$self->{stream}` on real Tachikoma's Timer.pm:65, where receivers
	 * disambiguate control ticks from data via STREAM. Our 7-field message
	 * layout has no STREAM slot, so KEY plays the same role. Empty string
	 * = unset (most Timers don't need a tag).
	 */
	protected string $key = '';

	public function set_key( string $key ): void {
		$this->key = $key;
	}

	public function key(): string {
		return $this->key;
	}

	public function __construct() {
		$this->registrations = [ 'FIRE' => [] ];
	}

	public function set_timer( ?int $ms = null, bool $oneshot = false ): void {
		$this->oneshot = $oneshot;
		$this->active  = true;

		if ( null === $ms ) {
			if ( '' === $this->name ) {
				throw new \RuntimeException( 'Router-hitchhike requires Timer to have a name' );
			}
			$router = Core::node( '_router' );
			if ( null === $router ) {
				throw new \RuntimeException( 'Router-hitchhike requires _router to be present' );
			}
			$router->register( 'TIMER', $this->name );
			$this->mode = 'router';
			return;
		}
		EventFramework::instance()->set_timer( $this, $ms, $oneshot );
		$this->mode = 'event_framework';
	}

	public function stop_timer(): void {
		$mode       = $this->mode;
		$self       = $this;
		$this->active = false;
		$this->mode   = 'inactive';

		// Defer to closing-queue: avoids mid-iteration mutation of EventFramework $timers
		// or Router $registrations while drain() / notify() is iterating.
		Core::push_closing( static function () use ( $self, $mode ): void {
			if ( 'router' === $mode ) {
				$router = Core::node( '_router' );
				if ( null !== $router && '' !== $self->name() ) {
					$router->unregister( 'TIMER', $self->name() );
				}
				return;
			}
			if ( 'event_framework' === $mode ) {
				EventFramework::instance()->stop_timer( $self );
			}
		} );
	}

	public function is_active(): bool {
		return $this->active;
	}

	public function fire_count(): int {
		return $this->fire_count;
	}

	/**
	 * Detect Router-hitchhike TIMER notifications (TM_INFO, KEY='TIMER') and fire.
	 * All other messages fall through to the default forward-to-sink behavior.
	 */
	public function fill( array &$message ): void {
		if (
			( $message[ Message::TYPE ] & Message::TM_INFO )
			&& 'TIMER' === $message[ Message::KEY ]
		) {
			++$this->counter;
			$this->fire_cb();
			return;
		}
		parent::fill( $message );
	}

	public function fire_cb(): void {
		++$this->fire_count;
		if ( $this->oneshot ) {
			$this->active = false;
			$this->mode   = 'inactive';
		}
		$this->fire();
		$this->notify( 'FIRE', Core::$now );
	}

	/**
	 * Cascade timer-slot unregistration ahead of normal Node teardown.
	 * Without this, EventFramework's `$timers` (or Router's TIMER
	 * registration list) keeps a back-reference to this object, and
	 * `unset($node)` never drops refcount to zero — `__destruct` only
	 * fires when the event loop finally drains, well after the operator
	 * thought the node was gone. Stops are deferred onto Core's
	 * closing queue so a remove_node() that fires mid-drain doesn't
	 * mutate `$timers` while it's being iterated.
	 */
	public function remove_node(): void {
		if ( 'inactive' !== $this->mode ) {
			$this->stop_timer();
		}
		parent::remove_node();
	}

	protected function fire(): void {
		if ( null === $this->sink ) {
			return;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = $this->name;
		if ( '' !== $this->key ) {
			$msg[ Message::KEY ] = $this->key;
		}
		$msg[ Message::VALUE ]     = (string) Core::$now;
		$this->sink->fill( $msg );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Control',
			'description' => 'Periodic firing — emits a heartbeat message every N ms.',
		] );
	}
}
