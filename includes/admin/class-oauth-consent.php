<?php
/**
 * Oauth_Consent: the wp-admin page on which a user approves a connection.
 *
 * The authorization server's authorize endpoint. An MCP client sends the
 * user's browser here with an OAuth 2.1 authorization request; wp-admin
 * sends a visitor who is not logged in to `wp-login.php` and back. The page
 * checks every parameter before it shows anything, and on any failure shows
 * the error and redirects nowhere, so a redirect URI the client did not
 * register is shown, never followed. Otherwise it names the site, the
 * client, and in large type the host the credential will be sent to, with a
 * warning when that host is not Claude's or a loopback address, then asks
 * for a scope and a connection name.
 *
 * The decision posts to `admin-post.php`, which checks the nonce and every
 * parameter again: Deny sends `error=access_denied`, and Approve issues a
 * single-use code bound to the client, the redirect URI, the PKCE challenge,
 * the resource, the user, the scope and the name, and sends it with the
 * state to the exact URI the client registered.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Admin;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Core;
use Newspack_Nodes\Oauth_Server;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Sessions;

\defined( 'ABSPATH' ) || exit;

/**
 * The approval page and the handler its form posts to.
 *
 * @api The plugin file hooks `register()` on `admin_menu` and `decide()` on
 *      `admin_post_newspack_nodes_oauth_decide`.
 * @phpstan-type Request array{params:array<string,string>,client:string,scopes:list<string>}
 */
final class Oauth_Consent {

	/** The admin-post action the form names, and its nonce action. */
	public const DECIDE = 'newspack_nodes_oauth_decide';

	/** The nonce field's name. */
	public const NONCE = 'newspack_nodes_oauth_nonce';

	/** The authorization request's parameters, which the form carries on. */
	private const PARAMS = [ 'response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource' ];

	/** Claude's hosts; with the loopback hosts, the ones the page trusts. */
	private const CLAUDE_HOSTS = [ 'claude.ai', 'claude.com' ];

	/** The decision that approves; any other denies. */
	private const APPROVE = 'approve';

	/** The query argument that brings the form back asking for a name. */
	private const REFUSED = 'refused';

	/** The refusal of an approval that named no connection. */
	private const REFUSED_NAME = 'name';

	/** Static only. */
	private function __construct() {}

	/**
	 * Render the page for the authorization request in the query string.
	 *
	 * @api The page's callback.
	 */
	public static function render(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- an authorize request is a GET; the decision it leads to is nonced.
		$query   = $_GET;
		$request = self::request( $query );
		?>
		<div class="wrap newspack-nodes-theme newspack-nodes-ui">
			<h1>
				<?php
				/* translators: %s: the site's name. */
				echo \esc_html( \sprintf( \__( 'Connect to %s', 'newspack-nodes' ), \get_bloginfo( 'name' ) ) );
				?>
			</h1>
			<?php
			if ( \is_string( $request ) ) {
				self::banner( 'newspack-nodes-error-banner', $request );
			} else {
				self::form( $request, self::REFUSED_NAME === self::field( $query, self::REFUSED ) );
			}
			?>
		</div>
		<?php
	}

