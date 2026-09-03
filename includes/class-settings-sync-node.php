<?php
/**
 * Settings_Sync: the hub end of the settings-sync control plane.
 *
 * `Settings_Event_Writer` appends an option NAME to `settings.p0` on every
 * watched change, and a worker Consumer tails that log into this node. The value
 * a spoke receives is therefore the one read at consume time, not the one the
 * admin request saw. `add_setting()` declares which local option reaches which
 * spoke under which remote name, and `dump_config()` replays those declarations
 * as TSL.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Pushes every registered WP option to the connected spokes as a signed `set`.
 *
 * The node fans out itself rather than sinking into a Tee. `send_set()` mints
 * one command per live target and signs it under that spoke's session key, and
 * the key chosen IS the destination binding
 * ([ADR-15](docs/architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs)),
 * so a Tee re-addressing one signed command to N spokes would produce a command
 * that verifies nowhere.
 *
 * Two things drive a push. An event from the Consumer pushes the one option that
 * changed; the recurring sweep pushes every registered option, which is how a
 * spoke connecting mid-stream converges without an event of its own.
 */
class Settings_Sync_Node extends Timer_Node {
	use Schema_Reflection;
	use Fanout_Targets;

	/** Sweep cadence in seconds when the make_node line carries no interval token. */
	private const DEFAULT_INTERVAL_SECONDS = 300;

	/** Re-push sweep cadence in seconds; positional 0, floored at one second by cadence_ms(). */
	protected int $interval_seconds = self::DEFAULT_INTERVAL_SECONDS;

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

	/**
	 * Local option name to the mappings it pushes under: `to` is the path below
	 * every spoke target, `remote` the option name to set there.
	 *
	 * One local option maps to several. A hub `remote_*` setting seeds both the
	 * spoke's stripped option, which is that spoke's own config, and the spoke's
	 * `remote_*` copy, which the spoke propagates onward to ITS spokes.
	 *
	 * @var array<string,array<int,array{to:string,remote:string}>>
	 */
	protected array $registry = [];

	/** No-arg constructor (Tachikoma parity); wires the sibling `:config` interpreter from node_schema()['commands']. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Read the argument tokens, or apply them and arm the recurring sweep.
	 *
	 * `Timer_Node::arguments()` arms only a bare `Timer`, so a subclass arms
	 * itself: drop the `set_timer()` call and the node parses a cadence it then
	 * never fires on. `parse_schema_args()` assigns `interval_seconds` from the
	 * schema declaration, and that declaration is the whole parse
	 * ([ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence)).
	 *
	 * @param list<string>|null $args Interval in seconds at token 0, blank for the schema default, or null to read back.
	 * @return list<string> Last-set argument tokens.
	 * @throws \InvalidArgumentException When the interval token is not a whole number.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->parse_schema_args( $args );
		$this->set_timer( $this->cadence_ms( $this->interval_seconds ) );
		return $this->arguments;
	}

	/**
	 * On a settings-change event, push the named option to the spokes.
	 *
	 * The Consumer feeds a TM_STRUCT carrying only the option NAME
	 * (`VALUE = ['option' => $name]`); the effective value is read here at
	 * consume time. Anything that isn't a TM_STRUCT with an 'option' key is dropped.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
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
	 * single tick, so the batching `HTTP_Out` downstream coalesces them into one
	 * POST per spoke. It replaces the base Timer heartbeat rather than adding to
	 * it — a spoke wants the settings, not a tick.
	 */
	public function fire(): void {
		foreach ( \array_keys( $this->registry ) as $local ) {
			$this->push( $local );
		}
	}

