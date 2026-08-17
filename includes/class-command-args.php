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
	 * Classify a pre-split token list. `--key=value` -> options[key]='value';
	 * bare `--key` -> options[key]=true; everything else is a positional, in
	 * order. Token boundaries are the array's — no tokenizing, no unescaping.
	 *
	 * @param list<string> $args
	 * @return array{positional: list<string>, options: array<string,string|true>}
	 */
	public static function parse( array $args ): array {
		$positional = [];
		$options    = [];
		foreach ( $args as $tok ) {
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
	 * The ONE typed read of an operator-supplied option: absent takes the
	 * fallback, present must be a canonical decimal, anything else is null.
	 *
	 * Null is a REFUSAL, not a value — every `Core` coercion family resolves to
	 * a number instead, so `--partition=abc` picks p0 and `--timeout=2m` picks
	 * 2 seconds, and the command reports success on the wrong target. Reporting
	 * belongs to the caller, in its own voice: `CLI::require_flag_int` errors
	 * out of WP-CLI, `Service_CI_Node::require_option_int` throws for a verb.
	 *
	 * The map is the one `parse()` mints (`--key=value` => 'value', bare
	 * `--key` => true); WP-CLI's `$assoc_args` has the same shape.
	 *
	 * @param array<string,mixed> $options    Classified options.
	 * @param string              $key        Option name.
	 * @param int|null            $fallback   Value when the option is absent.
	 * @param bool                $allow_zero Whether 0 is acceptable.
	 */
	public static function option_int( array $options, string $key, ?int $fallback = null, bool $allow_zero = true ): ?int {
		if ( ! isset( $options[ $key ] ) ) {
			return $fallback;
		}
		return Core::canonical_decimal( $options[ $key ], $allow_zero );
	}

	/**
	 * Inverse of parse(): build the token list. Boolean true renders as a bare
	 * `--key`; false as `--key=false`; arrays comma-joined; scalars stringified.
	 * No quoting — a value with spaces stays inside one token (its own array
	 * element); the serialization anchor (dump_config) quotes when it must
	 * materialize tokens back to a single line.
	 *
	 * @api
	 * @param list<string>                                       $positional
	 * @param array<string,string|int|float|bool|array<mixed>>   $options
	 * @return list<string>
	 */
	public static function format( array $positional = [], array $options = [] ): array {
		$tokens = $positional;
		foreach ( $options as $key => $value ) {
			if ( true === $value ) {
				$tokens[] = '--' . $key;
				continue;
			}
			if ( \is_array( $value ) ) {
				$value = \implode( ',', \array_map( '\strval', $value ) );
			} elseif ( false === $value ) {
				// bare-flag `true` handled above; only false remains here.
				$value = 'false';
			} else {
				$value = (string) $value;
			}
			$tokens[] = '--' . $key . '=' . $value;
		}
		return $tokens;
	}
}
