<?php
/**
 * The authorization server's doors: `POST /newspack-nodes/v1/oauth/register`,
 * `POST /newspack-nodes/v1/oauth/token`, and the `.well-known` metadata.
 *
 * Neither route authenticates a user: registration is open to anyone and a
 * token request proves itself with its code and verifier or its refresh
 * token, so each permission callback checks only that this site runs the
 * fleet. The metadata documents live outside the REST namespace, where
 * RFC 8414 and RFC 9728 put them, so a `parse_request` handler answers them
 * before WordPress routes the request. `Oauth_Server` decides every answer;
 * this class sends it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Oauth_Server;

\defined( 'ABSPATH' ) || exit;

/**
 * Sends `Oauth_Server`'s answers: token and registration answers uncached,
 * as OAuth 2.1 requires, metadata to any origin.
 */
final class Oauth_Controller {

	/** Dynamic client registration. */
	public const REGISTER_ROUTE = '/oauth/register';

	/** The token endpoint. */
	public const TOKEN_ROUTE = '/oauth/token';

	/** Headers on every registration and token answer. */
	private const NO_STORE = [
		'Cache-Control' => 'no-store',
		'Pragma'        => 'no-cache',
	];

	/** Headers on every `.well-known` answer. */
	private const WELL_KNOWN_HEADERS = [
		'Content-Type'                => 'application/json; charset=utf-8',
		'Access-Control-Allow-Origin' => '*',
		'Cache-Control'               => 'no-store',
	];

	/**
	 * Exit seam. It replaces the one `exit` that ends a request after its
	 * `.well-known` answer is sent; tests count the call and read what was
	 * sent from the output buffer. Signature: `function (): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $exit = null;

	/**
	 * Register a public client from the request's JSON body (RFC 7591),
	 * metered by the caller's address.
	 *
	 * @param \WP_REST_Request $req The registration request.
	 */
	public function register( \WP_REST_Request $req ): \WP_REST_Response {
		return self::response( Oauth_Server::refuse_insecure() ?? Oauth_Server::register( Core::arr( $req->get_json_params() ), self::address() ) );
	}

	/** The caller's IP address, or `unknown`, which all such callers share. */
	private static function address(): string {
		// phpcs:ignore WordPressVIPMinimum.Variables.ServerVariables.UserControlledHeaders, WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__REMOTE_ADDR__ -- validated as an IP; it keys the rate limit of a POST no cache holds.
		$address = \filter_var( \wp_unslash( $_SERVER['REMOTE_ADDR'] ?? '' ), \FILTER_VALIDATE_IP );
		return \is_string( $address ) ? $address : 'unknown';
	}

	/**
	 * Answer a token request from its form body alone, so no credential is
	 * read from a URL, which access logs keep.
	 *
	 * @param \WP_REST_Request $req The token request.
	 */
	public function token( \WP_REST_Request $req ): \WP_REST_Response {
		return self::response( Oauth_Server::refuse_insecure() ?? Oauth_Server::token( $req->get_body_params() ) );
	}

	/**
	 * An answer as an uncached REST response.
	 *
	 * @param array{status:int,body:array<array-key,mixed>} $answer The answer.
	 */
	private static function response( array $answer ): \WP_REST_Response {
		return new \WP_REST_Response( $answer['body'], $answer['status'], self::NO_STORE );
	}

	/**
	 * Answer a `.well-known` OAuth path as JSON and exit; leave every other
	 * path, and every path on a subsite, to WordPress.
	 *
	 * @api Called by the plugin file's `parse_request` hook for an OAuth path.
	 * @param \WP $wp The request WordPress parsed.
	 */
	public static function serve_well_known( \WP $wp ): void {
		$answer = Oauth_Server::well_known( $wp->request );
		if ( null === $answer || null !== Bootstrap::fleet_gate() ) {
			return;
		}
		self::send( Oauth_Server::refuse_insecure() ?? $answer );
	}

	/**
	 * Send an answer as JSON and end the request.
	 *
	 * @param array{status:int,body:array<array-key,mixed>} $answer The answer.
	 */
	private static function send( array $answer ): void {
		\status_header( $answer['status'] );
		foreach ( self::WELL_KNOWN_HEADERS as $name => $value ) {
			\header( "{$name}: {$value}" );
		}
		echo \wp_json_encode( $answer['body'] ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a JSON document, sent as application/json.
		$exit = self::$exit ?? static function (): never {
			exit;
		};
		$exit();
	}

	/**
	 * Register both routes.
	 *
	 * @api Wired from Bootstrap::register_rest_routes().
	 */
	public function register_routes(): void {
		foreach ( [ self::REGISTER_ROUTE => 'register', self::TOKEN_ROUTE => 'token' ] as $route => $callback ) {
			\register_rest_route(
				HTTP_In_Node::REST_NAMESPACE,
				$route,
				[
					'methods'             => 'POST',
					'callback'            => [ $this, $callback ],
					'permission_callback' => [ $this, 'check_permission' ],
				]
			);
		}
	}

	/**
	 * Admit anyone on the fleet site; a subsite has no fleet to sign into.
	 *
	 * @return true|\WP_Error A 403 on a multisite subsite.
	 */
	public function check_permission(): bool|\WP_Error {
		return Bootstrap::fleet_gate() ?? true;
	}
}
