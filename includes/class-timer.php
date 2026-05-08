<?php
/**
 * Timer: periodic / one-shot fire.
 *
 * Two scheduling modes:
 *  - EventFramework slot: $timer->set_timer( $ms, $oneshot ) — own slot, sub-second precision.
 *  - Router-hitchhike (Task 7): $timer->set_timer() with no args — registers with
 *    Router's TIMER event; Router fires every 5s and notifies all hitchhikers.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Timer extends Node {
	protected int $fire_count = 0;
	protected bool $active = false;
	protected bool $oneshot = false;

	public function __construct() {
		$this->registrations = [ 'FIRE' => [] ];
	}

	public function set_timer( ?int $ms = null, bool $oneshot = false ): void {
		$this->oneshot = $oneshot;
		$this->active  = true;

		if ( $ms === null ) {
			$router = Core::node( '_router' );
			if ( $router === null ) {
				throw new \RuntimeException( 'Router-hitchhike requires _router to be present' );
			}
			$self = $this;
			$router->register( 'TIMER', 'timer_' . \spl_object_id( $this ), function () use ( $self ) {
				$self->fire_cb();
			} );
			return;
		}
		EventFramework::instance()->set_timer( $this, $ms, $oneshot );
	}

	public function stop_timer(): void {
		EventFramework::instance()->stop_timer( $this );
		$this->active = false;
	}

	public function is_active(): bool {
		return $this->active;
	}

	public function fire_count(): int {
		return $this->fire_count;
	}

	public function fire_cb(): void {
		++$this->fire_count;
		if ( $this->oneshot ) {
			$this->active = false;
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
