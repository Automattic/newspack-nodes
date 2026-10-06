<?php
/**
 * Curl_Node: fetch the URL a TM_BYTESTREAM carries and emit the response.
 *
 * The port of Tachikoma's `Nodes/LWP.pm`. Each fill starts one GET on the
 * Event_Framework's shared multi, so neither `fill()` nor the transfer blocks
 * the drain loop, and the completion emits a copy of the input message: the
 * body as TM_BYTESTREAM, or a TM_ERROR naming the url and why. FROM, ID and
 * KEY ride along unread, and `target` stamps the empty TO as on any forwarded
 * message; the copy is never addressed back to FROM.
 *
 * Under a vault group each fetch looks for the group's entry on the url's
 * origin, its scheme, host and port: none fetches with no `Authorization`,
 * one sends that entry's credential, and two or more refuse. The credential
 * thus starts on its own origin; a redirect may still take the GET elsewhere,
 * and libcurl drops the header when it changes host, port or scheme.
 *
 * With `follow_redirects( false )` a fetch follows no redirect: a 3xx naming
 * a Location answers a TM_RESPONSE copy whose VALUE is that absolute url, and
 * a 3xx naming none answers a TM_ERROR as a status of 400 or more does.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Curl node — `make_node Curl <name> [vault_group]`.
 *
 * @implements Curl_Owner<array{context:array{message:array<int,mixed>,url:string},body:\Closure(): string}>
 */
class Curl_Node extends Node implements Curl_Owner {
	use Schema_Reflection;

	/** @use Curl_Transfer<array{message:array<int,mixed>,url:string}> */
	use Curl_Transfer;

	/** Transfers in flight at once; a fill past it is turned away as busy. */
	public const MAX_IN_FLIGHT = 16;

	/** Redirects followed before libcurl fails the transfer. */
	public const MAX_REDIRECTS = 5;

	/** Transfer timeout for one fetch, in seconds. */
	public const REQUEST_TIMEOUT = 30;

	/** The schemes a fetch and its redirects may use; https alone for a credential under `vault_require_ssl`. */
	private const PROTOCOLS = \CURLPROTO_HTTP | \CURLPROTO_HTTPS;

	/**
	 * The port a url names when it names none, by scheme.
	 *
	 * @api Crawler_Node
	 */
	public const DEFAULT_PORTS = [
		'http'  => 80,
		'https' => 443,
	];

	/** Vault group whose entries lend each fetch on their origin a credential; '' for none. */
	protected string $vault_group = '';

	/** Whether a fetch follows redirects; `follow_redirects()` sets it. */
	private bool $follow = true;

