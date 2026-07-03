<?php
/**
 * Command_Args: the shared Tachikoma-style argument grammar.
 *
 * Service interpreters take normal commands with arguments — required tokens
 * positional, optional named args as `--key=value`, boolean flags as bare
 * `--key`, lists comma-separated inside one value, and values with spaces
 * double-quoted. This is the ONE place that grammar lives: verb handlers
 * `parse()` the arguments string; callers and the hub->spoke forwarder
 * `format()` it. format() round-trips through parse().
 *
 * Structured blobs (a topology .tsl body, a layout positions JSON) do NOT ride
 * here — those verbs take `<name> <blob>` and split the rest-of-line themselves.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Command_Args {

	/**
	 * Parse a Tachikoma-style argument string.
	 *
	 * `--key=value` -> options[key]='value'; bare `--key` -> options[key]=true;
	 * everything else is a positional, in order. Double quotes group a value
	 * containing whitespace; `\"` and `\\` escape inside quotes.
	 *
	 * @return array{positional: list<string>, options: array<string,string|true>}
	 */
	public static function parse( string $args ): array {
		$positional = [];
		$options    = [];
		foreach ( self::tokenize( $args ) as $tok ) {
			if ( \str_starts_with( $tok, '--' ) ) {
				$body = \substr( $tok, 2 );
				$eq   = \strpos( $body, '=' );
				if ( false === $eq ) {
					$options[ $body ] = true;
				} else {
					$options[ \substr( $body, 0, $eq ) ] = \substr( $body, $eq + 1 );
				}
				continue;
			}
			$positional[] = $tok;
		}
		return [
			'positional' => $positional,
			'options'    => $options,
		];
	}

	/**
	 * Whitespace-split respecting double quotes and `\` escapes inside them.
	 *
	 * @return list<string>
	 */
	private static function tokenize( string $args ): array {
		$tokens   = [];
		$current  = '';
		$has_tok  = false;
		$in_quote = false;
		$escaped  = false;
		$length      = \strlen( $args );
		for ( $i = 0; $i < $length; $i++ ) {
			$ch = $args[ $i ];
			if ( $escaped ) {
				$current .= $ch;
				$escaped  = false;
				continue;
			}
			if ( $in_quote && '\\' === $ch ) {
				$escaped = true;
				continue;
			}
			if ( '"' === $ch ) {
				$in_quote = ! $in_quote;
				$has_tok  = true;
				continue;
			}
			if ( ! $in_quote && \ctype_space( $ch ) ) {
				if ( $has_tok ) {
					$tokens[] = $current;
					$current  = '';
					$has_tok  = false;
				}
				continue;
			}
			$current .= $ch;
			$has_tok  = true;
		}
		if ( $has_tok ) {
			$tokens[] = $current;
		}
		return $tokens;
	}

	/**
	 * Inverse of parse(): build a canonical argument string.
	 *
	 * Boolean true renders as a bare `--key`; false as `--key=false`; arrays
	 * comma-joined; scalars stringified. Any value with whitespace, quotes, a
	 * backslash, or empty is double-quoted (escaping `"` and `\`).
	 *
	 * @api
	 * @param list<string>                                       $positional
	 * @param array<string,string|int|float|bool|array<mixed>>   $options
	 */
	public static function format( array $positional = [], array $options = [] ): string {
		$parts = [];
		foreach ( $positional as $p ) {
			$parts[] = self::quote_if_needed( $p );
		}
		foreach ( $options as $key => $value ) {
			if ( true === $value ) {
				$parts[] = '--' . $key;
				continue;
			}
			if ( \is_array( $value ) ) {
				$value = \implode( ',', \array_map( '\strval', $value ) );
			} elseif ( false === $value ) {
				// `true` is the bare-flag case handled above; the only bool left is false.
				$value = 'false';
			} else {
				$value = (string) $value;
			}
			$parts[] = '--' . $key . '=' . self::quote_if_needed( $value );
		}
		return \implode( ' ', $parts );
	}

	/**
	 * Double-quote a value that would otherwise tokenize wrong (whitespace,
	 * quote, backslash, or empty), escaping `\` then `"`.
	 */
	private static function quote_if_needed( string $value ): string {
		if ( '' === $value || \preg_match( '/[\s"\\\\]/', $value ) ) {
			return '"' . \str_replace( [ '\\', '"' ], [ '\\\\', '\\"' ], $value ) . '"';
		}
		return $value;
	}
}
