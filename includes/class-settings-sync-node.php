<?php
/**
 * Settings_Sync: pushes registered WP-option changes to connected spokes.
 *
 * A worker Consumer tails the settings log and fills this node with option-NAME
 * events; fill() reads each named option's CURRENT value and fans out one `set`
 * command per registered spoke mapping. The recurring fire() re-pushes every
 * registered option so a freshly-connected spoke converges. Mappings are declared
 * via add_setting() and round-trip through dump_config().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Settings_Sync_Node extends Timer_Node {
	use Fanout_Targets;
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
	 * @param list<string>|null $args Interval in seconds (digits) at token 0, empty for the default, or null to read back.
	 * @return list<string> Last-set argument tokens.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		$first           = $args[0] ?? '';
		$seconds         = '' === $first ? self::DEFAULT_INTERVAL_SECONDS : (int) $first;
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
		$type = Core::int( $message[ Message::TYPE ] );
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
		// Drop the frozen alloptions cache so get_option sees concurrent saves.
		( self::$invalidate_options_cache ?? static fn () => Config::invalidate_options_cache() )();
		// App-overridable: ELN resolves a blank remote_* to its file default.
		$value  = \apply_filters( 'newspack_nodes/settings_sync/value', \get_option( $local ), $local );
		$scalar = self::scalarize( $value );
		// Skip unencodable values; an empty token would WIPE the option.
		if ( null === $scalar ) {
			$this->print_less_often( 'settings-sync: cannot encode value for ', $local, '; skipping' );
			return;
		}
		// One `set` per mapping — a local may target several spoke options.
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
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}
		// One signed command per spoke; re-addressing post-mint can't verify.
		foreach ( $this->live_targets() as $target ) {
			$spoke = $this->spoke_for( $target );
			if ( '' === $spoke || ! Command_Auth::has_session( $spoke ) ) {
				$this->print_less_often( 'settings-sync: no session for ', $target, '; skipping this push' );
				continue;
			}
			$out                   = Message::new_message();
			$out[ Message::TYPE ]  = Message::TM_COMMAND;
			$out[ Message::FROM ]  = $this->name;
			$out[ Message::TO ]    = $this->target_path( $target, $to );
			$out[ Message::VALUE ] = [
				'name'      => 'set',
				'arguments' => Command_Args::format( [ $remote_option, $scalar ], [] ),
			];
			Command_Auth::sign_for( $spoke, $out );
			$sink->fill( $out );
		}
	}

	/** The vault id a target egress speaks for; '' when it is not one. */
	private function spoke_for( string $target ): string {
		[ $head ] = Message::split_first( $target );
		$node     = Core::node( $head );
		return $node instanceof HTTP_Out_Node ? $node->vault_id() : '';
	}

	// Flatten to one token: arrays become JSON, scalars stringify; null if bad.
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
	 * @param array<array-key, mixed> $args Whitespace-separated `<local_option> <TO> <remote_option>`.
	 * @return string 'ok', or an `error: …` string on arity mismatch.
	 */
	public function add_setting( array $args ): string {
		$parts = \array_values( \array_map( static fn ( $v ): string => Core::as_string( $v ), $args ) );
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

	/** Emit the base config plus one round-trippable `command_node {name}:config add_setting …` per registry mapping. */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( $this->registry as $local => $specs ) {
			foreach ( $specs as $spec ) {
				$out .= "command_node {$this->name}:config add_setting {$local} {$spec['to']} {$spec['remote']}\n";
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
	 * @param array<array-key, mixed>  $args        `<local_option> <TO> <remote_option>`.
	 * @return string Result line.
	 */
	public static function cmd_add_setting( Command_Interpreter_Node $interpreter, array $args ): string {
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
				[ 'name' => 'interval_seconds', 'type' => 'int', 'required' => false, 'default' => (string) self::DEFAULT_INTERVAL_SECONDS, 'description' => 'Re-push sweep cadence in seconds — how often every registered option is re-sent to spokes (default 300).' ],
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
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_add_setting( $interpreter, $args ),
					'multiple' => true,
				],
			],
			'has_target'  => true,
		] );
	}
}
