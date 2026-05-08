<?php
/**
 * CommandInterpreter: graph builder + shell vocabulary dispatch.
 *
 * One per process, named `_command_interpreter`. Auto-sink default for every make_node
 * (matches real Tachikoma; see prototype Nodes/CommandInterpreter.php:319). Forwards
 * non-TM_COMMAND messages to its sink, which is typically `_router`.
 *
 * Vocabulary lives in a static dispatch table ($C) — state-machine pattern, efficiency
 * principle "table-driven dispatch."
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class CommandInterpreter extends Node {
	/** @var array<string,callable>|null Initialized lazily. */
	private static ?array $C = null;

	/** @var array<string,class-string> Class registry: shell-name → FQCN. */
	private static array $class_map = [];

	public static function register_class( string $shell_name, string $fqcn ): void {
		self::$class_map[ $shell_name ] = $fqcn;
	}

	private static function init_C(): void {
		if ( self::$C !== null ) {
			return;
		}
		self::$C = [
			'make_node' => function ( CommandInterpreter $self, string $args ): string {
				$parts = \preg_split( '/\s+/', \trim( $args ), 3 );
				if ( \count( $parts ) < 2 ) {
					return 'usage: make_node <type> <name> [<arguments>]';
				}
				[ $type, $name ] = $parts;
				$node_args       = $parts[2] ?? '';

				$fqcn = self::$class_map[ $type ] ?? null;
				if ( $fqcn === null || ! \class_exists( $fqcn ) ) {
					return "unknown class: $type";
				}

				$node = new $fqcn();
				$node->name( $name );
				$node->sink( $self );
				return 'ok';
			},
			'set_sink' => function ( CommandInterpreter $self, string $args ): string {
				[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ), 2, '' );
				if ( $name === '' || $target === '' ) {
					return 'usage: set_sink <node> <target>';
				}
				$src = Core::node( $name );
				$dst = Core::node( $target );
				if ( $src === null || $dst === null ) {
					return 'unknown node';
				}
				$src->sink( $dst );
				return 'ok';
			},
			'connect_node' => function ( CommandInterpreter $self, string $args ): string {
				[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ), 2, '' );
				if ( $name === '' || $target === '' ) {
					return 'usage: connect_node <node> <target>';
				}
				$src = Core::node( $name );
				if ( $src === null ) {
					return "unknown node: $name";
				}
				$src->connect_node( $target );
				return 'ok';
			},
			'disconnect_node' => function ( CommandInterpreter $self, string $args ): string {
				$name = \trim( $args );
				if ( $name === '' ) {
					return 'usage: disconnect_node <node>';
				}
				$src = Core::node( $name );
				if ( $src === null ) {
					return "unknown node: $name";
				}
				$src->disconnect_node();
				return 'ok';
			},
			'ls' => function ( CommandInterpreter $self, string $args ): string {
				$lines = [];
				foreach ( Core::$nodes_by_name as $name => $node ) {
					$lines[] = \sprintf( '%-30s count=%d', $name, $node->counter() );
				}
				\sort( $lines );
				return \implode( "\n", $lines );
			},
			'dump_config' => function ( CommandInterpreter $self, string $args ): string {
				$out = '';
				foreach ( \array_keys( Core::$nodes_by_name ) as $name ) {
					if ( $name === '_command_interpreter' || $name === '_router' || $name === '_responder' ) {
						continue; // Skip baseline scaffolding.
					}
					$out .= Core::node( $name )->dump_config();
				}
				return $out;
			},
		];
	}

	public function fill( array &$message ): void {
		++$this->counter;

		if ( $message[ Message::TYPE ] & Message::TM_COMMAND
			&& ! ( $message[ Message::TYPE ] & Message::TM_RESPONSE ) ) {
			$this->interpret( $message );
			return;
		}
		$this->sink?->fill( $message );
	}

	public function execute( string $command_line ): string {
		self::init_C();
		$parts = \explode( ' ', $command_line, 2 );
		$verb  = $parts[0];
		$args  = $parts[1] ?? '';
		if ( ! isset( self::$C[ $verb ] ) ) {
			return "unknown command: $verb";
		}
		return ( self::$C[ $verb ] )( $this, $args );
	}

	private function interpret( array &$message ): void {
		$cmd = \json_decode( $message[ Message::VALUE ], true );
		if ( ! \is_array( $cmd ) || ! isset( $cmd['name'] ) ) {
			$this->drop_message( $message, 'invalid command struct' );
			return;
		}
		$result = $this->execute( $cmd['name'] . ' ' . ( $cmd['arguments'] ?? '' ) );
		// Build TM_COMMAND|TM_RESPONSE; route TO=FROM.
		$response                   = Message::new_message();
		$response[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$response[ Message::FROM ]  = $this->name;
		$response[ Message::TO ]    = $message[ Message::FROM ];
		$response[ Message::ID ]    = $message[ Message::ID ];
		$response[ Message::VALUE ] = \json_encode(
			[
				'name'    => $cmd['name'],
				'payload' => $result,
			]
		);
		$this->sink?->fill( $response );
	}
}
