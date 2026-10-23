<?php
/**
 * Oauth_Server: the authorization server that issues command sessions.
 *
 * The site is its own OAuth 2.1 authorization server, its issuer the home
 * URL. It publishes its metadata (RFC 8414) and each protected resource's
 * (RFC 9728), registers public clients dynamically (RFC 7591), and answers
 * two grants at the token endpoint: an authorization code proved with its
 * PKCE S256 verifier, and a refresh token, rotated on every use. The access
 * token is a command session, `<handle>.<secret>`, minted from the grant by
 * `Command_Auth::mint_grant_session()`; `Oauth_Store` keeps every row.
 *
 * Each answer is a status and a body, so the REST routes and the
 * `.well-known` handler in `Rest\Oauth_Controller` only send it. Errors
 * follow RFC 6749: `{ error, error_description }`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Rest\Oauth_Controller;

\defined( 'ABSPATH' ) || exit;

/**
 * Static calls from a request's parameters to its answer.
 *
 * @api `Rest\Oauth_Controller` answers with it, `Admin\Oauth_Consent`
 *      checks a request and the scopes a user can grant through it, and an
 *      MCP door names its metadata URL through `resource_metadata_url()`.
 * @phpstan-type Answer array{status:int,body:array<array-key,mixed>}
 */
final class Oauth_Server {

	/** The admin page on which a user approves a connection. */
	public const AUTHORIZE_PAGE = 'newspack-nodes-authorize';

	/** Where RFC 8414 puts the authorization server's metadata. */
	private const AUTHORIZATION_WELL_KNOWN = '/.well-known/oauth-authorization-server';

	/** Where RFC 9728 puts a resource's metadata, the resource's path appended. */
	private const RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource';

	/** The filter through which an application declares its resource URIs. */
	private const RESOURCES_FILTER = 'newspack_nodes/oauth_resources';

	/** The grants the token endpoint answers. */
	private const GRANT_TYPES = [ 'authorization_code', 'refresh_token' ];

	/** The fields a code exchange must carry, besides its client. */
	private const EXCHANGE_FIELDS = [ 'code', 'redirect_uri', 'code_verifier', 'resource' ];

	/** Registrations one address may make in REGISTER_WINDOW_S. */
	private const REGISTER_BURST = 10;

	/** The registration budget's window, in seconds. */
	private const REGISTER_WINDOW_S = 3600;

	/** Token requests one client may make in TOKEN_WINDOW_S. */
	private const TOKEN_BURST = 30;

	/** The token budget's window, in seconds. */
	private const TOKEN_WINDOW_S = 60;

	/** Static only. */
	private function __construct() {}

	/**
	 * A protected resource's metadata (RFC 9728), for a resource an
	 * application declares through `newspack_nodes/oauth_resources`.
	 *
	 * @param string $resource The resource's canonical URI.
	 * @return array<string,mixed>|null Null for a resource no filter declares.
	 */
	public static function resource_metadata( string $resource ): ?array {
		return \in_array( $resource, self::resources(), true ) ? self::document( $resource ) : null;
	}

	/**
	 * Where a resource's metadata is served: the RFC 9728 well-known path
	 * with the resource's own path appended.
	 *
	 * @param string $resource The resource's canonical URI.
	 */
	public static function resource_metadata_url( string $resource ): string {
		return \home_url( self::RESOURCE_WELL_KNOWN ) . self::path_of( $resource );
	}

	/**
	 * The answer for a `.well-known` path: a metadata document, a 404 for a
	 * resource path no filter declares, or null for every other path.
	 *
	 * @param string $request The request path below the home URL, as
	 *                        `WP::$request` holds it: no leading slash.
	 * @return Answer|null
	 */
	public static function well_known( string $request ): ?array {
		$path = '/' . $request;
		if ( self::AUTHORIZATION_WELL_KNOWN === $path ) {
			return self::answer( 200, self::authorization_metadata() );
		}
		if ( self::RESOURCE_WELL_KNOWN !== $path && ! \str_starts_with( $path, self::RESOURCE_WELL_KNOWN . '/' ) ) {
			return null;
		}
		foreach ( self::resources() as $resource ) {
			if ( self::RESOURCE_WELL_KNOWN . self::path_of( $resource ) === $path ) {
				return self::answer( 200, self::document( $resource ) );
			}
		}
		return self::error( 404, 'invalid_target', 'No protected resource is declared at this path.' );
	}

	/**
	 * A declared resource's metadata document.
	 *
	 * @param string $resource The resource's canonical URI.
	 * @return array<string,mixed>
	 */
	private static function document( string $resource ): array {
		return [
			'resource'                 => $resource,
			'authorization_servers'    => [ self::issuer() ],
			'scopes_supported'         => Oauth_Store::SCOPES,
			'bearer_methods_supported' => [ 'header' ],
		];
	}

