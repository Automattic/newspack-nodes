<?php
/**
 * VerbHarness: test fixture for service-CommandInterpreter (CI) verbs.
 *
 * Every M3 CI test uses this to fire a TM_COMMAND envelope through the
 * substrate's normal dispatch path (CI → base CI → Router → HTTP_In) and
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

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;

class VerbHarness {
	/**
	 * Build a request-scope graph and fire a verb against the supplied CI.
	 * Returns the verb's payload from the captured TM_RESPONSE.
	 *
	 * Per the command protocol, the response Message's VALUE is a live PHP
	 * array `['name'=>'<verb>','payload'=><result>]` — it rides through
	 * packed()/unpacked() as a nested object, so there is nothing to
	 * json_decode. The verb's `payload` is returned directly: a structure
	 * for verbs that return arrays/scalars, or the error-message string for
	 * a TM_COMMAND|TM_ERROR response (since `interpret()` puts the thrown
	 * message into `payload`).
	 *
	 * @param Command_Interpreter_Node $ci      CI under test (already constructed; the
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
	 * @return mixed The verb's payload (structure for success verbs; error-message string for TM_ERROR).
	 */
	public static function fire( Command_Interpreter_Node $ci, string $name, string $verb, mixed $payload = null, string $args = '', string $key = '' ): mixed {
		$router = new Router_Node(); $router->name( '_router' );
		$base   = new Command_Interpreter_Node(); $base->name( '_command_interpreter' ); $base->sink( $router );
		$ci->name( $name );
		$ci->sink( $base );

		// status_header seam is unused — tests assert on the verb's return
		// value, not which HTTP status code HTTP_In emitted. The closure
		// is a no-op so HTTP_In's fill() path runs without trying to call
		// the real \status_header() (which isn't defined in tests).
		$http_out = new HTTP_In_Node( static fn ( int $c ) => null );
		$http_out->name( '_http' );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_http';
		$msg[ Message::TO ]    = '';  // empty TO triggers dispatch in CI::fill
		$msg[ Message::ID ]    = 'test-' . \bin2hex( \random_bytes( 4 ) );
		$msg[ Message::KEY ]   = $key;
		// VALUE is the command struct as a live PHP array — never separately
		// json-encoded; only the envelope/wire (HTTP_In's packed Message) is JSON.
		$msg[ Message::VALUE ] = [
			'name'      => $verb,
			'arguments' => $args,
			'payload'   => $payload,
		];
		// This harness exercises verb LOGIC, not authorization (covered by
		// CommandAuthTest / CommandInterpreterTest). Mark the command as
		// in-process so the client-tier authorize gate passes.
		$msg[ Message::LOCAL ] = true;

		\ob_start();
		$ci->fill( $msg );
		$body = \ob_get_clean();

		if ( '' === $body ) {
			throw new \RuntimeException( "verb '{$verb}' on CI '{$name}' produced no response" );
		}
		// HTTP_In packs the whole response Message; unpacked() restores VALUE
		// as the live `['name'=>,'payload'=>]` array. The verb's payload is
		// returned directly — a structure for success verbs, or the
		// error-message string for a TM_COMMAND|TM_ERROR response.
		$reply   = Message::unpacked( $body );
		$command = $reply[ Message::VALUE ];
		if ( ! \is_array( $command ) || ! \array_key_exists( 'payload', $command ) ) {
			throw new \RuntimeException( 'response missing payload field' );
		}
		return $command['payload'];
	}

	/** Reset the request-scope graph between tests. */
	public static function reset(): void {
		Core::reset();
	}
}
