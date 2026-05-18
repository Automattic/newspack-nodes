<?php
/**
 * VerbHarness: test fixture for service-CommandInterpreter (CI) verbs.
 *
 * Every M3 CI test uses this to fire a TM_COMMAND envelope through the
 * substrate's normal dispatch path (CI → base CI → Router → HTTP_Out) and
 * pull the verb's return value back out as a decoded PHP value. Tests
 * therefore exercise the same plumbing the live REST controller does —
 * no special "for tests" shortcut — but assert on the verb's logical
 * result rather than parsing the on-wire Message themselves.
 *
 * Lifecycle: each fire() call builds a fresh request-scope graph
 * (_router / _command_interpreter / _http) plus the supplied CI; the
 * accompanying reset() (called from tearDown) clears Core's registry so
 * the next test's graph construction doesn't collide on names.
 *
 * Ported verbatim from newspack-event-logger-nodes (only the namespace
 * declaration differs); both event-logger CIs (M2) and substrate CIs
 * (M3) use the same dispatch surface, so the harness has the same shape.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Helpers;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;

class VerbHarness {
	/**
	 * Build a request-scope graph and fire a verb against the supplied CI.
	 * Returns the parsed payload from the captured TM_RESPONSE.
	 *
	 * The CommandInterpreter response envelope is JSON-encoded as
	 * `{"name":"<verb>","payload":"<string the verb returned>"}` (see
	 * CommandInterpreter::interpret in the substrate). When that payload
	 * string itself parses as JSON (the verb returned `wp_json_encode(...)`),
	 * the decoded value is returned; otherwise the raw payload string
	 * comes back unchanged so verbs that return plain text still work.
	 *
	 * @param CommandInterpreter $ci      CI under test (already constructed; the
	 *                                     harness names it and wires it into the
	 *                                     request-scope graph).
	 * @param string             $name    Name to register the CI under (e.g. 'classes').
	 * @param string             $verb    Verb to invoke (e.g. 'list').
	 * @param mixed              $payload Structured data the verb consumes via its
	 *                                     `$payload` parameter. Pass `null` (default)
	 *                                     for verbs that take no input.
	 * @param string             $args    Optional literal-string argument tail (the
	 *                                     `arguments` field). Most CIs read structured
	 *                                     data from `$payload`; this is for the few
	 *                                     verbs that genuinely take a CLI-style line.
	 * @param string             $key     Optional KEY field for the inbound message
	 *                                     (correlation metadata; rarely needed).
	 * @return mixed Decoded payload, or raw payload string if it isn't valid JSON.
	 */
	public static function fire( CommandInterpreter $ci, string $name, string $verb, mixed $payload = null, string $args = '', string $key = '' ): mixed {
		$router = new Router(); $router->name( '_router' );
		$base   = new CommandInterpreter(); $base->name( '_command_interpreter' ); $base->sink( $router );
		$ci->name( $name );
		$ci->sink( $base );

		// status_header seam is unused — tests assert on the verb's return
		// value, not which HTTP status code HTTP_Out emitted. The closure
		// is a no-op so HTTP_Out's fill() path runs without trying to call
		// the real \status_header() (which isn't defined in tests).
		$http_out = new HTTP_Out( static fn ( int $c ) => null );
		$http_out->name( '_http' );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_http';
		$msg[ Message::TO ]    = '';  // empty TO triggers dispatch in CI::fill
		$msg[ Message::ID ]    = 'test-' . \bin2hex( \random_bytes( 4 ) );
		$msg[ Message::KEY ]   = $key;
		$msg[ Message::VALUE ] = \wp_json_encode( [
			'name'      => $verb,
			'arguments' => $args,
			'payload'   => $payload,
		] );

		\ob_start();
		$ci->fill( $msg );
		$body = \ob_get_clean();

		if ( '' === $body ) {
			throw new \RuntimeException( "verb '{$verb}' on CI '{$name}' produced no response" );
		}
		$reply   = Message::unpacked( $body );
		$payload = \json_decode( $reply[ Message::VALUE ], true );
		if ( ! \is_array( $payload ) || ! \array_key_exists( 'payload', $payload ) ) {
			throw new \RuntimeException( 'response missing payload field' );
		}
		$decoded = \json_decode( $payload['payload'], true );
		// `null` is a valid JSON value, so 'null' decodes legitimately to null
		// — distinguish "couldn't decode, hand back the raw string" from "the
		// verb really did return null" by checking the literal text.
		return null === $decoded && 'null' !== $payload['payload']
			? $payload['payload']
			: $decoded;
	}

	/** Reset the request-scope graph between tests. */
	public static function reset(): void {
		Core::reset();
	}
}
