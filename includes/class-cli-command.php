<?php
/**
 * Cli_Command: WP-CLI command wrapper for `wp nodes status` and `wp nodes cli`.
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
 *     wp nodes status
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
	 * Open an interactive REPL — bare mode (local graph) or attached mode (IPC to a worker).
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
		// Refuse root: root cli makes IPC dirs root-owned, locks out non-root.
		CLI::refuse_root( 'cli' );

		$cli = new CLI( $this->base_dir() );

		$attached = ! empty( $args );
		$ipc     = null;

		if ( $attached ) {
			$worker_id = $args[0];
			try {
				$ipc = $cli->attach_to_worker( $worker_id );
			} catch ( \InvalidArgumentException $e ) {
				\WP_CLI::error( $e->getMessage() );
			}
		}

		[ $shell, $dumper, $stdout ] = $this->build_repl_graph( $attached, $ipc );

		// Stash the mode summary; the `status` builtin renders it on demand.
		if ( $attached && null !== $ipc ) {
			$shell->status_lines = [
				"Attached-cli mode for {$args[0]}",
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
	 * Build the REPL node graph (bare: _shell → interpreter → _router → _output; attached adds IPC nodes).
	 *
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell_Node,1:Dumper_Node,2:TTY_Out_Node}
	 */
	private function build_repl_graph( bool $attached, ?array $ipc ): array {
		$pid = (string) \getmypid();

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// `_stdout`: terminal writer; Dumper reaches via target/TO (Rule #2).
		$stdout = new TTY_Out_Node();
		$stdout->name( Node_Names::STDOUT );
		$stdout->sink( $interpreter );

		// `_output`: Shell stamps FROM=_output/$pid, so replies route here.
		$dumper = new Dumper_Node();
		$dumper->name( Node_Names::OUTPUT );
		$dumper->sink( $interpreter );
		$dumper->target( Node_Names::STDOUT );

		// Tap node for introspection of what the shell is sending.
		$console_tap = new Tap_Node();
		$console_tap->name( Node_Names::CONSOLE_TAP );
		$console_tap->sink( $interpreter );

		// Shell stays anonymous (Shell::name throws); `ls` filters by sink.
		$shell = new Shell_Node();
		$shell->sink( $console_tap );

		// Empty in bare mode; defined here so it's in scope for guarded blocks.
		$worker_id = ( $attached && null !== $ipc ) ? "{$ipc['type']}.p{$ipc['partition']}" : '';
		if ( $attached && null !== $ipc ) {
			$shell->prompt = "/{$worker_id}> ";
		}

		$dumper->set_shell( $shell );
		$stdout->set_shell( $shell );
		// readline only works on a real TTY; on a pipe it spins at 100% CPU.
		$is_tty = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$stdout->set_readline_mode( $is_tty && \function_exists( 'readline_callback_handler_install' ) );

		if ( $attached && null !== $ipc ) {
			// 1-partition IPC; skip allow_large_writes for concurrent appends.
			$ipc_out = new Partition_Node();
			$ipc_out->arguments( Worker_Base::ipc_partition_args( $ipc['input'] ) );
			$ipc_out->name( $worker_id );
			$ipc_out->sink( $interpreter );
			$shell->path = $worker_id;

			// reply-in: ephemeral, so empty offsetlog_dir (no durable cursor).
			$reply_in = new Node();
			$reply_in->sink( $router );
			$reply_in->target( Node_Names::OUTPUT );
			$ipc_in = new Consumer_Node();
			$ipc_in->arguments( [ $ipc['output'] ] );
			$ipc_in->next_offset( 'end' );
			$ipc_in->sink( $reply_in );
		}

		// Renders only empty-TO or this-pid messages here; other sessions drop.
		$dumper->set_to_filter( $pid );

		return [ $shell, $dumper, $stdout ];
	}

	/**
	 * Drive the REPL via the event loop until STDIN EOF. Readline on a TTY, fgets otherwise.
	 */
	private function run_repl( Shell_Node $shell, Dumper_Node $dumper, TTY_Out_Node $stdout ): void {
		// readline only on a real TTY; pipes fall to fgets (EOF-terminating).
		$is_tty       = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$has_readline = $is_tty && \function_exists( 'readline_callback_handler_install' );

		// Skip prompts when stdin is piped; they break `... | grep` consumers.
		$reader = new TTY_In_Node( $shell, $stdout, $has_readline, null, $is_tty );

		// Sink needed: Timer_Node::fire_cb() skips fire()/stdin-drain if none.
		$reader->sink( $shell );

		// Completion replies (KEY='completion') feed the cache, not printed.
		if ( $has_readline ) {
			$dumper->set_completion_sink(
				fn ( array $message ): bool => $reader->ingest_completion_reply( $message )
			);
			// Seed cache once intercept is wired, so first Tab has candidates.
			$reader->send_completion_queries();
		}

		// On worker's TM_EOF echo, flip exit so scripts don't orphan replies.
		$dumper->on_eof( static function () use ( $reader ): void {
			$reader->exit = true;
		} );

		// Schedule the first fire; subsequent fires self-schedule.
		$reader->set_timer( 0, true );
		Event_Framework::instance()->drain( static fn () => ! $reader->exit );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		// Trailing newline on a TTY; skipped when piped (breaks consumers).
		if ( $is_tty ) {
			\WP_CLI::log( '' );
		}
	}

}