	/**
	 * Read one registered local option and fan its current value out, one `set`
	 * per mapping. Drops silently when the option is unregistered or the node has
	 * no sink; a value that will not encode drops with a rate-limited line.
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
			$this->print_less_often( 'cannot encode value for ', $local, '; skipping' );
			return;
		}
		// One `set` per mapping — a local may target several spoke options.
		foreach ( $specs as $spec ) {
			$this->send_set( $spec['to'], $spec['remote'], $scalar );
		}
	}

	/**
	 * Mint one `set <remote_option> <scalar>` command per live target, each
	 * addressed `<target>/<to>` and signed under that spoke's own session key.
	 *
	 * A spoke with no session yet is skipped AND asked to handshake: every
	 * minter refuses to queue unsigned, so nothing else would ask and both sides
	 * would sit still. The first 30 seconds of a worker's life stay quiet,
	 * because a session still being established is not worth a line.
	 *
	 * @param string $to            Path below each spoke target the command is addressed to.
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
			$egress = $this->egress_for( $target );
			$spoke  = $egress?->vault_id() ?? '';
			if ( '' === $spoke || ! Command_Auth::has_session( $spoke ) ) {
				$uptime = (int) ( Core::$now - Core::$init_time );
				if ( $uptime > 30 ) {
					$this->print_less_often( 'no session for ', $target, '; skipping this push' );
				}
				// Skipping alone deadlocks: someone must ask for the handshake.
				$egress?->ensure_session();
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

	/** The HTTP_Out a target names, or null; a target may be a path, so resolve its head. */
	private function egress_for( string $target ): ?HTTP_Out_Node {
		[ $head ] = Message::split_first( $target );
		$node     = Core::node( $head );
		return $node instanceof HTTP_Out_Node ? $node : null;
	}

	/**
	 * Flatten a value to one command token: an array encodes as JSON, a scalar
	 * stringifies. JSON rather than a join because an option's array KEYS are
	 * data — `custom_events` is `event_name => true` — and a join drops them.
	 *
	 * @param mixed $v Raw option value.
	 * @return string|null The token, or null when the value will not encode.
	 */
	private static function scalarize( mixed $v ): ?string {
		if ( \is_array( $v ) ) {
			$json = \wp_json_encode( $v, \JSON_UNESCAPED_SLASHES );
			return false === $json ? null : $json;
		}
		return Core::as_string( $v );
	}

	/**
	 * Register one mapping from a local option to a spoke option, as the three
	 * tokens `<local_option> <TO> <remote_option>`.
	 *
	 * Repeatable per local option: a hub `remote_*` setting is registered twice,
	 * once against the spoke's stripped option and once against the spoke's own
	 * `remote_*` copy. An exact duplicate is ignored, so re-running the topology
	 * does not double the fan-out.
	 *
	 * @param array<array-key,mixed> $args Tokens `<local_option> <TO> <remote_option>`.
	 * @return string "ok\n", or an `error: …` line when the arity is wrong.
	 */
	public function add_setting( array $args ): string {
		$parts = \array_values( \array_map( static fn ( $v ): string => Core::as_string( $v ), $args ) );
		if ( 3 !== \count( $parts ) ) {
			return "error: add_setting requires <local_option> <TO> <remote_option>\n";
		}
		$spec = [
			'to'     => $parts[1],
			'remote' => $parts[2],
		];
		$this->registry[ $parts[0] ] ??= [];
		if ( ! \in_array( $spec, $this->registry[ $parts[0] ], true ) ) {
			$this->registry[ $parts[0] ][] = $spec;
		}
		return "ok\n";
	}

	/**
	 * The base graph snippet plus one `command_node {name}:config add_setting …`
	 * line per registry mapping, so a dump replays the whole mapping table.
	 *
	 * @return string Newline-terminated TSL lines.
	 */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( $this->registry as $local => $specs ) {
			foreach ( $specs as $spec ) {
				$out .= $this->config_line( 'add_setting', $local, $spec['to'], $spec['remote'] );
			}
		}
		return $out;
	}

	/**
	 * The `add_setting` verb handler: register the mapping on the patron node.
	 *
	 * The verb table links this method instead of carrying the body inline, so
	 * `node_schema()` stays a declaration.
	 *
	 * @param Command_Interpreter_Node $interpreter The sibling `:config` interpreter.
	 * @param array<array-key,mixed>  $args        `<local_option> <TO> <remote_option>`.
	 * @return string Result line.
	 */
	public static function cmd_add_setting( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return $patron->add_setting( $args );
	}

	/**
	 * Topology-console manifest: the palette entry, the constructor argument and
	 * the `add_setting` verb form, merged over Timer_Node's.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Control',
			'description' => 'Pushes registered WP-option changes to connected spokes.',
			'arguments'   => [
				[ 'name' => 'interval_seconds', 'type' => 'int', 'default' => self::DEFAULT_INTERVAL_SECONDS, 'description' => 'Re-push sweep cadence in seconds — how often every registered option is re-sent to spokes (digits only; default 300, floored at 1).' ],
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
