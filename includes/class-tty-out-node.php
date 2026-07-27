<?php
/**
 * TTY_Out: prompt-aware terminal writer — Stdout_Node plus readline/ANSI redraw.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class TTY_Out_Node extends Stdout_Node {
	private const ANSI_CR_CLEAR_LINE  = "\r\033[2K";
	private const ANSI_RESTORE_CURSOR = "\033[u";

	private const ANSI_SAVE_CURSOR    = "\033[s";

	/** Whether a prompt is on screen; public so the Cli readline loop can flip it per iteration. */
	public bool $prompt_displayed = false;

	/** Readline path skips readline_redisplay in the async redraw to keep it in sync. */
	private bool $readline_mode = false;

	private ?Shell_Node $shell = null;

	/** Whether stdout is a real terminal, cached at construction; false → plain writes. */
	private bool $stdout_is_tty;

	/**
	 * @param resource|null $stdout    Defaults to STDOUT. Pass php://memory for tests.
	 * @param bool|null     $force_tty If non-null, override the posix_isatty() detection.
	 */
	public function __construct( $stdout = null, ?bool $force_tty = null ) {
		parent::__construct( $stdout );

		if ( null !== $force_tty ) {
			$this->stdout_is_tty = $force_tty;
		} else {
			$this->stdout_is_tty = \is_resource( $this->stdout )
				&& \function_exists( 'posix_isatty' )
				&& @\posix_isatty( $this->stdout );
		}
	}

	public function set_shell( Shell_Node $shell ): void {
		$this->shell = $shell;
	}

	public function set_readline_mode( bool $on ): void {
		$this->readline_mode = $on;
	}

	/**
	 * Mark that a prompt is on screen so the next async write wipes-and-redraws.
	 */
	public function mark_prompt_displayed(): void {
		$this->prompt_displayed = true;
	}

	/**
	 * Write the cli prompt onto our owned stdout stream and flip the flag.
	 */
	public function write_prompt( string $prompt ): void {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $this->stdout, $prompt );
		$this->prompt_displayed = true;
	}

	/**
	 * Async-output path: on a TTY with a prompt up, wipe-and-redraw; otherwise plain write.
	 */
	protected function write( string $text ): void {
		if ( ! $this->stdout_is_tty || ! $this->prompt_displayed || null === $this->shell ) {
			parent::write( $text );
			return;
		}

		$prompt = '';
		if ( \str_ends_with( $text, "\n" ) ) {
			 $prompt = $this->shell->prompt;
		}

		// stdout/stderr are the cli's own terminal streams, not WP-Filesystem.
		// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		if ( $this->readline_mode ) {
			// Empty prompt; skip readline_redisplay (flips to incr-search).
			\fwrite(
				$this->stdout,
				self::ANSI_CR_CLEAR_LINE . $text . $prompt
			);
			return;
		}

		\fwrite(
			$this->stdout,
			self::ANSI_SAVE_CURSOR
				. self::ANSI_CR_CLEAR_LINE
				. $text
				. $prompt
				. self::ANSI_RESTORE_CURSOR
		);
		// phpcs:enable
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Prompt-aware terminal writer — Stdout_Node plus readline/ANSI redraw.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}
