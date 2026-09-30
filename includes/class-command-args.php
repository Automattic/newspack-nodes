<?php
/**
 * Command_Args: the one argument grammar every verb is bound through.
 *
 * A command's `arguments` are a flat token array end to end — tokenized once
 * by the Shell or a REST producer, carried through the envelope, the
 * interpreter and `make_node` with the token boundaries intact, and re-joined
 * into a line only by `Node::serialize_args()` for `dump_config`. A verb whose
 * schema declares `args` has those tokens bound against the declaration by
 * `bind()`, which `Command_Interpreter_Node::dispatch()` runs before the
 * handler, so a handler reads its arguments by name and never parses. The
 * producers that mint a command `format()` the tokens.
 *
 * `typed()` is the one type rule for a token, shared with the `make_node`
 * positionals `Schema_Reflection::parse_schema_args()` reads.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Stateless and static: `bind()` reads a verb's tokens against its declared
 * args, `format()` builds tokens, and `option_int()` is the refusing integer
 * read of a WP-CLI flag.
 */
class Command_Args {

	/** What a refused token of each checked type was expected to be. */
	private const WANTED = [
		'int'   => 'a whole number',
		'float' => 'a number',
		'bool'  => 'a bool: 1, true, yes, on, 0, false, no or off',
	];

	/** The words a `bool` token may be, and what each reads as. */
	private const BOOL_WORDS = [
		'1'     => true,
		'true'  => true,
		'yes'   => true,
		'on'    => true,
		'0'     => false,
		'false' => false,
		'no'    => false,
		'off'   => false,
	];

	/**
	 * Bind a verb's argument tokens against its declared `args`, answering one
	 * value per declared name.
	 *
	 * Each arg arrives by position, in declared order, or as `--name=value`, and
	 * the two forms mix. A bare `--name` is `true`, which only a `bool` arg
	 * takes. The arg declaring `variadic` collects every positional from its
	 * position on, or every `--name=` repeat, as a list; an arg declared after
	 * it is reachable by name alone. A `secret` arg is named, never positional,
	 * because the browser masks only `--name=` tokens. An absent arg — or a
	 * blank token `unsupplied()` reads as a placeholder — takes its declared
	 * `default` through `default_of()`, refuses when it is `required`, and
	 * otherwise binds null — a variadic one, the empty list. `int`, `float` and
	 * `bool` args are typed through `typed()`; every other declared type binds
	 * the token as its string.
	 *
	 * Every refusal names what was wrong: an unknown option, a name given twice
	 * or both by position and by name, a surplus positional (by count, since it
	 * may be a mis-slotted secret), a secret given by position, a missing
	 * required arg, a bare flag where a value belongs, and a token of the wrong
	 * type (echoed, unless the arg is secret). None echoes a secret's value.
	 *
	 * @param array<array-key,mixed> $specs  The verb's declared `args`.
	 * @param list<string>           $tokens The verb's argument tokens.
	 * @return array<string,mixed> Arg name => bound value, in declared order.
	 * @throws \InvalidArgumentException When the tokens do not fit the declaration.
	 */
	public static function bind( array $specs, array $tokens ): array {
		$specs = \array_values( \array_filter( $specs, '\is_array' ) );
		$named = [];
		$given = [];
		$slot  = 0;
		$count = \count( \array_filter( $tokens, static fn ( string $token ): bool => ! \str_starts_with( $token, '--' ) ) );
		foreach ( $tokens as $token ) {
			if ( \str_starts_with( $token, '--' ) ) {
				$body = \substr( $token, 2 );
				$eq   = \strpos( $body, '=' );
				$name = false === $eq ? $body : \substr( $body, 0, $eq );
				$variadic = true === ( self::require_declared( $specs, $name )['variadic'] ?? false );
				if ( isset( $named[ $name ] ) && ! $variadic ) {
					self::refuse( "--{$name} given twice" );
				}
				if ( isset( $given[ $name ] ) && ! isset( $named[ $name ] ) ) {
					self::refuse( "{$name} given both by position and as --{$name}" );
				}
				$named[ $name ]   = true;
				$given[ $name ][] = false === $eq ? true : \substr( $body, $eq + 1 );
				continue;
			}
			$spec = self::spec_at( $specs, $slot++ );
			$name = Core::as_string( $spec['name'] ?? null );
			if ( '' === $name ) {
				self::refuse( "too many arguments: {$count} given, " . \count( $specs ) . ' accepted' );
			}
			if ( true === ( $spec['secret'] ?? false ) ) {
				self::refuse( "{$name} must be named: write --{$name}=<value>" );
			}
			if ( isset( $named[ $name ] ) ) {
				self::refuse( "{$name} given both by position and as --{$name}" );
			}
			$given[ $name ][] = $token;
		}

		$bound = [];
		foreach ( $specs as $spec ) {
			$name     = Core::as_string( $spec['name'] ?? '' );
			$variadic = true === ( $spec['variadic'] ?? false );
			$values   = $given[ $name ] ?? [];
			if ( ! $variadic && [] !== $values && self::unsupplied( $values[0], $spec ) ) {
				$values = [];
			}
			if ( [] !== $values ) {
				$typed          = \array_map( static fn ( string|true $value ): mixed => self::bind_value( $value, $spec ), $values );
				$bound[ $name ] = $variadic ? $typed : $typed[0];
			} elseif ( \array_key_exists( 'default', $spec ) ) {
				$bound[ $name ] = self::default_of( $spec );
			} elseif ( true === ( $spec['required'] ?? false ) ) {
				self::refuse( "missing required argument: {$name}" );
			} else {
				$bound[ $name ] = $variadic ? [] : null;
			}
		}
		return $bound;
	}