	/**
	 * A resource URI's path, which its metadata URL appends, with no trailing
	 * slash, because WordPress trims the request path it is matched against.
	 *
	 * @param string $resource The resource's canonical URI.
	 */
	private static function path_of( string $resource ): string {
		return \rtrim( Core::str( \wp_parse_url( $resource, \PHP_URL_PATH ) ), '/' );
	}

	/**
	 * The resources the applications declare.
	 *
	 * @return list<string>
	 */
	private static function resources(): array {
		return \array_values( \array_filter( Core::arr( \apply_filters( self::RESOURCES_FILTER, [] ) ), 'is_string' ) );
	}

	/**
	 * The authorization server's metadata (RFC 8414).
	 *
	 * @return array<string,mixed>
	 */
	public static function authorization_metadata(): array {
		return [
			'issuer'                                => self::issuer(),
			'authorization_endpoint'                => self::authorization_endpoint(),
			'token_endpoint'                        => \rest_url( HTTP_In_Node::REST_NAMESPACE . Oauth_Controller::TOKEN_ROUTE ),
			'registration_endpoint'                 => \rest_url( HTTP_In_Node::REST_NAMESPACE . Oauth_Controller::REGISTER_ROUTE ),
			'response_types_supported'              => [ 'code' ],
			'grant_types_supported'                 => self::GRANT_TYPES,
			'code_challenge_methods_supported'      => [ 'S256' ],
			'token_endpoint_auth_methods_supported' => [ 'none' ],
			'scopes_supported'                      => Oauth_Store::SCOPES,
		];
	}

	/** The approval page's URL, which the metadata names as the authorize endpoint. */
	public static function authorization_endpoint(): string {
		return \admin_url( 'admin.php?page=' . self::AUTHORIZE_PAGE );
	}

	/** The issuer: the home URL, with no trailing slash. */
	private static function issuer(): string {
		return \rtrim( \home_url(), '/' );
	}

	/**
	 * The refusal for a request that did not arrive over HTTPS, which every
	 * endpoint of the server requires; null for one that did.
	 *
	 * @return Answer|null
	 */
	public static function refuse_insecure(): ?array {
		return \is_ssl() ? null : self::error( 400, 'invalid_request', 'The authorization server answers over HTTPS alone.' );
	}

	/**
	 * Register a public client (RFC 7591), REGISTER_BURST an hour from one
	 * address. A client names itself and its redirect URIs; anything else it
	 * asks for is answered with what it is given: no secret, both grants,
	 * the code response type.
	 *
	 * @param array<array-key,mixed> $metadata The client's registration request.
	 * @param string                 $address  The caller's IP address, its budget's key.
	 * @return Answer 201 with the client's registered metadata, or an error.
	 */
	public static function register( array $metadata, string $address ): array {
		$metered = self::meter( "oauth-register:{$address}", self::REGISTER_BURST, self::REGISTER_WINDOW_S );
		if ( null !== $metered ) {
			return $metered;
		}
		if ( 'none' !== ( $metadata['token_endpoint_auth_method'] ?? 'none' ) ) {
			return self::error( 400, 'invalid_client_metadata', 'Only a public client registers: token_endpoint_auth_method is none.' );
		}
		try {
			$client = Oauth_Store::register_client( Core::str( $metadata['client_name'] ?? null ), Core::arr( $metadata['redirect_uris'] ?? null ) );
		} catch ( \InvalidArgumentException $e ) {
			$error = Oauth_Store::REFUSED_NAME === $e->getCode() ? 'invalid_client_metadata' : 'invalid_redirect_uri';
			return self::error( 400, $error, $e->getMessage() );
		} catch ( Session_Store_Unavailable $e ) {
			return self::unavailable( $e );
		}
		return self::answer(
			201,
			[
				'client_id'                  => $client['id'],
				'client_id_issued_at'        => $client['created'],
				'client_name'                => $client['name'],
				'redirect_uris'              => $client['redirect_uris'],
				'token_endpoint_auth_method' => 'none',
				'grant_types'                => self::GRANT_TYPES,
				'response_types'             => [ 'code' ],
			]
		);
	}

