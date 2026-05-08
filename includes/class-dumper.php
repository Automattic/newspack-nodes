<?php
/**
 * Dumper: terminal output node for the REPL.
 *
 * Dispatches by TYPE flag:
 *  - TM_COMMAND|TM_RESPONSE → unwrap Command JSON, print payload to stdout
 *    (special case: name=='prompt' updates the Shell's prompt, no print)
 *  - TM_ERROR               → "ERROR: …" to stderr
 *  - TM_INFO                → "INFO[from]: …" to stdout
 *  - default                → VALUE to stdout
 *
 * Does NOT do the escape-code prompt-below-async-output dance — deferred.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Dumper extends Node {
	/** @var resource */
	private $stdout;
	/** @var resource */
	private $stderr;

	private ?Shell $shell = null;

	/**
	 * @param resource|null $stdout Defaults to STDOUT. Pass php://memory for tests.
	 * @param resource|null $stderr Defaults to STDERR.
	 */
	public function __construct( $stdout = null, $stderr = null ) {
		$this->stdout = $stdout ?? \STDOUT;
		$this->stderr = $stderr ?? \STDERR;
	}

	public function set_shell( Shell $shell ): void {
		$this->shell = $shell;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		// TM_COMMAND|TM_RESPONSE: unwrap Command struct, dispatch by name.
		if ( ( $type & Message::TM_COMMAND ) && ( $type & Message::TM_RESPONSE ) ) {
			$cmd = \json_decode( (string) $message[ Message::VALUE ], true );
			if ( \is_array( $cmd ) ) {
				$name    = (string) ( $cmd['name'] ?? '' );
				$payload = (string) ( $cmd['payload'] ?? '' );

				if ( $name === 'prompt' && $this->shell !== null ) {
					$this->shell->prompt = $payload;
					return;
				}

				$this->write( $this->stdout, $payload, true );
				return;
			}
		}

		// TM_ERROR: stderr, prefixed.
		if ( $type & Message::TM_ERROR ) {
			$this->write( $this->stderr, 'ERROR: ' . (string) $message[ Message::VALUE ], false );
			return;
		}

		// TM_INFO: stdout, prefixed with FROM for context.
		if ( $type & Message::TM_INFO ) {
			$this->write(
				$this->stdout,
				'INFO[' . (string) $message[ Message::FROM ] . ']: ' . (string) $message[ Message::VALUE ],
				true
			);
			return;
		}

		// Default: print VALUE.
		$this->write( $this->stdout, (string) $message[ Message::VALUE ], true );
	}

	/**
	 * Write to the given stream. If $ensure_newline, append "\n" only when
	 * the payload doesn't already end with one (avoids double-newlines in
	 * common command output). For stderr we deliberately preserve the raw
	 * payload — error formatters typically include their own trailing newline.
	 */
	private function write( $stream, string $text, bool $ensure_newline ): void {
		if ( $ensure_newline && ! \str_ends_with( $text, "\n" ) ) {
			$text .= "\n";
		}
		\fwrite( $stream, $text );
	}
}
