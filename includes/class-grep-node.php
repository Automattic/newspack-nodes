<?php
/**
 * Grep: payload filter. Forwards a message only when its VALUE matches the regex; drops the rest. Modeled on Tachikoma's Grep.pm.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Grep_Node extends Node {
	use Schema_Reflection;

	/** The PCRE body as the operator typed it — the schema-declared argument. */
	private string $pattern = self::MATCH_EVERYTHING;

	/** Bracket-delimited form fill() matches with (mirrors Grep.pm's qr{}). */
	private string $compiled = '{' . self::MATCH_EVERYTHING . '}';

	/** Grep.pm's default: any single character, so every non-empty VALUE passes. */
	private const MATCH_EVERYTHING = '.';

	/**
	 * `[ <pattern> ]` — a PCRE body, wrapped in `{}` the way Grep.pm wraps qr{}.
	 *
	 * The pattern compiles HERE, not at first fill(): `preg_match` answers a bad
	 * pattern with a warning and `false`, and a `false` return drops the message,
	 * so deferring the compile would trade one refusal for a silently discarded
	 * stream. The operator typed it on one line; that line is where it fails.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
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
			$who = Command_Interpreter_Node::shell_name_for( $this );
			if ( '' !== $this->name ) {
				$who .= " '{$this->name}'";
			}
			throw new \InvalidArgumentException(
				\esc_html( "Bad arguments for {$who}: pattern is not a valid regex, got '{$this->pattern}'" )
			);
		}
		$this->compiled = $compiled;
		return $this->arguments;
	}

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