	/**
	 * Answer a token request. The client is checked first, so an unknown one
	 * spends no slot of anyone's budget and learns to register again; then
	 * TOKEN_BURST a minute per client.
	 *
	 * @param array<array-key,mixed> $params The request's parameters.
	 * @return Answer 200 with the token response, or an error.
	 */
	public static function token( array $params ): array {
		$grant_type = Core::str( $params['grant_type'] ?? null );
		if ( ! \in_array( $grant_type, self::GRANT_TYPES, true ) ) {
			return '' === $grant_type
				? self::error( 400, 'invalid_request', 'A token request names its grant_type.' )
				: self::error( 400, 'unsupported_grant_type', 'The grant types are ' . \implode( ' and ', self::GRANT_TYPES ) . '.' );
		}
		$client = Core::str( $params['client_id'] ?? null );
		try {
			if ( null === Oauth_Store::client( $client ) ) {
				return self::error( 401, 'invalid_client', 'No client is registered under that client_id; register again.' );
			}
			return self::meter( "oauth-token:{$client}", self::TOKEN_BURST, self::TOKEN_WINDOW_S )
				?? ( 'authorization_code' === $grant_type ? self::exchange( $client, $params ) : self::refresh( $client, $params ) );
		} catch ( Session_Store_Unavailable $e ) {
			return self::unavailable( $e );
		}
	}

	/**
	 * The answer to a store that does not answer. Its cause goes to the log.
	 *
	 * @param Session_Store_Unavailable $e The store's refusal.
	 * @return Answer
	 */
	private static function unavailable( Session_Store_Unavailable $e ): array {
		Core::print_less_often( 'Oauth_Server: 503, ', $e->getMessage() );
		return self::error( 503, 'temporarily_unavailable', 'The session store is unavailable; try again shortly.' );
	}

	/**
	 * Rotate a refresh token into a new session of its grant. The store
	 * refuses a token issued to another client, or a request naming another
	 * resource than the grant's, retry or not; a request naming none is bound
	 * to the grant's.
	 *
	 * @param string                 $client The registered client.
	 * @param array<array-key,mixed> $params The request's parameters.
	 * @return Answer
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function refresh( string $client, array $params ): array {
		$refresh = Core::str( $params['refresh_token'] ?? null );
		if ( '' === $refresh ) {
			return self::error( 400, 'invalid_request', 'A refresh names its refresh_token.' );
		}
		$resource = Core::str( $params['resource'] ?? null );
		try {
			$answer = Oauth_Store::rotate(
				$refresh,
				$client,
				'' === $resource ? null : $resource,
				static fn ( array $grant, string $grant_id, string $next ): array => self::mint( $grant_id, Core::int( $grant['user'] ?? null ), Core::str( $grant['scope'] ?? null ), $next )
			);
		} catch ( Session_Store_Unavailable $e ) {
			throw $e;
		} catch ( \RuntimeException ) {
			return self::invalid_grant();
		}
		return null === $answer ? self::invalid_grant() : self::answer( 200, $answer );
	}

	/**
	 * Exchange a code for the first session of a new grant. The code is
	 * taken first, so a refused exchange spends it too. It must have been
	 * issued to this client, for this exact redirect URI and resource, and
	 * the verifier must hash to its challenge.
	 *
	 * @param string                 $client The registered client.
	 * @param array<array-key,mixed> $params The request's parameters.
	 * @return Answer
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function exchange( string $client, array $params ): array {
		$fields = [];
		foreach ( self::EXCHANGE_FIELDS as $field ) {
			$fields[ $field ] = Core::str( $params[ $field ] ?? null );
			if ( '' === $fields[ $field ] ) {
				return self::error( 400, 'invalid_request', "A code exchange names its {$field}." );
			}
		}
		$bound = Oauth_Store::take_code( $fields['code'] );
		if ( null === $bound
			|| Core::str( $bound['client'] ?? null ) !== $client
			|| Core::str( $bound['redirect_uri'] ?? null ) !== $fields['redirect_uri']
			|| ! \hash_equals( Core::str( $bound['challenge'] ?? null ), self::s256( $fields['code_verifier'] ) )
			|| Core::str( $bound['resource'] ?? null ) !== $fields['resource']
		) {
			return self::invalid_grant();
		}
		$user   = Core::int( $bound['user'] ?? null );
		$scope  = Core::str( $bound['scope'] ?? null );
		$opened = Oauth_Store::open_grant(
			[
				'client'   => $client,
				'user'     => $user,
				'scope'    => $scope,
				'resource' => $fields['resource'],
				'name'     => Core::str( $bound['name'] ?? null ),
			]
		);
		try {
			return self::answer( 200, self::mint( $opened['grant'], $user, $scope, $opened['refresh'] )['answer'] );
		} catch ( Session_Store_Unavailable $e ) {
			self::abandon( $opened['grant'] );
			throw $e;
		} catch ( \RuntimeException ) {
			Oauth_Store::revoke_grant( $opened['grant'] );
			return self::invalid_grant();
		}
	}

	/**
	 * Revoke a grant no answer named, as far as a failing store allows; what
	 * it refuses goes to the log, and the grant lapses on its own.
	 *
	 * @param string $grant Grant id.
	 */
	private static function abandon( string $grant ): void {
		try {
			Oauth_Store::revoke_grant( $grant );
		} catch ( Session_Store_Unavailable $e ) {
			Core::print_less_often( 'Oauth_Server: an unanswered grant stays until it lapses: ', $e->getMessage() );
		}
	}