	/**
	 * The approval form for a checked request.
	 *
	 * @param Request $request      The request.
	 * @param bool    $refused_name Whether an approval came back naming no connection.
	 */
	private static function form( array $request, bool $refused_name ): void {
		$host   = Core::str( \wp_parse_url( $request['params']['redirect_uri'], \PHP_URL_HOST ) );
		$scopes = \array_reverse( $request['scopes'] );
		?>
		<p>
			<?php
			/* translators: 1: the client's name, 2: the site's name. */
			echo \esc_html( \sprintf( \__( '%1$s asks to connect to %2$s as you. Its credential will be sent to', 'newspack-nodes' ), $request['client'], \get_bloginfo( 'name' ) ) );
			?>
		</p>
		<p class="newspack-dashboard-title"><strong><?php echo \esc_html( $host ); ?></strong></p>
		<?php
		if ( ! \in_array( \strtolower( $host ), [ ...self::CLAUDE_HOSTS, ...Oauth_Store::LOOPBACK_HOSTS ], true ) ) {
			/* translators: %s: the host the credential is sent to. */
			self::banner( 'newspack-nodes-banner is-warning', \sprintf( \__( 'This connection sends its credential to %s, which is not Claude.', 'newspack-nodes' ), $host ) );
		}
		if ( $refused_name ) {
			self::banner( 'newspack-nodes-error-banner', \__( 'Name this connection before approving it.', 'newspack-nodes' ) );
		}
		?>
		<form method="post" action="<?php echo \esc_url( \admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="<?php echo \esc_attr( self::DECIDE ); ?>">
			<?php \wp_nonce_field( self::DECIDE, self::NONCE ); ?>
			<?php foreach ( $request['params'] as $name => $value ) : ?>
				<input type="hidden" name="<?php echo \esc_attr( $name ); ?>" value="<?php echo \esc_attr( $value ); ?>">
			<?php endforeach; ?>
			<fieldset>
				<legend><?php \esc_html_e( 'Access', 'newspack-nodes' ); ?></legend>
				<?php foreach ( $scopes as $scope ) : ?>
					<label>
						<input type="radio" name="scope" value="<?php echo \esc_attr( $scope ); ?>"<?php \checked( $scope, $scopes[0] ); ?>>
						<?php echo \esc_html( self::labels()[ $scope ] ?? throw new \LogicException( "no label for the OAuth scope {$scope}" ) ); ?>
					</label><br>
				<?php endforeach; ?>
			</fieldset>
			<p>
				<label for="newspack-nodes-oauth-name"><?php \esc_html_e( 'Connection name', 'newspack-nodes' ); ?></label><br>
				<input type="text" id="newspack-nodes-oauth-name" name="name" class="regular-text" required maxlength="<?php echo \esc_attr( (string) Sessions::MAX_LABEL ); ?>">
			</p>
			<p class="description"><?php \esc_html_e( 'Names this connection in the Sessions tab, such as the name of the person using it.', 'newspack-nodes' ); ?></p>
			<p class="submit">
				<button type="submit" name="decision" value="<?php echo \esc_attr( self::APPROVE ); ?>" class="button button-primary"><?php \esc_html_e( 'Approve', 'newspack-nodes' ); ?></button>
				<button type="submit" name="decision" value="deny" class="button" formnovalidate><?php \esc_html_e( 'Deny', 'newspack-nodes' ); ?></button>
			</p>
		</form>
		<?php
	}

	/**
	 * What the page calls each scope.
	 *
	 * @return array<string,string>
	 */
	private static function labels(): array {
		return [
			Capabilities::READ => \__( 'Read: read the dashboards', 'newspack-nodes' ),
			Capabilities::TUNE => \__( 'Tune: read the dashboards, and change settings and logging rules', 'newspack-nodes' ),
		];
	}

	/**
	 * One line of text in a banner.
	 *
	 * @param string $classes The banner's classes.
	 * @param string $text    Plain text, escaped here.
	 */
	private static function banner( string $classes, string $text ): void {
		echo '<div class="' . \esc_attr( $classes ) . '">' . \esc_html( $text ) . '</div>';
	}

