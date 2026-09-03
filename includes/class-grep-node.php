<?php
/**
 * Grep: the payload filter.
 *
 * Forwards a message whose VALUE matches a PCRE and drops every other one, so
 * one branch of a graph carries only the traffic a reader asked for. The stock
 * debug tap splices a Grep between a Dumper and a Stderr for exactly that.
 *
 * The pattern is the sole criterion; there is no type gate. A TM_COMMAND or a
 * TM_EOF whose VALUE misses the pattern drops with the data, so keep control
 * traffic off a grepped edge. The drop is silent: fill() returns nothing, so a
 * producer cannot tell a filtered message from a delivered one (ADR-13).
 *
 * Modeled on Tachikoma's `Grep.pm`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Grep node — `make_node Grep <name> [ <pattern> ]`.
 */
class Grep_Node extends Node {
	use Schema_Reflection;

	/** Grep.pm's default. `.` matches any byte but a newline, so a VALUE of newlines alone is what it drops. */
	private const MATCH_EVERYTHING = '.';

	/** The PCRE body as the operator typed it — the schema-declared argument. */
	private string $pattern = self::MATCH_EVERYTHING;

	/** The bracket-delimited form fill() matches with, mirroring Grep.pm's qr{}. */
	private string $compiled = '{' . self::MATCH_EVERYTHING . '}';

	/**
	 * Assign `pattern` from the positional token and compile it.
	 *
	 * `[ <pattern> ]` is a PCRE body, wrapped in `{}` the way Grep.pm wraps qr{}.
	 *
	 * The pattern compiles HERE, not at first fill(): `preg_match` answers a bad
	 * pattern with a warning and `false`, and a `false` return drops the message,
	 * so deferring the compile would trade one refusal for a silently discarded
	 * stream. The operator typed it on one line; that line is where it fails.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> The tokens as given.
	 * @throws \InvalidArgumentException When the pattern will not compile.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		// A blank token is "not supplied"; the schema default covers absent.
		if ( '' === $this->pattern ) {
			$this->pattern = self::MATCH_EVERYTHING;
		}
		$compiled = '{' . $this->pattern . '}';
		// @ turns the compile warning into the refusal below, not silence.
		if ( false === @\preg_match( $compiled, '' ) ) {
			$why = Core::as_string( \error_get_last()['message'] ?? '', '' );
			// preg_last_error_msg() says INTERNAL_ERROR for a compile failure.
			$why = '' === $why ? '' : ' — ' . \preg_replace( '/^preg_match\(\): /', '', $why );
			$this->refuse_argument( "pattern is not a valid regex, got '{$this->pattern}'{$why}" );
		}
		$this->compiled = $compiled;
		return $this->arguments;
	}

	/**
	 * Forward the message on a match, drop it otherwise.
	 *
	 * A non-string VALUE — a TM_STRUCT array, a number — is JSON-encoded before
	 * the match, so a struct producer's payload greps without a transform node in
	 * front. The pattern then reads JSON syntax: quotes and braces are part of the
	 * subject.
	 *
	 * @param array<int,mixed> $message Message reference.
	 */
	public function fill( array $message ): void {
		$value = $message[ Message::VALUE ];
		// Substitute a bad byte; failing to '' would drop a matching message.
		$subject = \is_string( $value )
			? $value
			: (string) \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES | \JSON_INVALID_UTF8_SUBSTITUTE );
		if ( 1 === \preg_match( $this->compiled, $subject ) ) {
			parent::fill( $message );
		}
	}

	/**
	 * Topology console manifest: the `Filtering` palette entry and the one
	 * `pattern` positional. Declaring it here is the whole parse — ADR-11 puts
	 * defaults and coercion in `parse_schema_args()`, not in `arguments()`.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Filtering',
			'description' => 'Forwards a message only when its VALUE matches a regex; drops the rest.',
			'arguments'   => [
				[ 'name' => 'pattern', 'type' => 'string', 'default' => self::MATCH_EVERYTHING, 'description' => 'PCRE regex matched against the message VALUE; forwards a message only on a match. Default (.) matches everything.' ],
			],
		] );
	}
}
