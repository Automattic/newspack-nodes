<?php
/**
 * Cli_Command: WP-CLI command wrapper for `wp nodes ls` and `wp nodes cli`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Manage the Newspack Nodes runtime: workers, the node-graph REPL, and logs.
 *
 * `wp nodes` groups every runtime subcommand. The substrate (newspack-nodes)
 * provides worker lifecycle and graph inspection; the event-logger application
 * (newspack-event-logger-nodes) adds the `reqgrep` firehose tool. Run any
 * subcommand with `--help` for its own options.
 *
 * ## EXAMPLES
 *
 *     # List active workers and their heartbeats
 *     wp nodes ls
 *
 *     # Attach a REPL to a live worker
 *     wp nodes cli firehose-workers-and-jobs.p0
 *
 *     # Restart every worker type
 *     wp nodes restart all
 *
 *     # Live-tail the request firehose
 *     wp nodes reqgrep --follow
 */
class CLI_Command {

	/**
	 * uid-source seam. Lazily-defaulted to the real `posix_getuid()` (or -1 when
	 * the extension is absent). Tests reassign it to simulate root (return 0) so
	 * the refuse-as-root guard runs as real, covered code without the runner
	 * actually being root; reset to null in tearDown.
	 *
	 * Signature: `function (): int`.
	 *
	 * @var (\Closure(): int)|null
	 */
	public static ?\Closure $uid_provider = null;

	/**
	 * Open an interactive REPL — bare mode (local graph) or pivoted mode (IPC to a worker).
	 *
	 * ## OPTIONS
	 *
	 * [<worker>]
	 * : Worker id in the form {type}.p{N}, e.g. firehose-workers.p0.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes cli
	 *     wp nodes cli firehose-workers.p0
	 *
	 * @api WP-CLI subcommand `wp nodes cli` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function cli( array $args, array $assoc_args ): void {
		[ $shell, $dumper, $stdout ] = $this->prepare_repl( $args );
		$this->run_repl( $shell, $dumper, $stdout );
	}

	/**
	 * Build the REPL graph + log the mode line, returning [$shell, $dumper, $stdout] for run_repl.
	 *
	 * @param array<int, string> $args WP_CLI positional arguments. Empty = bare mode; else $args[0] is the worker id.
	 * @return array{0:Shell_Node,1:Dumper_Node,2:TTY_Out_Node}
	 */
	private function prepare_repl( array $args ): array {
		// Refuse root: a root cli would create the IPC dirs root-owned, so non-root clis lose writes.
		$uid = ( self::$uid_provider ?? static fn (): int => \function_exists( 'posix_getuid' ) ? \posix_getuid() : -1 )();
		if ( 0 === $uid ) {
			\WP_CLI::error( 'wp nodes cli must run as the same user as the workers, not root.' );
		}

		$cli = new CLI( $this->base_dir() );

		$pivoted = ! empty( $args );
		$ipc     = null;

		if ( $pivoted ) {
			$worker_id = $args[0];
			try {
				$ipc = $cli->attach_to_worker( $worker_id );
			} catch ( \InvalidArgumentException $e ) {
				\WP_CLI::error( $e->getMessage() );
			}
		}

		[ $shell, $dumper, $stdout ] = $this->build_repl_graph( $pivoted, $ipc );

		// Stash the mode summary; the `status` builtin renders it on demand.
		if ( $pivoted && null !== $ipc ) {
			$shell->status_lines = [
				"Pivoted-cli mode for {$args[0]}",
				"  input  partition: {$ipc['input']}",
				"  output partition: {$ipc['output']}",
			];
		} else {
			$shell->status_lines = [
				'Bare cli mode (local nodes only).',
			];
		}

		return [ $shell, $dumper, $stdout ];
	}

	private function base_dir(): string {
		return Config::get_base_directory();
	}

