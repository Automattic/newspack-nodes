<?php
/**
 * Timer: periodic / one-shot fire. Two modes: own EventFramework slot (set_timer($ms)) or Router-hitchhike (set_timer() no args).
 *
 * Hitchhike uses Node-name dispatch, not a closure: a void-returning closure coerces to falsy and self-unregisters after one tick.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Timer_Node extends Node {
	protected int $fire_count = 0;
	protected bool $active = false;
	protected bool $oneshot = false;

	/** @var string Tracks scheduling mode: 'inactive' | 'event_framework' | 'router'. */
	protected string $mode = 'inactive';

	/** Tag stamped onto each emitted message's KEY (Tachikoma uses STREAM; we have no STREAM slot). Empty = unset. */
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
			$router = Core::node( Node_Names::ROUTER );
			if ( null === $router ) {
				throw new \RuntimeException( 'Router-hitchhike requires _router to be present' );
			}
			$router->register( 'TIMER', $this->name );
			$this->mode = 'router';
			return;
		}
		Event_Framework::instance()->set_timer( $this, $ms, $oneshot );
		$this->mode = 'event_framework';
	}

	public function stop_timer(): void {
		$mode       = $this->mode;
		$self       = $this;
		$this->active = false;
		$this->mode   = 'inactive';

		// Defer to closing-queue: avoids mutating EventFramework $timers / Router $registrations mid-iteration.
		Core::push_closing( static function () use ( $self, $mode ): void {
			if ( 'router' === $mode ) {
				$router = Core::node( Node_Names::ROUTER );
				if ( null !== $router && '' !== $self->name() ) {
					$router->unregister( 'TIMER', $self->name() );
				}
				return;
			}
			if ( 'event_framework' === $mode ) {
				Event_Framework::instance()->stop_timer( $self );
			}
		} );
	}

	public function is_active(): bool {
		return $this->active;
	}

	public function fire_count(): int {
		return $this->fire_count;
	}

	/** Detect Router-hitchhike TIMER notifications (TM_INFO, KEY='TIMER') and fire; else forward to sink. */
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

	/** Cascade timer-slot unregistration before Node teardown, else EventFramework/Router keeps a back-reference and refcount never hits zero. */
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
