<?php
/**
 * Stdout: bare terminal sink — fwrites a message VALUE to its stream.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Stdout_Node extends Node {

	/** @var resource */
	protected $stdout;

	/**
	 * @param resource|null $stdout Defaults to STDOUT. Pass php://memory for tests.
	 */
	public function __construct( $stdout = null ) {
		parent::__construct();
		$this->stdout = $stdout ?? \STDOUT;
	}

	public function fill( array $message ): void {
		++$this->counter;
		$this->write( self::coerce_string( $message[ Message::VALUE ] ) );
	}

	/**
	 * Write seam. fwrites to the owned stream.
	 * Overridden by TTY_Out_Node for terminal-aware rendering.
	 */
	protected function write( string $text ): void {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $this->stdout, $text );
	}

	/**
	 * Coerce a mixed Message field to string, reproducing PHP's `(string)` cast
	 * (null→'', scalar→its string form, array→'Array') without a mixed-cast.
	 *
	 * @param mixed $v Raw Message field.
	 */
	private static function coerce_string( $v ): string {
		if ( \is_string( $v ) ) {
			return $v;
		}
		if ( null === $v ) {
			return '';
		}
		if ( \is_array( $v ) ) {
			return 'Array';
		}
		if ( \is_object( $v ) ) {
			return $v instanceof \Stringable ? (string) $v : '';
		}
		if ( \is_scalar( $v ) ) {
			return (string) $v;
		}
		return '';
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Bare terminal sink — fwrites a message VALUE to its stream.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}