	/**
	 * Mint a session of a grant and the token response naming it. A user
	 * who no longer holds the grant's scope ends the grant instead.
	 *
	 * @param string $grant_id The grant, from the store alone.
	 * @param int    $user     The user who approved it.
	 * @param string $scope    The scope it holds.
	 * @param string $refresh  The refresh token the response hands out.
	 * @return array{answer:array<string,mixed>,handle:string}
	 * @throws \RuntimeException When the user lost the scope, or the grant
	 *                           mints no session.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function mint( string $grant_id, int $user, string $scope, string $refresh ): array {
		if ( ! self::holds( $user, $scope ) ) {
			Oauth_Store::revoke_grant( $grant_id );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message, never sent.
			throw new \RuntimeException( "the user of grant {$grant_id} no longer holds {$scope}" );
		}
		$session = Command_Auth::mint_grant_session( $grant_id );
		return [
			'answer' => [
				'access_token'  => "{$session['handle']}.{$session['secret']}",
				'token_type'    => 'Bearer',
				'expires_in'    => $session['expires_in'],
				'refresh_token' => $refresh,
				'scope'         => $session['scope'],
			],
			'handle' => $session['handle'],
		];
	}

	/**
	 * Whether a user still holds a scope, asked as that user, who is signed
	 * out again whatever the answer.
	 *
	 * @param int    $user  The user.
	 * @param string $scope The scope.
	 */
	private static function holds( int $user, string $scope ): bool {
		$caller = \get_current_user_id();
		\wp_set_current_user( $user );
		try {
			return self::can_grant( $scope );
		} finally {
			\wp_set_current_user( $caller );
		}
	}

	/**
	 * Whether the current user can grant a scope through OAuth: one of
	 * `Oauth_Store::SCOPES`, whose own capability they hold. A broader role
	 * does not stand in for it: each verb checks its own role's capability.
	 *
	 * @api The approval page offers the scopes it admits.
	 * @param string $scope The scope.
	 */
	public static function can_grant( string $scope ): bool {
		return \in_array( $scope, Oauth_Store::SCOPES, true ) && Capabilities::can( $scope );
	}

	/**
	 * The refusal of a code or refresh token.
	 *
	 * @return Answer
	 */
	private static function invalid_grant(): array {
		return self::error( 400, 'invalid_grant', 'The code or refresh token is unknown, expired or spent, or was issued for another client, redirect URI or resource.' );
	}

	/**
	 * A PKCE S256 challenge: the verifier's SHA-256, base64url without padding.
	 *
	 * @param string $verifier The code verifier.
	 */
	private static function s256( string $verifier ): string {
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- RFC 7636 defines the challenge as base64url.
		return \rtrim( \strtr( \base64_encode( \hash( 'sha256', $verifier, true ) ), '+/', '-_' ), '=' );
	}

	/**
	 * Claim one slot of a budget.
	 *
	 * @param string $name     The budget's name.
	 * @param int    $burst    Requests admitted per window.
	 * @param int    $window_s The window, in seconds.
	 * @return Answer|null Null when admitted; 429 throttled, 503 when no cache
	 *                     can meter it, as the MCP door refuses one.
	 */
	private static function meter( string $name, int $burst, int $window_s ): ?array {
		return match ( Rate_Limit::claim( $name, $burst, $window_s ) ) {
			Rate_Limit::ADMITTED    => null,
			Rate_Limit::THROTTLED   => self::error( 429, 'rate_limited', 'Too many requests; please slow down.' ),
			Rate_Limit::UNAVAILABLE => self::error( 503, 'rate_limit_unavailable', 'OAuth requests are metered in memcached or APCu, and neither answered.' ),
		};
	}

	/**
	 * An RFC 6749 error.
	 *
	 * @param int    $status      HTTP status.
	 * @param string $error       The error code.
	 * @param string $description What went wrong, for the developer.
	 * @return Answer
	 */
	private static function error( int $status, string $error, string $description ): array {
		return self::answer(
			$status,
			[
				'error'             => $error,
				'error_description' => $description,
			]
		);
	}

	/**
	 * A status and a body.
	 *
	 * @param int                    $status HTTP status.
	 * @param array<array-key,mixed> $body   The JSON body.
	 * @return Answer
	 */
	private static function answer( int $status, array $body ): array {
		return [
			'status' => $status,
			'body'   => $body,
		];
	}
}