	/**
	 * Decide the posted request: Deny or Approve, after the nonce and every
	 * parameter are checked again.
	 *
	 * @api Hooked on `admin_post_newspack_nodes_oauth_decide`.
	 */
	public static function decide(): never {
		$nonce = self::field( $_POST, self::NONCE ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- the nonce itself, verified next.
		if ( '' === $nonce || ! \wp_verify_nonce( $nonce, self::DECIDE ) ) {
			\wp_die( \esc_html__( 'Security check failed.', 'newspack-nodes' ) );
		}
		$request = self::request( $_POST );
		if ( \is_string( $request ) ) {
			\wp_die( \esc_html( $request ) );
		}
		$params = $request['params'];
		if ( self::APPROVE !== self::field( $_POST, 'decision' ) ) {
			self::send(
				$params['redirect_uri'],
				[
					'error' => 'access_denied',
					'state' => $params['state'],
				]
			);
		}
		$scope = self::field( $_POST, 'scope' );
		if ( ! \in_array( $scope, $request['scopes'], true ) ) {
			/* translators: %s: the scope the form asked for. */
			\wp_die( \esc_html( \sprintf( \__( 'Your account cannot grant %s on this site.', 'newspack-nodes' ), $scope ) ) );
		}
		$name = Sessions::clean_label( self::field( $_POST, 'name' ) );
		if ( '' === $name ) {
			self::ask_for_name( $params );
		}
		try {
			$code = Oauth_Store::issue_code(
				[
					'client'       => $params['client_id'],
					'redirect_uri' => $params['redirect_uri'],
					'challenge'    => $params['code_challenge'],
					'resource'     => $params['resource'],
					'user'         => \get_current_user_id(),
					'scope'        => $scope,
					'name'         => $name,
				]
			);
		} catch ( Session_Store_Unavailable $e ) {
			\wp_die( \esc_html( self::unavailable( $e ) ) );
		}
		self::send(
			$params['redirect_uri'],
			[
				'code'  => $code,
				'state' => $params['state'],
			]
		);
	}

	/**
	 * Return to the page, which asks for the connection name, and end the
	 * request.
	 *
	 * @param array<string,string> $params The request's parameters.
	 */
	private static function ask_for_name( array $params ): never {
		\wp_safe_redirect( self::with_query( Oauth_Server::authorization_endpoint(), $params + [ self::REFUSED => self::REFUSED_NAME ] ) );
		exit;
	}

	/**
	 * Redirect to the redirect URI the client registered, and end the
	 * request; `wp_safe_redirect()` would refuse its host.
	 *
	 * @param string               $uri   A redirect URI the client registered.
	 * @param array<string,string> $query The answer's parameters.
	 */
	private static function send( string $uri, array $query ): never {
		// phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect -- the exact URI the client registered, checked by the caller.
		\wp_redirect( self::with_query( $uri, $query ) );
		exit;
	}

	/**
	 * A URL with parameters appended, each percent-encoded.
	 *
	 * @param string                $url   The URL, with no fragment.
	 * @param array<string,string>  $query The parameters.
	 */
	private static function with_query( string $url, array $query ): string {
		return $url . ( \str_contains( $url, '?' ) ? '&' : '?' ) . \http_build_query( $query, '', '&', \PHP_QUERY_RFC3986 );
	}

	/**
	 * The authorization request in `$source`, checked, or why it is refused.
	 *
	 * @param array<array-key,mixed> $source The query string or the posted form.
	 * @return Request|string
	 */
	private static function request( array $source ): array|string {
		$fleet = Bootstrap::fleet_gate();
		if ( null !== $fleet ) {
			return $fleet->get_error_message();
		}
		$insecure = Oauth_Server::refuse_insecure();
		if ( null !== $insecure ) {
			return Core::str( $insecure['body']['error_description'] ?? null );
		}
		$params = [];
		foreach ( self::PARAMS as $name ) {
			$params[ $name ] = self::field( $source, $name );
			$value = $params[ $name ];
			// A redirect strips an encoded line break, so refuse control bytes.
			if ( 1 === \preg_match( '/[[:cntrl:]]/', $value ) || \html_entity_decode( \esc_attr( $value ), \ENT_QUOTES | \ENT_HTML5, 'UTF-8' ) !== $value ) {
				/* translators: %s: the parameter's name. */
				return \sprintf( \__( 'The %s cannot pass through this form unchanged.', 'newspack-nodes' ), $name );
			}
		}
		try {
			$client = Oauth_Store::client( $params['client_id'] );
		} catch ( Session_Store_Unavailable $e ) {
			return self::unavailable( $e );
		}
		if ( null === $client ) {
			return \__( 'No client is registered under that client_id.', 'newspack-nodes' );
		}
		if ( ! \in_array( $params['redirect_uri'], $client['redirect_uris'], true ) ) {
			/* translators: %s: the redirect URI the request named. */
			return \sprintf( \__( 'The redirect URI %s is not one this client registered, so this page will not send you there.', 'newspack-nodes' ), $params['redirect_uri'] );
		}
		if ( 'code' !== $params['response_type'] ) {
			return \__( 'The response_type must be code.', 'newspack-nodes' );
		}
		if ( 'S256' !== $params['code_challenge_method'] ) {
			return \__( 'The code_challenge_method must be S256.', 'newspack-nodes' );
		}
		if ( '' === $params['code_challenge'] ) {
			return \__( 'A code_challenge is required.', 'newspack-nodes' );
		}
		if ( '' === $params['state'] ) {
			return \__( 'A state is required.', 'newspack-nodes' );
		}
		if ( null === Oauth_Server::resource_metadata( $params['resource'] ) ) {
			/* translators: %s: the resource the request named. */
			return \sprintf( \__( 'This site serves no resource %s.', 'newspack-nodes' ), $params['resource'] );
		}
		$scopes = self::scopes();
		if ( [] === $scopes ) {
			/* translators: %s: the scopes OAuth grants, comma-separated. */
			return \sprintf( \__( 'Your account can grant none of %s on this site.', 'newspack-nodes' ), \implode( ', ', Oauth_Store::SCOPES ) );
		}
		return [
			'params' => $params,
			'client' => $client['name'],
			'scopes' => $scopes,
		];
	}

	/**
	 * The scopes of `Oauth_Store::SCOPES` the current user can grant.
	 *
	 * @return list<string>
	 */
	private static function scopes(): array {
		return \array_values( \array_filter( Oauth_Store::SCOPES, [ Oauth_Server::class, 'can_grant' ] ) );
	}

	/**
	 * The words for a store that did not answer. Its cause goes to the log.
	 *
	 * @param Session_Store_Unavailable $e The store's refusal.
	 */
	private static function unavailable( Session_Store_Unavailable $e ): string {
		Core::print_less_often( 'Oauth_Consent: the session store did not answer: ', $e->getMessage() );
		return \__( 'The session store is unavailable; try again shortly.', 'newspack-nodes' );
	}

	/**
	 * One field of a request, unslashed and otherwise as sent: a redirect URI
	 * is compared byte for byte, and a name is cleaned where it is kept.
	 *
	 * @param array<array-key,mixed> $source The query string or the posted form.
	 * @param string                 $name   The field.
	 * @return string Empty when absent or not a string.
	 */
	private static function field( array $source, string $name ): string {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- compared exactly or cleaned by the caller.
		return \is_string( $source[ $name ] ?? null ) ? Core::str( \wp_unslash( $source[ $name ] ) ) : '';
	}

	/**
	 * Add the page, hidden from the menu, for anyone who holds read.
	 *
	 * @api Hooked on `admin_menu`.
	 */
	public static function register(): void {
		$title = \__( 'Approve a connection', 'newspack-nodes' );
		$hook  = \add_submenu_page(
			'',
			$title,
			'',
			Capabilities::cap_for( Capabilities::READ ),
			Oauth_Server::AUTHORIZE_PAGE,
			[ self::class, 'render' ]
		);
		if ( false === $hook ) {
			return;
		}
		\add_action(
			"load-{$hook}",
			static function () use ( $title ): void {
				// phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited -- a page with no parent menu names no title of its own.
				$GLOBALS['title'] = $title;
				\wp_enqueue_style( 'newspack-nodes-ui' );
			}
		);
	}
}
