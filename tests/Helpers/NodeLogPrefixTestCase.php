<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Command_Interpreter_Node;

/**
 * A node's log line names the node exactly once.
 *
 * `Node::log_midfix()` prepends "<name>: " to every line a node emits through
 * `$this->stderr()` / `print_less_often()`, and omits it only when the process
 * name already starts with that name. So a message that hard-codes its own node
 * name reads "flame-builder: flame-builder: ..." on every worker whose process
 * name differs — and seven of them drifted that way unnoticed.
 *
 * The names come from the plugin's own `make_node` lines, because `$this->name`
 * is set at runtime from the topology, not from the class name. The static
 * `Core::` log helpers are deliberately out of scope: they add no node midfix,
 * so a context tag on those is the only identity the line carries.
 *
 * A plugin subclasses this and names its topology dir.
 */
abstract class NodeLogPrefixTestCase extends TestCase {

	/** Node log helpers that route through `Node::log_midfix()`. */
	private const MIDFIX_METHODS = [ 'print_less_often', 'print_least_often', 'stderr' ];

	/** Directory of `*.tsl` files whose make_node lines name this plugin's nodes. */
	abstract protected function topology_dir(): string;

	public function test_no_node_hard_codes_its_own_name_in_a_log_line(): void {
		$offences = [];
		foreach ( $this->nodes_by_source_file() as $file => $names ) {
			foreach ( $this->hard_coded_prefixes( $file ) as [ $line, $prefix ] ) {
				foreach ( $names as $name ) {
					if ( self::normalize( $prefix ) === self::normalize( $name ) ) {
						$offences[] = "{$file}:{$line} logs '{$prefix}: ' from node '{$name}'";
					}
				}
			}
		}
		$this->assertSame(
			[],
			$offences,
			"Node::log_midfix() already prints the name; drop it from the message:\n" . \implode( "\n", $offences )
		);
	}

	/**
	 * Every node class the topologies build, mapped to the names it runs under.
	 *
	 * @return array<string,list<string>> Source file => node names.
	 */
	private function nodes_by_source_file(): array {
		$dir = $this->topology_dir();
		$this->assertDirectoryExists( $dir, 'the topology dir the scan reads' );
		$by_file = [];
		foreach ( (array) \glob( $dir . '/*.tsl' ) as $tsl ) {
			$source = (string) \file_get_contents( (string) $tsl );
			\preg_match_all( '/^\s*make_node\s+(\S+)\s+(\S+)/m', $source, $matches, \PREG_SET_ORDER );
			foreach ( $matches as [ , $type, $name ] ) {
				$fqcn = Command_Interpreter_Node::resolve_class( $type );
				if ( null === $fqcn ) {
					continue;
				}
				$file = ( new \ReflectionClass( $fqcn ) )->getFileName();
				if ( false === $file ) {
					continue;
				}
				$by_file[ $file ][ $name ] = $name;
			}
		}
		return \array_map( '\array_values', $by_file );
	}

	/**
	 * Leading "word: " tags on the first argument of this file's `$this->` log
	 * calls. Tokenized rather than grepped: the string often sits on the line
	 * after the call, and a `Core::` call on the same method name must not match.
	 *
	 * @return list<array{0:int,1:string}> Line number and tag.
	 */
	private function hard_coded_prefixes( string $file ): array {
		$tokens = \token_get_all( (string) \file_get_contents( $file ) );
		$found  = [];
		foreach ( $tokens as $i => $token ) {
			if ( ! \is_array( $token ) || \T_STRING !== $token[0]
				|| ! \in_array( $token[1], self::MIDFIX_METHODS, true )
				|| '$this' !== self::receiver( $tokens, $i ) ) {
				continue;
			}
			$argument = self::first_argument( $tokens, $i );
			if ( null !== $argument && \preg_match( '/^([A-Za-z0-9_-]+):\s/', $argument, $tag ) ) {
				$found[] = [ $token[2], $tag[1] ];
			}
		}
		return $found;
	}

	/**
	 * The object a method call was made on, or '' when it is not a `->` call.
	 *
	 * @param list<array{0:int,1:string,2:int}|string> $tokens Whole-file tokens.
	 */
	private static function receiver( array $tokens, int $at ): string {
		$i = self::skip_space( $tokens, $at - 1, -1 );
		if ( ! \is_array( $tokens[ $i ] ) || \T_OBJECT_OPERATOR !== $tokens[ $i ][0] ) {
			return '';
		}
		$i = self::skip_space( $tokens, $i - 1, -1 );
		return \is_array( $tokens[ $i ] ) ? $tokens[ $i ][1] : (string) $tokens[ $i ];
	}

	/**
	 * The call's first argument when it is a plain string literal, else null.
	 *
	 * @param list<array{0:int,1:string,2:int}|string> $tokens Whole-file tokens.
	 */
	private static function first_argument( array $tokens, int $at ): ?string {
		$i = self::skip_space( $tokens, $at + 1, 1 );
		if ( '(' !== $tokens[ $i ] ) {
			return null;
		}
		$i    = self::skip_space( $tokens, $i + 1, 1 );
		$open = $tokens[ $i ];
		if ( \is_array( $open ) && \T_CONSTANT_ENCAPSED_STRING === $open[0] ) {
			return \substr( $open[1], 1, -1 );
		}
		// An interpolated "..." opens with a bare quote; the text follows it.
		$next = $tokens[ $i + 1 ] ?? null;
		if ( '"' === $open && \is_array( $next ) && \T_ENCAPSED_AND_WHITESPACE === $next[0] ) {
			return $next[1];
		}
		return null;
	}

	/**
	 * Index of the next non-whitespace token from $from, walking $step.
	 *
	 * @param list<array{0:int,1:string,2:int}|string> $tokens Whole-file tokens.
	 */
	private static function skip_space( array $tokens, int $from, int $step ): int {
		while ( isset( $tokens[ $from ] ) && \is_array( $tokens[ $from ] ) && \T_WHITESPACE === $tokens[ $from ][0] ) {
			$from += $step;
		}
		return $from;
	}

	/** Case and separators differ between a class-ish tag and a topology name. */
	private static function normalize( string $text ): string {
		return \strtolower( (string) \preg_replace( '/[^A-Za-z0-9]/', '', $text ) );
	}
}