	/**
	 * An arg's declared `default`, the one default rule `bind()` and
	 * `Schema_Reflection::parse_schema_args()` share. A `<ns:key>` token
	 * default (e.g. `<config:max_segments>`) resolves strictly through its
	 * namespace resolver and is typed as a token would be, because a default
	 * lives in PHP and never passes through the TSL loader that resolves
	 * tokens on a line; a wrong namespace or a typo'd key throws rather than
	 * binding a feature-off value. Any other default is used verbatim.
	 *
	 * @param array<array-key,mixed> $spec The arg's declaration, carrying `default`.
	 * @return mixed The value to bind.
	 * @throws \RuntimeException On an unresolvable token.
	 * @throws \InvalidArgumentException When the resolved token is not of its type.
	 */
	public static function default_of( array $spec ): mixed {
		$default = $spec['default'] ?? null;
		if ( ! \is_string( $default ) || ! \preg_match( '/<[a-zA-Z_]\w*:[a-zA-Z_]\w*>/', $default ) ) {
			return $default;
		}
		return self::bind_value( Core::resolve_config_tokens( $default, true ), $spec );
	}

	/**
	 * One given value as its declared type: a bare flag is `true`, which only a
	 * `bool` takes, and a token goes through `typed()`. A mistyped token is
	 * echoed in the refusal unless the arg is `secret`.
	 *
	 * @param string|true            $value A token, or true for a bare `--name`.
	 * @param array<array-key,mixed> $spec  The arg's declaration.
	 * @return mixed The bound value.
	 * @throws \InvalidArgumentException On a bare flag for a non-bool, or a mistyped token.
	 */
	private static function bind_value( string|true $value, array $spec ): mixed {
		$name = Core::as_string( $spec['name'] ?? '' );
		$type = Core::as_string( $spec['type'] ?? '', 'string' );
		if ( true === $value ) {
			return 'bool' === $type ? true : self::refuse( "--{$name} needs a value: write --{$name}=<value>" );
		}
		$shown = true === ( $spec['secret'] ?? false ) ? Node::REDACTED : $value;
		return self::typed( $value, $type ) ?? self::refuse( "{$name} wants " . self::wanted( $type ) . ", got '{$shown}'" );
	}

	/**
	 * What a token refused by `typed()` should have been.
	 *
	 * @param string $type Declared type.
	 * @return string E.g. `a whole number`.
	 */
	public static function wanted( string $type ): string {
		return self::WANTED[ $type ] ?? "a {$type}";
	}

	/**
	 * A token read as its declared type: an `int` through the refusing
	 * `Core::canonical_decimal()`, a `float` when numeric, a `bool` when it is
	 * one of `BOOL_WORDS` in any case, and anything else as the string it is.
	 * Null when an `int`, `float` or `bool` token is not one; the caller
	 * refuses in its own words, naming `wanted()`.
	 *
	 * @param string $token Raw token.
	 * @param string $type  Declared type.
	 * @return mixed The typed value, or null when the token is not of its type.
	 */
	public static function typed( string $token, string $type ): mixed {
		return match ( $type ) {
			'int'   => Core::canonical_decimal( $token ),
			'float' => \is_numeric( $token ) ? (float) $token : null,
			'bool'  => self::BOOL_WORDS[ \strtolower( $token ) ] ?? null,
			default => $token,
		};
	}

