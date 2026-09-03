<?php
/**
 * Command_Args: the one argument grammar every service interpreter reads.
 *
 * A command's `arguments` are a flat token array end to end — tokenized once
 * by the Shell or a REST producer, carried verbatim through the envelope, the
 * interpreter and `make_node`, and re-joined into a line only by
 * `Node::serialize_args()` for `dump_config`. Inside that array the grammar is
 * Tachikoma's: required values ride positionally in the order the verb
 * declares, optional ones are named `--key=value`, a boolean flag is a bare
 * `--key`, and a list is comma-separated inside one value. Verb handlers
 * `parse()` the tokens, the producers that mint a command `format()` them,
 * and format() round-trips through parse().
 *
 * A structured blob — a topology .tsl body, a layout positions JSON — does not
 * ride here. Those verbs take the name and the whole body as two discrete
 * tokens, read through `Service_CI_Node::split_first_token()`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Command_Args {

	/**
	 * Classify a pre-split token list. A `--key=value` token becomes
	 * `options[key] = 'value'`, a bare `--key` becomes `options[key] = true`,
	 * and every other token is a positional, in order. Only the first `=`
	 * splits, so `--expr=a=b` carries the value `a=b`.
	 *
	 * Token boundaries are the array's. Nothing here tokenizes or unescapes,
	 * so a value carrying spaces or quote characters arrives whole from the
	 * producer that split the line.
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
	 * The map is the `options` half of `parse()`, and WP-CLI's `$assoc_args`
	 * has the same shape. A bare `--key` arrives as `true` and refuses too:
	 * casting a flag answers 1, which names partition 1.
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
	 * Inverse of parse(): build the token list from positionals and an options
	 * map. `true` renders as a bare `--key`, `false` as `--key=false`, an array
	 * as its comma-joined members, and every other scalar as its string cast.
	 *
	 * Nothing is quoted here. A value carrying spaces stays whole inside its
	 * own array element, and quoting belongs to `Node::serialize_args()`, the
	 * one place tokens are re-joined into a single `dump_config` line.
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
