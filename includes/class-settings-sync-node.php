<?php
/**
 * Settings_Sync: pushes registered WP-option changes to connected spokes.
 *
 * This is the skeleton — the `add_setting` registry, its round-trippable
 * dump_config, and node_schema. The event-push fill() and periodic fire()
 * land in later tasks.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Settings_Sync_Node extends Timer_Node {
	use Schema_Reflection;

	/** Legacy sweep cadence (seconds) used when arguments() is armed without an explicit interval. */
	private const DEFAULT_INTERVAL_SECONDS = 300;

	/** @var array<string,array{to:string,remote:string}> local_option => target spoke path + remote option name. */
	protected array $registry = [];

	/** Tachikoma-parity: no-arg ctor. Wires the sibling :config interpreter from node_schema()['commands']. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Arm the recurring re-push timer. A Timer_Node subclass does not
	 * self-schedule, so we explicitly call set_timer() here. A blank/absent
	 * interval falls back to the legacy 300s sweep cadence.
	 *
	 * @param string|null $args Interval in seconds (digits), '' for the default, or null to read back.
	 * @return string Last-set raw arguments string.
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		$seconds         = '' === $args ? self::DEFAULT_INTERVAL_SECONDS : (int) $args;
		$this->set_timer( $seconds * 1000 );
		return $this->arguments;
	}

	/**
	 * Periodic re-push: emit one `set` command for EVERY registered option in a
	 * single tick, so the downstream batched HTTP_Out coalesces them into one
	 * POST per spoke.
	 */
	public function fire(): void {
		foreach ( \array_keys( $this->registry ) as $local ) {
			$this->push( $local );
		}
	}

	/**
	 * Register a local-option → spoke mapping. Three positional tokens:
	 * `<local_option> <TO> <remote_option>`.
	 *
	 * @param string $args Whitespace-separated `<local_option> <TO> <remote_option>`.
	 * @return string 'ok', or an `error: …` string on arity mismatch.
	 */
	public function add_setting( string $args ): string {
		$parts = \preg_split( '/\s+/', \trim( $args ), -1, \PREG_SPLIT_NO_EMPTY ) ?: [];
		if ( 3 !== \count( $parts ) ) {
			return 'error: add_setting requires <local_option> <TO> <remote_option>';
		}
		$this->registry[ $parts[0] ] = [
			'to'     => $parts[1],
			'remote' => $parts[2],
		];
		return 'ok';
	}

	/**
	 * On a settings-change event, push the named option to the spokes.
	 *
	 * The consumer feeds a TM_STRUCT carrying only the option NAME
	 * (`VALUE = ['option' => $name]`); the effective value is read here at
	 * consume time. Anything that isn't a TM_STRUCT with an 'option' key is dropped.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$type = \is_int( $message[ Message::TYPE ] ) ? $message[ Message::TYPE ] : 0;
		if ( ! ( $type & Message::TM_STRUCT ) ) {
			return;
		}
		$value = $message[ Message::VALUE ];
		if ( ! \is_array( $value ) || ! isset( $value['option'] ) ) {
			return;
		}
		$this->push( Core::as_string( $value['option'] ) );
	}

	/**
	 * Build and fan out one `set` command for a single registered local option.
	 * Drops silently if the option isn't registered or the node has no sink.
	 *
	 * @param string $local Local WP-option name.
	 */
	protected function push( string $local ): void {
		$spec = $this->registry[ $local ] ?? null;
		if ( null === $spec || null === $this->sink ) {
			return;
		}
		// App-overridable: ELN resolves a blank remote_* to the file default here.
		$value     = \apply_filters( 'newspack_nodes/settings_sync/value', \get_option( $local ), $local );
		$arguments = Command_Args::format( [ $spec['remote'], self::scalarize( $value ) ], [] );

		$target               = \is_array( $this->target ) ? ( $this->target[0] ?? '' ) : $this->target;
		$out                  = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_COMMAND;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::TO ]    = $target . '/' . $spec['to'];
		$out[ Message::VALUE ] = [
			'name'      => 'set',
			'arguments' => $arguments,
		];
		$this->sink->fill( $out );
	}

	/** Flatten a value to one positional token: arrays become csv, scalars stringify. */
	private static function scalarize( mixed $v ): string {
		return \is_array( $v ) ? \implode( ',', \array_map( '\strval', $v ) ) : Core::as_string( $v );
	}

	/** Emit the base config plus one round-trippable `cmd {name}:config add_setting …` per registry entry. */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( $this->registry as $local => $setting ) {
			$out .= "cmd {$this->name}:config add_setting {$local} {$setting['to']} {$setting['remote']}\n";
		}
		return $out;
	}

	/** Topology console manifest: palette entry + verb forms. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Control',
			'description' => 'Pushes registered WP-option changes to connected spokes.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'add_setting',
					'description' => 'Register a local-option → spoke mapping: <local_option> <TO> <remote_option>.',
					'args'        => [
						[ 'name' => 'local_option',  'type' => 'string', 'required' => true ],
						[ 'name' => 'to',            'type' => 'string', 'required' => true ],
						[ 'name' => 'remote_option', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
						/** @var self $patron */
						$patron = $interpreter->patron();
						return $patron->add_setting( $args );
					},
				],
			],
			'has_target'  => true,
		] );
	}
}