	/**
	 * Whether a given token is the placeholder for "not supplied": a blank
	 * `int`, `float` or `bool`, which an editor writes to hold a slot open, or
	 * a blank for a `required` arg, which names nothing. A blank optional
	 * string is a value.
	 *
	 * @param mixed                  $token A given token.
	 * @param array<array-key,mixed> $spec  The arg's declaration.
	 * @return bool
	 */
	public static function unsupplied( mixed $token, array $spec ): bool {
		return '' === $token
			&& ( true === ( $spec['required'] ?? false ) || \in_array( $spec['type'] ?? '', [ 'int', 'float', 'bool' ], true ) );
	}

	/**
	 * The spec a positional in slot $slot binds to: the slot's own, or the
	 * variadic arg's once the walk has reached it; null past the last.
	 *
	 * @param list<array<array-key,mixed>> $specs The verb's declared `args`.
	 * @param int                          $slot  Zero-based positional index.
	 * @return array<array-key,mixed>|null
	 */
	private static function spec_at( array $specs, int $slot ): ?array {
		foreach ( $specs as $i => $spec ) {
			if ( $i === $slot || ( $i < $slot && true === ( $spec['variadic'] ?? false ) ) ) {
				return $spec;
			}
		}
		return null;
	}

	/**
	 * The spec declaring $name, refusing an option the verb does not declare
	 * and naming the ones it does.
	 *
	 * @param list<array<array-key,mixed>> $specs The verb's declared `args`.
	 * @param string                       $name  Option name, without `--`.
	 * @return array<array-key,mixed>
	 * @throws \InvalidArgumentException When no spec declares $name.
	 */
	private static function require_declared( array $specs, string $name ): array {
		foreach ( $specs as $spec ) {
			if ( ( $spec['name'] ?? null ) === $name ) {
				return $spec;
			}
		}
		$takes = \array_map( static fn ( array $spec ): string => Core::as_string( $spec['name'] ?? '' ), $specs );
		self::refuse( "unknown option --{$name}; this verb takes --" . \implode( ', --', $takes ) );
	}

	/**
	 * Raise a binding refusal; the interpreter answers it as the verb's TM_ERROR.
	 *
	 * @param string $detail What was wrong.
	 * @throws \InvalidArgumentException Always.
	 */
	private static function refuse( string $detail ): never {
		throw new \InvalidArgumentException( \esc_html( $detail ) );
	}

	/**
	 * The ONE typed read of an operator-supplied option: absent takes the
	 * fallback, present must be a non-negative canonical decimal — an int or
	 * the digits as a string — and anything else is null.
	 *
	 * Null is a REFUSAL, not a value — every `Core` coercion family resolves to
	 * a number instead, so `--partition=abc` picks p0 and `--timeout=2m` picks
	 * 2 seconds, and the command reports success on the wrong target. Reporting
	 * belongs to the caller, in its own voice: `CLI::require_flag_int` errors
	 * out of WP-CLI. A verb never needs it: `bind()` types a declared `int`.
	 *
	 * The map is WP-CLI's `$assoc_args`. A bare `--key` arrives as `true` and
	 * refuses too: casting a flag answers 1, which names partition 1.
	 *
	 * @param array<string,mixed> $options    Classified options.
	 * @param string              $key        Option name.
	 * @param int|null            $fallback   Value when the option is absent.
	 * @param bool                $allow_zero Whether 0 is acceptable.
	 * @return int|null The value when canonical, $fallback when absent, null when malformed.
	 */
	public static function option_int( array $options, string $key, ?int $fallback = null, bool $allow_zero = true ): ?int {
		if ( ! isset( $options[ $key ] ) ) {
			return $fallback;
		}
		return Core::canonical_decimal( $options[ $key ], $allow_zero );
	}

	/**
	 * Build the token list `bind()` reads from positionals and an options
	 * map. `true` renders as a bare `--key`, `false` as `--key=false`, an
	 * array as its comma-joined members, and every other scalar as its string
	 * cast.
	 *
	 * A member carrying a comma is indistinguishable from two once a handler
	 * splits the value back apart, so a list rides as a `variadic` arg's
	 * repeated tokens instead. `false` carries its value explicitly because the
	 * bare form already means true, and omitting the option would leave the
	 * verb's own default standing.
	 *
	 * Nothing is quoted here. A value carrying spaces stays whole inside its
	 * own array element, and quoting belongs to `Node::serialize_args()`, the
	 * one place tokens are re-joined into a single `dump_config` line.
	 *
	 * @api Consumed by sibling plugins.
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
				// (string) false is '', so false gets the word, not a cast.
				$value = 'false';
			} else {
				$value = (string) $value;
			}
			$tokens[] = '--' . $key . '=' . $value;
		}
		return $tokens;
	}
}