	/**
	 * Resolve the url VALUE carries and start a GET for it, or emit a TM_ERROR
	 * naming why none starts. Anything but a TM_BYTESTREAM is dropped: the
	 * output carries fetch responses and fetch failures, nothing passed through.
	 * Outside a running event loop nothing would ever complete a transfer, so
	 * none starts. Past MAX_IN_FLIGHT the fill is turned away as busy rather
	 * than queued.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type = $message[ Message::TYPE ];
		if ( ! \is_int( $type ) || ! ( $type & Message::TM_BYTESTREAM ) ) {
			$this->drop_message( $message, 'not a TM_BYTESTREAM url' );
			return;
		}
		$value = \trim( Core::as_string( $message[ Message::VALUE ] ) );
		try {
			$authorization = $this->authorization_for( $value );
		} catch ( \UnexpectedValueException $refusal ) {
			$this->emit( $message, Message::TM_ERROR, $refusal->getMessage() );
			return;
		}
		if ( ! Event_Framework::instance()->is_running() ) {
			$this->emit( $message, Message::TM_ERROR, "no event loop {$value}" );
			return;
		}
		$in_flight = $this->transfers_in_flight();
		if ( $in_flight >= self::MAX_IN_FLIGHT ) {
			$this->emit( $message, Message::TM_ERROR, "busy: {$in_flight} requests in flight {$value}" );
			return;
		}
		$this->fetch( $message, $value, $authorization );
	}

	/**
	 * The Authorization value to send with the url ('' for none): the
	 * credential of the one vault group entry on the url's origin, under which
	 * `vault_require_ssl` applies to the url.
	 *
	 * @param string $url The trimmed VALUE.
	 * @return string
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private function authorization_for( string $url ): string {
		$origin  = self::origin_of( $url );
		$vault   = Vault::get_instance();
		$matched = [];
		foreach ( $vault->in_group( $this->vault_group ) as $id ) {
			$server = $vault->get( $id );
			if ( null !== $server && $origin === self::origin_or_null( Vault::url_of( $server ) ) ) {
				$matched[ $id ] = $server;
			}
		}
		if ( [] === $matched ) {
			return '';
		}
		if ( 1 < \count( $matched ) ) {
			self::refuse( 'vault entries ' . \implode( ', ', \array_keys( $matched ) ) . " share origin {$origin} {$url}" );
		}
		if ( Vault::https_required( $url ) ) {
			self::refuse( "vault_require_ssl set but url is not https {$url}" );
		}
		return Vault::credential_header_for( \reset( $matched ) );
	}

	/**
	 * A vault entry's origin, or null for an entry whose url names none.
	 *
	 * @param string $url The entry's stored url.
	 * @return string|null
	 */
	private static function origin_or_null( string $url ): ?string {
		try {
			return self::origin_of( $url );
		} catch ( \UnexpectedValueException ) {
			return null;
		}
	}

	/**
	 * An absolute http(s) url's origin as `scheme://host:port`, lowercased,
	 * with the scheme's default port when the url names none. A url carrying
	 * userinfo is refused by `Vault::url_carries_credentials()`: PHP splits an
	 * authority at its last `@` where libcurl splits at its first, so the host
	 * read here need not be the host fetched. The refusal leaves the url out,
	 * since its userinfo may be a credential.
	 *
	 * @api Crawler_Node
	 *
	 * @param string $url The url to read.
	 * @return string
	 * @throws \UnexpectedValueException When it is not an absolute http(s) url with a host, or carries userinfo.
	 */
	public static function origin_of( string $url ): string {
		$parts  = \wp_parse_url( $url );
		$scheme = \strtolower( Core::as_string( $parts['scheme'] ?? '' ) );
		$host   = \strtolower( Core::as_string( $parts['host'] ?? '' ) );
		if ( ! isset( self::DEFAULT_PORTS[ $scheme ] ) || '' === $host ) {
			self::refuse( "invalid url {$url}" );
		}
		if ( Vault::url_carries_credentials( $url ) ) {
			self::refuse( 'invalid url carrying userinfo' );
		}
		$port = $parts['port'] ?? self::DEFAULT_PORTS[ $scheme ];
		return "{$scheme}://{$host}:{$port}";
	}

	/**
	 * Refuse the fetch; fill() emits the reason as the TM_ERROR VALUE.
	 *
	 * @param string $reason The refusal, prefix first, as a consumer matches it.
	 * @throws \UnexpectedValueException Always.
	 */
	private static function refuse( string $reason ): never {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- a message VALUE, not HTML; esc_html() would mangle the url.
		throw new \UnexpectedValueException( $reason );
	}

