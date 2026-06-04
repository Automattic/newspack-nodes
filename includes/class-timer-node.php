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
		// Chain so the base ctor can auto-wire a sibling :config interpreter from node_schema.
		parent::__construct();
	}

	public function arguments( ?string $args = null ): string {
		$ref = new \ReflectionObject( $this );
		if ( 'Timer_Node' !== $ref->getShortName() ) {
			return parent::arguments( $args );
		}
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		if ( '' === $args ) {
			$this->set_timer();
		} elseif ( preg_match( '/^[0-9]+$/', $args ) ) {
			$this->set_timer( (int) $args );
		} else {
			throw new \InvalidArgumentException( 'Bad arguments for Timer' );
		}
		return $this->arguments;
	}

	public function fire_cb(): void {
		++$this->fire_count;
		if ( $this->oneshot ) {
			$this->active = false;
			$this->mode   = 'inactive';
		}
		if ( null === $this->sink ) {
			return;
		}
		$this->fire();
	}

	// One tick (Perl Timer::fire). Emit a TM_BYTESTREAM heartbeat carrying the
	// timestamp ONLY when this timer has a target, or its sink isn't the
	// CommandInterpreter (the owner/CI guard — a target-less timer sinking into the
	// interpreter would just spam it); counter++ on emit. Always notify 'FIRE'.
	protected function fire(): void {
		if ( '' !== $this->target || ! ( $this->sink instanceof Command_Interpreter_Node ) ) {
			$msg                       = Message::new_message();
			$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
			$msg[ Message::TIMESTAMP ] = Core::$now;
			$msg[ Message::FROM ]      = $this->name;
			$msg[ Message::TO ]        = $this->target;
			if ( '' !== $this->key ) {
				$msg[ Message::KEY ] = $this->key;
			}
			$msg[ Message::VALUE ] = (string) Core::$now;
			++$this->counter;
			$this->sink?->fill( $msg );
		}
		$this->notify( 'FIRE', Core::$now );
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
			if ( 'event_framework' === $this->mode ) {
				$this->stop_timer();
			}
			$router->register( 'TIMER', $this->name );
			$this->mode = 'router';
			return;
		}
		if ( 'router' === $this->mode ) {
			$this->stop_timer();
		}
		Event_Framework::instance()->set_timer( $this, $ms, $oneshot );
		$this->mode = 'event_framework';
	}

	public function stop_timer(): void {
		if ( 'inactive' === $this->mode ) {
			return;
		}
		$mode         = $this->mode;
		$this->active = false;
		$this->mode   = 'inactive';

		if ( 'router' === $mode ) {
			$router = Core::node( Node_Names::ROUTER );
			if ( null !== $router && '' !== $this->name ) {
				$router->unregister( 'TIMER', $this->name );
			}
			return;
		}
		if ( 'event_framework' === $mode ) {
			Event_Framework::instance()->stop_timer( $this );
		}
	}

	public function is_active(): bool {
		return $this->active;
	}

	public function fire_count(): int {
		return $this->fire_count;
	}

	public function remove_node(): void {
		$this->stop_timer();
		parent::remove_node();
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Control',
			'description' => 'Periodic firing — emits a heartbeat message every N ms.',
		] );
	}
}
