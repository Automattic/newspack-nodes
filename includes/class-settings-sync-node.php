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

	/** Default sweep cadence (seconds) used when arguments() is armed without an explicit interval. */
	private const DEFAULT_INTERVAL_SECONDS = 300;

	/**
	 * Options-cache-invalidation seam. Lazily-defaulted to drop the WP options
	 * cache (alloptions/notoptions) so this long-lived worker reads the CURRENT
	 * option value in push(), not a frozen snapshot — a concurrent admin save
	 * (reset-to-default, remote_* change) would otherwise stay invisible until the
	 * worker respawns. Tests reassign to record/simulate the clear without a real
	 * cache. Signature: `function (): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $invalidate_options_cache = null;

	/** @var array<string,array<int,array{to:string,remote:string}>> local_option => LIST of {target spoke path, remote option name}. A local may map to several spoke targets (e.g. a remote_* setting seeds both the spoke's stripped option and its own remote_* copy). */
	protected array $registry = [];

	/** Tachikoma-parity: no-arg ctor. Wires the sibling :config interpreter from node_schema()['commands']. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Arm the recurring re-push timer. A Timer_Node subclass does not
	 * self-schedule, so we explicitly call set_timer() here. A blank/absent
	 * interval falls back to the default 300s sweep cadence.
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
	 * On a settings-change event, push the named option to the spokes.
	 *
	 * The consumer feeds a TM_STRUCT carrying only the option NAME
	 * (`VALUE = ['option' => $name]`); the effective value is read here at
	 * consume time. Anything that isn't a TM_STRUCT with an 'option' key is dropped.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function fill( array $message ): void {
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
	 * Build and fan out one `set` command for a single registered local option.
	 * Drops silently if the option isn't registered or the node has no sink.
	 *
	 * @param string $local Local WP-option name.
	 */
	protected function push( string $local ): void {
		$specs = $this->registry[ $local ] ?? [];
		if ( [] === $specs || null === $this->sink ) {
			return;
		}
		// Long-lived worker: drop the frozen alloptions snapshot so get_option below
		// reflects a concurrent admin save (reset-to-default, remote_* change) rather
		// than a stale value the worker cached at first read. Mirrors Discovery_Collector_Node.
		( self::$invalidate_options_cache ?? static fn () => Config::invalidate_options_cache() )();
		// App-overridable: ELN resolves a blank remote_* to the file default here.
		$value  = \apply_filters( 'newspack_nodes/settings_sync/value', \get_option( $local ), $local );
		$scalar = self::scalarize( $value );
		// Unencodable (malformed UTF-8 etc.): skip rather than ship an empty token
		// that would decode to [] and WIPE the option on the spoke.
		if ( null === $scalar ) {
			$this->print_less_often( "settings-sync: cannot encode value for {$local}; skipping" );
			return;
		}
		// One `set` per registered mapping — a local may target more than one spoke
		// option (e.g. a remote_* setting seeds the spoke's stripped option AND its
		// own remote_* copy for onward propagation).
		foreach ( $specs as $spec ) {
			$this->send_set( $spec['to'], $spec['remote'], $scalar );
		}
	}

	/**
	 * Build + fan out one `set <remote_option> <scalar>` command toward a spoke
	 * (the configured `target/<to>` path).
	 *
	 * @param string $to            Spoke path segment under the target.
	 * @param string $remote_option Option name to set on the spoke.
	 * @param string $scalar        Already-scalarized value token.
	 */
	private function send_set( string $to, string $remote_option, string $scalar ): void {
		if ( null === $this->sink ) {
			return;
		}
		$target                = \is_array( $this->target ) ? ( $this->target[0] ?? '' ) : $this->target;
		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_COMMAND;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::TO ]    = $target . '/' . $to;
		$out[ Message::VALUE ] = [
			'name'      => 'set',
			'arguments' => Command_Args::format( [ $remote_option, $scalar ], [] ),
		];
		$this->sink->fill( $out );
	}

	// Flatten a value to one positional token: arrays become JSON (lossless for
	// associative maps like custom_events, whose keys carry the data — implode()
	// would drop them); scalars stringify. The receiver json_decodes array options.
	// null signals an unencodable value (json_encode failed) so push() can skip it
	// rather than ship an empty token that would wipe the option on the spoke.
	private static function scalarize( mixed $v ): ?string {
		if ( \is_array( $v ) ) {
			$json = \wp_json_encode( $v, \JSON_UNESCAPED_SLASHES );
			return false === $json ? null : $json;
		}
		return Core::as_string( $v );
	}

	/**
	 * Register a local-option → spoke mapping. Three positional tokens:
	 * `<local_option> <TO> <remote_option>`. Repeatable per local option (a
	 * `remote_*` setting is added twice — once mapping to the spoke's stripped
	 * option, once to its own `remote_*` copy); exact duplicates are idempotent
	 * so re-running the topology doesn't fan out twice.
	 *
	 * @param string $args Whitespace-separated `<local_option> <TO> <remote_option>`.
	 * @return string 'ok', or an `error: …` string on arity mismatch.
	 */
	public function add_setting( string $args ): string {
		$parts = \preg_split( '/\s+/', \trim( $args ), -1, \PREG_SPLIT_NO_EMPTY ) ?: [];
		if ( 3 !== \count( $parts ) ) {
			return 'error: add_setting requires <local_option> <TO> <remote_option>';
		}
		$spec = [
			'to'     => $parts[1],
			'remote' => $parts[2],
		];
		$this->registry[ $parts[0] ] ??= [];
		if ( ! \in_array( $spec, $this->registry[ $parts[0] ], true ) ) {
			$this->registry[ $parts[0] ][] = $spec;
		}
		return 'ok';
	}

	/** Emit the base config plus one round-trippable `cmd {name}:config add_setting …` per registry mapping. */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( $this->registry as $local => $specs ) {
			foreach ( $specs as $spec ) {
				$out .= "cmd {$this->name}:config add_setting {$local} {$spec['to']} {$spec['remote']}\n";
			}
		}
		return $out;
	}

	/**
	 * `add_setting` verb handler — registers a local→spoke mapping on the patron.
	 * Named so node_schema() stays declarative (the schema links this, not an
	 * inline closure).
	 *
	 * @param Command_Interpreter_Node $interpreter The sibling `:config` interpreter.
	 * @param string                   $args        `<local_option> <TO> <remote_option>`.
	 * @return string Result line.
	 */
	public static function cmd_add_setting( Command_Interpreter_Node $interpreter, string $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return $patron->add_setting( $args );
	}

	/** Topology console manifest: palette entry + verb forms. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Control',
			'description' => 'Pushes registered WP-option changes to connected spokes.',
			'arguments'   => [
				[ 'name' => 'interval_seconds', 'type' => 'int', 'required' => false, 'default' => (string) self::DEFAULT_INTERVAL_SECONDS ],
			],
			'commands'    => [
				[
					'name'        => 'add_setting',
					'description' => 'Register a local-option → spoke mapping: <local_option> <TO> <remote_option>.',
					'args'        => [
						[ 'name' => 'local_option',  'type' => 'string', 'required' => true ],
						[ 'name' => 'to',            'type' => 'string', 'required' => true ],
						[ 'name' => 'remote_option', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_add_setting( $interpreter, $args ),
					'multiple' => true,
				],
			],
			'has_target'  => true,
		] );
	}
}