	/**
	 * Start the GET on the shared multi, holding the input message with the
	 * handle, because the output is a copy of it. A dispatch that yields no
	 * handle emits its TM_ERROR at once. A fetch carrying a credential under
	 * `vault_require_ssl` takes https alone, its redirects too, and no
	 * redirect to another host, port or scheme carries the credential.
	 *
	 * @param array<int,mixed> $message       The input message.
	 * @param string           $url           The url.
	 * @param string           $authorization The Authorization value, or ''.
	 */
	private function fetch( array $message, string $url, string $authorization ): void {
		$protocols = '' !== $authorization && Vault::require_ssl() ? \CURLPROTO_HTTPS : self::PROTOCOLS;
		$opts      = [
			\CURLOPT_URL             => $url,
			\CURLOPT_HTTPGET         => true,
			\CURLOPT_PROTOCOLS       => $protocols,
			\CURLOPT_REDIR_PROTOCOLS => $protocols,
			\CURLOPT_FOLLOWLOCATION  => $this->follow,
			\CURLOPT_UNRESTRICTED_AUTH => false,
			\CURLOPT_MAXREDIRS       => self::MAX_REDIRECTS,
			\CURLOPT_TIMEOUT         => self::REQUEST_TIMEOUT,
		] + Vault::tls_opts();
		if ( '' !== $authorization ) {
			$opts[ \CURLOPT_HTTPHEADER ] = [ 'Authorization: ' . $authorization ];
		}
		$started = $this->start_transfer(
			$opts,
			[
				'message' => $message,
				'url'     => $url,
			]
		);
		if ( ! $started ) {
			$this->emit( $message, Message::TM_ERROR, "curl_init failed {$url}" );
		}
	}

	/**
	 * Emit the completed fetch as a copy of its input message: the body below
	 * status 400, a TM_ERROR naming the status at or above it, and a TM_ERROR
	 * naming the curl error when the transfer failed — a timeout, a refused
	 * connection, or the body cap's short write. Following no redirects, a
	 * 3xx answers its Location as a TM_RESPONSE, or with none, a TM_ERROR.
	 *
	 * @param int                                         $result   The transfer's CURLE_* code.
	 * @param array{code:int,body:string,redirect:string} $response Its status, body and unfollowed Location.
	 * @param array{message:array<int,mixed>,url:string} $request  The input message and the url.
	 */
	protected function on_transfer_done( int $result, array $response, mixed $request ): void {
		$url = $request['url'];
		if ( \CURLE_OK !== $result ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_strerror
			$reason = Core::as_string( \curl_strerror( $result ) );
			$this->emit( $request['message'], Message::TM_ERROR, "curl error {$result} ({$reason}) {$url}" );
			return;
		}
		$redirected = ! $this->follow && $response['code'] >= 300 && $response['code'] < 400;
		if ( $redirected && '' !== $response['redirect'] ) {
			$this->emit( $request['message'], Message::TM_RESPONSE, $response['redirect'] );
			return;
		}
		if ( $redirected || $response['code'] >= 400 ) {
			$this->emit( $request['message'], Message::TM_ERROR, "HTTP {$response['code']} {$url}" );
			return;
		}
		$this->emit( $request['message'], Message::TM_BYTESTREAM, $response['body'] );
	}

	/**
	 * Forward a copy of the input message with its whole TYPE and its VALUE
	 * replaced; `Node::fill()` stamps TO from `target`.
	 *
	 * @param array<int,mixed> $message The input message.
	 * @param int              $type    TM_BYTESTREAM, TM_RESPONSE or TM_ERROR.
	 * @param string           $value   The body, the Location, or the error text.
	 */
	private function emit( array $message, int $type, string $value ): void {
		$message[ Message::TYPE ]  = $type;
		$message[ Message::VALUE ] = $value;
		parent::fill( $message );
	}

	/**
	 * Follow redirects, the default, or answer each 3xx with its Location.
	 *
	 * @api Crawler_Node
	 * @param bool $follow Whether a fetch follows redirects.
	 */
	public function follow_redirects( bool $follow ): void {
		$this->follow = $follow;
	}

	/**
	 * Teardown: release every in-flight easy handle.
	 *
	 * @api Used by substrate.
	 */
	public function remove_node(): void {
		$this->release_all();
		parent::remove_node();
	}

	/**
	 * Topology console manifest.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Fetch the URL a TM_BYTESTREAM carries (non-blocking GET) and emit the body, or a TM_ERROR naming the url and why.',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'vault_group', 'type' => 'vault_group', 'description' => 'Optional Vault group: a url on one entry\'s origin carries its credential as Authorization, and one on two entries\' origin is refused.' ],
			],
			'commands'    => [],
		];
	}
}