	/**
	 * Build the REPL node graph (bare: _shell → interpreter → _router → _output; pivoted adds IPC nodes).
	 *
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell_Node,1:Dumper_Node,2:TTY_Out_Node}
	 */
	private function build_repl_graph( bool $pivoted, ?array $ipc ): array {
		$pid = (string) \getmypid();

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// `_stdout`: the terminal writer. Every node sinks into the interpreter (Rule #2);
		// the Dumper reaches it by target/TO routing, not a direct sink.
		$stdout = new TTY_Out_Node();
		$stdout->name( Node_Names::STDOUT );
		$stdout->sink( $interpreter );

		// `_output`: Shell stamps FROM=_output/$pid, so replies route back here.
		$dumper = new Dumper_Node();
		$dumper->name( Node_Names::OUTPUT );
		$dumper->sink( $interpreter );
		$dumper->target( Node_Names::STDOUT );

		// Tap node for introspection of what the shell is sending.
		$console_tap = new Tap_Node();
		$console_tap->name( Node_Names::CONSOLE_TAP );
		$console_tap->sink( $interpreter );

		// Shell stays anonymous (Shell::name would throw); `ls` filters by sink anyway.
		$shell = new Shell_Node();
		$shell->sink( $console_tap );

		// Defined unconditionally (empty in bare mode) so it's in scope for both
		// pivoted blocks below; the blocks themselves are guarded.
		$worker_id = ( $pivoted && null !== $ipc ) ? "{$ipc['type']}.p{$ipc['partition']}" : '';
		if ( $pivoted && null !== $ipc ) {
			$shell->prompt = "/{$worker_id}> ";
		}

		$dumper->set_shell( $shell );
		$stdout->set_shell( $shell );
		// readline only works on a real TTY; on a pipe it spins at 100% CPU.
		$is_tty = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$stdout->set_readline_mode( $is_tty && \function_exists( 'readline_callback_handler_install' ) );

		if ( $pivoted && null !== $ipc ) {
			// IPC topics are single-partition; skip allow_large_writes so sessions append concurrently.
			// 1 MiB segment_size + 2 segments — matches the worker/server IPC mounts.
			$ipc_out = new Partition_Node();
			$ipc_out->arguments( "{$ipc['input']} " . Worker_Base::IPC_SEGMENT_SIZE . ' ' . Worker_Base::IPC_NUM_SEGMENTS );
			$ipc_out->name( $worker_id );
			$ipc_out->sink( $interpreter );
			$shell->path = $worker_id;

			// reply-in: ephemeral, so empty offsetlog_dir (no durable cursor).
			$reply_in = new Node();
			$reply_in->sink( $router );
			$reply_in->target( Node_Names::OUTPUT );
			$ipc_in = new Consumer_Node();
			$ipc_in->arguments( "{$ipc['output']}" );
			$ipc_in->next_offset( 'end' );
			$ipc_in->sink( $reply_in );
		}

		// TO filter matches `_output/$pid` and `$pid`; empty TO always renders, other sessions drop.
		$dumper->set_to_filter( $pid );

		return [ $shell, $dumper, $stdout ];
	}

	/**
	 * Drive the REPL via the event loop until STDIN EOF. Readline on a TTY, fgets otherwise.
	 */
	private function run_repl( Shell_Node $shell, Dumper_Node $dumper, TTY_Out_Node $stdout ): void {
		// readline only on a real TTY; pipes fall through to fgets (EOF-terminating).
		$is_tty       = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$has_readline = $is_tty && \function_exists( 'readline_callback_handler_install' );

		// Skip prompts when stdin is piped — they break `... | grep` consumers.
		$reader = new TTY_In_Node( $shell, $stdout, $has_readline, null, $is_tty );

		// The reader sinks into the Shell: its drained lines/EOF fill the sink, and
		// the Shell parses + forwards them on into the interpreter/router. The sink
		// also satisfies Timer_Node::fire_cb()'s no-sink guard (a sink-less reader
		// never reaches fire(), so its stdin drain would never run).
		$reader->sink( $shell );

		// Completion replies (KEY='completion') are intercepted at the renderer and fed
		// to the reader's candidate cache instead of being printed. Readline-only.
		if ( $has_readline ) {
			$dumper->set_completion_sink(
				fn ( array $message ): bool => $reader->ingest_completion_reply( $message )
			);
			// Seed the candidate cache now that the intercept is wired, so the first
			// Tab has candidates and the seed replies are consumed, not printed.
			$reader->send_completion_queries();
		}

		// On the worker's TM_EOF echo, flip the exit flag so scripted sessions don't orphan replies.
		$dumper->on_eof( static function () use ( $reader ): void {
			$reader->exit = true;
		} );

		// Schedule the first fire; subsequent fires self-schedule.
		$reader->set_timer( 0, true );
		Event_Framework::instance()->drain( static fn () => ! $reader->exit );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		// Courtesy trailing newline on a TTY; skipped when piped (stray noise breaks consumers).
		if ( $is_tty ) {
			\WP_CLI::log( '' );
		}
	}

	/**
	 * List live workers, reporting each one's heartbeat age and freshness.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes ls
	 *
	 * @api WP-CLI subcommand `wp nodes ls` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function ls( array $args, array $assoc_args ): void {
		$cli     = new CLI( $this->base_dir() );
		$workers = $cli->ls_workers();
		if ( empty( $workers ) ) {
			\WP_CLI::log( 'No workers running. base_dir=' . $this->base_dir() );
			return;
		}
		$now = \time();
		foreach ( $workers as $w ) {
			$age      = $w['heartbeat_at'] ? ( $now - $w['heartbeat_at'] ) . 's ago' : 'never';
			$flag     = $w['stale'] ? '[stale]' : '[live] ';
			$worker   = "{$w['type']}.p{$w['partition']}";
			\WP_CLI::log( \sprintf( '%s %-30s heartbeat %s', $flag, $worker, $age ) );
		}
	}
}
