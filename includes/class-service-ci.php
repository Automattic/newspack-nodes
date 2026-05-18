<?php
/**
 * Service_CI: base class for substrate + application service CIs.
 *
 * Hoists the three verb-helper seams that every CI built on the M3 +
 * M2 dispatch path duplicates verbatim — `require_manage_options`,
 * `decode_args`, `require_valid_name`. Subclasses extend Service_CI
 * instead of CommandInterpreter and reach for the helpers via `self::`
 * inside their verb closures.
 *
 * The helpers are `protected static`. The legitimate callers are
 * subclass verb-table closures using `self::method()` — `self::` resolves
 * at compile time inside the closure's containing method, so static
 * closures (which can't `use ($this)`) still find them. No instance method
 * exists; the helpers don't need one.
 *
 * Lives at `includes/class-service-ci.php` rather than `includes/rest/`
 * because it's substrate infrastructure — both REST-facing CIs and
 * non-REST callers can inherit. Mirrors `class-command-interpreter.php`'s
 * location.
 *
 * Service_CI is inheritance-only. It has no verbs of its own and is NOT
 * registered with `CommandInterpreter::register_class()` — make_node-ing
 * a no-op base is useless and would clutter the editor's class palette.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

abstract class Service_CI extends CommandInterpreter {

	/**
	 * Authorisation gate. Throws a RuntimeException when the current user
	 * lacks the `manage_options` capability; CommandInterpreter::interpret()
	 * catches and wraps as TM_COMMAND|TM_ERROR.
	 *
	 * The `function_exists` guard keeps the helper usable in request-scope
	 * unit tests where the cap stub may not be loaded — same shape as the
	 * legacy per-CI copies it replaces.
	 */
	protected static function require_manage_options(): void {
		if ( \function_exists( 'current_user_can' ) && ! \current_user_can( 'manage_options' ) ) {
			throw new \RuntimeException( 'permission denied: manage_options required' );
		}
	}

	/**
	 * Pull a `name` field out of a payload-style associative array and
	 * validate it against $pattern. Defaults to `[a-zA-Z0-9_-]+` — the
	 * shape Layouts_CI and Topologies_CI both require. Callers needing a
	 * wider charset (e.g. layout node ids that include `:` / `.`) pass a
	 * custom pattern.
	 *
	 * @param array<int|string,mixed> $decoded Verb payload, typically the
	 *                                          structured-data slot of the
	 *                                          TM_COMMAND envelope.
	 * @param string                  $pattern Regex with delimiters; default is the
	 *                                          common file-name-safe pattern.
	 * @return string The validated name.
	 */
	protected static function require_valid_name(
		array $decoded,
		string $pattern = '/^[a-zA-Z0-9_-]+$/'
	): string {
		$name = (string) ( $decoded['name'] ?? '' );
		if ( ! \preg_match( $pattern, $name ) ) {
			throw new \RuntimeException(
				\esc_html( "invalid name: must match $pattern" )
			);
		}
		return $name;
	}
}
