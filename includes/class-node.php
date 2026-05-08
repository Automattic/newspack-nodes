<?php
/**
 * Node: base class for the substrate.
 *
 * Every component that participates in the node-graph runtime extends Node.
 * Subclasses override fill() with their actual behavior; the base class
 * provides forwarding-to-sink as the default.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Node {
	protected string $name = '';
	protected ?Node  $sink = null;
	/** @var string|array<string> */
	protected $target = '';
	protected ?Node  $edge = null;

	protected int $counter = 0;

	/**
	 * @var array<string,array<string,callable|string>> Pre-declared events keyed by event name.
	 */
	protected array $registrations = [];

	/**
	 * Default: forward the message to the sink, incrementing counter first
	 * (so the message is counted even if the sink throws).
	 *
	 * @param array $message Reference; subclasses may mutate before forwarding.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$this->sink?->fill( $message );
	}

	public function name( ?string $name = null ): string {
		if ( $name !== null ) {
			if ( $this->name !== '' ) {
				Core::unregister_node( $this->name );
			}
			if ( Core::node( $name ) !== null ) {
				throw new \RuntimeException( "node name collision: $name already registered" );
			}
			$this->name = $name;
			Core::register_node( $name, $this );
		}
		return $this->name;
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->sink = $node;
		}
		return $this->sink;
	}

	/**
	 * Get/set target. String or array (Tee uses array form for fan-out).
	 */
	public function target( $value = null ) {
		if ( $value !== null ) {
			$this->target = $value;
		}
		return $this->target;
	}

	public function edge( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->edge = $node;
		}
		return $this->edge;
	}

	public function counter(): int {
		return $this->counter;
	}

	public const MAX_FROM_SIZE = 1024;

	/**
	 * Prepend $name to message FROM. Returns false if FROM would exceed MAX_FROM_SIZE.
	 */
	public function stamp_message( array &$message, string $name ): bool {
		if ( $name === '' ) {
			Core::print_less_often( 'ERROR: ' . static::class . ' stamp_message() called with empty name' );
			return false;
		}
		$from = $message[ Message::FROM ];
		$new  = $from === '' ? $name : ( $name . '/' . $from );
		if ( \strlen( $new ) > self::MAX_FROM_SIZE ) {
			Core::print_less_often( 'ERROR: path exceeded ' . self::MAX_FROM_SIZE . " bytes; dropping from: $new" );
			return false;
		}
		$message[ Message::FROM ] = $new;
		return true;
	}

	private const PAYLOAD_TYPES = Message::TM_INFO | Message::TM_REQUEST | Message::TM_ERROR | Message::TM_COMMAND;

	private static array $type_names = [
		Message::TM_BYTESTREAM => 'TM_BYTESTREAM',
		Message::TM_EOF        => 'TM_EOF',
		Message::TM_PING       => 'TM_PING',
		Message::TM_COMMAND    => 'TM_COMMAND',
		Message::TM_RESPONSE   => 'TM_RESPONSE',
		Message::TM_ERROR      => 'TM_ERROR',
		Message::TM_INFO       => 'TM_INFO',
		Message::TM_PERSIST    => 'TM_PERSIST',
		Message::TM_STORABLE   => 'TM_STORABLE',
		Message::TM_REQUEST    => 'TM_REQUEST',
	];

	/**
	 * Acknowledge a TM_PERSIST message: send TM_PERSIST|TM_RESPONSE back along the FROM trail
	 * with payload 'answer'. Empty FROM → silently return (do NOT fall through to TO='';
	 * see spec invariant "answer/cancel silent-when-no-FROM").
	 */
	public function answer( array &$message ): void {
		$this->send_persist_response( $message, 'answer' );
	}

	/**
	 * Negative-ack a TM_PERSIST message: same as answer() but with payload 'cancel'.
	 */
	public function cancel( array &$message ): void {
		$this->send_persist_response( $message, 'cancel' );
	}

	private function send_persist_response( array &$message, string $payload ): void {
		if ( $message[ Message::FROM ] === '' ) {
			return; // Silent drop. Critical: do NOT send to TO=''.
		}
		if ( $this->sink === null ) {
			return;
		}
		$response                       = Message::new_message();
		$response[ Message::TYPE ]      = Message::TM_PERSIST | Message::TM_RESPONSE;
		$response[ Message::TIMESTAMP ] = Core::$right_now;
		$response[ Message::FROM ]      = $this->name;
		$response[ Message::TO ]        = $message[ Message::FROM ];
		$response[ Message::ID ]        = $message[ Message::ID ];
		$response[ Message::KEY ]       = $message[ Message::KEY ];
		$response[ Message::VALUE ]     = $payload;
		$this->sink->fill( $response );
	}

	public function drop_message( array &$message, string $error ): void {
		$type   = $message[ Message::TYPE ];
		$labels = [];
		foreach ( self::$type_names as $bit => $label ) {
			if ( $type & $bit ) {
				$labels[] = $label;
			}
		}
		$type_str = empty( $labels ) ? 'unknown' : \implode( '|', $labels );

		$parts = [ "WARNING: $error - $type_str" ];
		if ( $message[ Message::FROM ] !== '' ) {
			$parts[] = 'from: ' . $message[ Message::FROM ];
		}
		if ( $message[ Message::TO ] !== '' ) {
			$parts[] = 'to: ' . $message[ Message::TO ];
		}
		if ( ( $type & self::PAYLOAD_TYPES ) && $message[ Message::VALUE ] !== '' ) {
			$parts[] = 'payload: ' . (string) $message[ Message::VALUE ];
		}

		$line = \implode( ' ', $parts );

		// First-300s NOT_AVAILABLE rule.
		if ( $error === 'NOT_AVAILABLE' && Core::$right_now < 300.0 ) {
			Core::print_least_often( $line );
			return;
		}
		Core::print_less_often( $line );
	}
}
