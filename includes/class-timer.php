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

	public function __construct() {
		$this->registrations = [ 'FIRE' => [] ];
	}

	public function set_timer( ?int $ms = null, bool $oneshot = false ): void {
		$this->oneshot = $oneshot;
		$this->active  = true;

		if ( $ms === null ) {
			if ( $this->name === '' ) {
				throw new \RuntimeException( 'Router-hitchhike requires Timer to have a name' );
			}
			$router = Core::node( '_router' );
			if ( $router === null ) {
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
			if ( $mode === 'router' ) {
				$router = Core::node( '_router' );
				if ( $router !== null && $self->name() !== '' ) {
					$router->unregister( 'TIMER', $self->name() );
				}
				return;
			}
			if ( $mode === 'event_framework' ) {
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
			&& $message[ Message::KEY ] === 'TIMER'
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
		$this->notify( 'FIRE', Core::$right_now );
	}

	protected function fire(): void {
		if ( $this->sink === null ) {
			return;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = Core::$right_now;
		$msg[ Message::FROM ]      = $this->name;
		$msg[ Message::VALUE ]     = (string) Core::$right_now;
		$this->sink->fill( $msg );
	}
}
