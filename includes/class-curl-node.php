<?php
/**
 * Curl_Node: fetch the URL a TM_BYTESTREAM carries, or run the request a
 * TM_STRUCT carries, and emit the response.
 *
 * The port of Tachikoma's `Nodes/LWP.pm`. Each fill starts one transfer on
 * the Event_Framework's shared multi, so neither `fill()` nor the transfer
 * blocks the drain loop, and the completion emits a copy of the input
 * message: the body as TM_BYTESTREAM, or a TM_ERROR naming the url and why.
 * FROM, ID and KEY ride along unread, and `target` stamps the empty TO as on
 * any forwarded message; the copy is never addressed back to FROM.
 *
 * A TM_BYTESTREAM's VALUE is a url, fetched with a GET. A TM_STRUCT's VALUE
 * is `{ url, method, body, headers, proxy, response_headers }`: `method` GET,
 * POST or DELETE, a POST's `body` a string of at most `MAX_BODY_BYTES`, sent
 * as `application/json`, `headers` an optional list of `Name: value` lines
 * sent after it, a `Content-Type` among them replacing the JSON one, and
 * `proxy` an optional `<scheme>://<host>:<port>` the fetch goes through, its
 * scheme one of `PROXY_SCHEMES`, which no `no_proxy` variable bypasses. Any
 * other method, a body on a GET or a DELETE, a body over the cap, a header
 * line holding CR or LF, holding no value, naming one of
 * `Vault::FRAMING_HEADERS`, or naming `Authorization` or the credential's own
 * header where the vault lends the origin one, and a proxy of another shape,
 * carrying userinfo, holding CR or LF, or beside a credential on a plain url,
 * answers a TM_ERROR naming the url and never a header's value or the proxy.
 * Both forms share everything below and the in-flight cap.
 *
 * A TM_STRUCT may also name `response_headers`, at most
 * MAX_RESPONSE_HEADERS header names: its success answers a TM_STRUCT copy
 * whose VALUE is `{ body, headers }`, each named header the response sent by
 * its lowercased name, its first value trimmed and cut to
 * `Curl_Transfer::MAX_HEADER_BYTES`. A name that is not a header token, one of
 * `Vault::FRAMING_HEADERS`, `Set-Cookie`, `Authorization`, or the header the
 * vault's credential for the origin rides in is refused, so no answer carries
 * a cookie or a credential.
 *
 * Under a vault group each fetch looks for the group's entry on the url's
 * origin, its scheme, host and port: none fetches with no credential, one
 * sends the header line `Vault::credential_header()` answers for it, and two
 * or more refuse. The credential thus starts on its own origin. A redirect
 * may take the fetch elsewhere only while the credential rides in
 * `Authorization`, which libcurl drops when a redirect changes host, port or
 * scheme. A credential in any other header follows no redirect, and neither
 * does a request carrying header lines of its own, any of which may be a
 * credential, nor a DELETE, whose method libcurl would carry along: a 3xx
 * naming a Location answers a TM_ERROR `redirect not followed: credential in
 * <header> <url>`, `credential in request headers` or `a DELETE`, never a
 * value. A proxy beside either kind of credential is taken only over https.
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
 * @implements Curl_Owner<array{context:array{message:array<int,mixed>,url:string,names:list<string>,guard:string},body:\Closure(): string,headers:\Closure(): array<string,string>}>
 */
class Curl_Node extends Node implements Curl_Owner {
	use Schema_Reflection;

	/** @use Curl_Transfer<array{message:array<int,mixed>,url:string,names:list<string>,guard:string}> */
	use Curl_Transfer;

	/** Transfers in flight at once; a fill past it is turned away as busy. */
	public const MAX_IN_FLIGHT = 16;

	/**
	 * Largest body a request may carry, 64 KiB. An API query or a GraphQL
	 * page request is a few KB; the cap bounds a runaway, not a real request.
	 */
	public const MAX_BODY_BYTES = 65536;

	/** The one credential header libcurl drops on a redirect leaving its origin. */
	private const AUTHORIZATION = 'Authorization:';

	/** A request header line: a header name, a colon, and its value. */
	private const HEADER_LINE = '/^(' . Vault::HEADER_NAME . '):(.*)\z/s';

	/** The methods a request may name; only POST carries a body. */
	private const METHODS = [ 'GET', 'POST', 'DELETE' ];

	/** Response headers one request may name. */
	public const MAX_RESPONSE_HEADERS = 8;

	/** Response headers no request may read: each carries a cookie or a credential. */
	private const SECRET_RESPONSE_HEADERS = [ 'set-cookie', 'authorization' ];

	/** The schemes a request's proxy may name, lowercased, as libcurl reads them. */
	private const PROXY_SCHEMES = [ 'socks5h', 'socks5', 'http', 'https' ];

	/** Redirects followed before libcurl fails the transfer. */
	public const MAX_REDIRECTS = 5;

	/** Transfer timeout for one fetch, in seconds. */
	public const REQUEST_TIMEOUT = 30;

	/** The User-Agent every fetch sends; some hosts refuse a request naming none. */
	public const USER_AGENT = 'newspack-nodes/' . \NEWSPACK_NODES_VERSION;

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
	 * Read the url, or the request, VALUE carries and start its transfer, or
	 * emit a TM_ERROR naming why none starts. Anything but a TM_BYTESTREAM or
	 * a TM_STRUCT is dropped: the output carries fetch responses and fetch
	 * failures, nothing passed through. Outside a running event loop nothing
	 * would ever complete a transfer, so none starts. Past MAX_IN_FLIGHT the
	 * fill is turned away as busy rather than queued.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type = $message[ Message::TYPE ];
		if ( ! \is_int( $type ) || ! ( $type & ( Message::TM_BYTESTREAM | Message::TM_STRUCT ) ) ) {
			$this->drop_message( $message, 'neither a TM_BYTESTREAM url nor a TM_STRUCT request' );
			return;
		}
		$request = $type & Message::TM_STRUCT
			? Core::arr( $message[ Message::VALUE ] )
			: [
				'url'    => $message[ Message::VALUE ],
				'method' => 'GET',
			];
		$url     = \trim( Core::as_string( $request['url'] ?? '' ) );
		try {
			self::origin_of( $url );
			if ( ! Event_Framework::instance()->is_running() ) {
				self::refuse( "no event loop {$url}" );
			}
			$in_flight = $this->transfers_in_flight();
			if ( $in_flight >= self::MAX_IN_FLIGHT ) {
				self::refuse( "busy: {$in_flight} requests in flight {$url}" );
			}
			$credential = $this->credential_for( $url );
			$held       = self::held_header( $credential );
			$method     = self::method_of( $request, $url );
			$body       = self::body_of( $request, $method, $url );
			$lines      = self::headers_of( $request, $url, $held );
			$proxy      = self::proxy_of( $request, $url, self::credential_like( $credential, $lines ) );
			$names      = self::response_headers_of( $request, $url, $held );
		} catch ( \UnexpectedValueException $refusal ) {
			$this->emit( $message, Message::TM_ERROR, $refusal->getMessage() );
			return;
		}
		$this->fetch( $message, $url, $method, $body, $credential, $lines, $proxy, $names );
	}

	/**
	 * The lowercased name of the header the credential line rides in; '' for
	 * no credential.
	 *
	 * @param string $credential The credential header line, or ''.
	 */
	private static function held_header( string $credential ): string {
		return '' === $credential ? '' : \strtolower( \explode( ':', $credential, 2 )[0] );
	}

	/**
	 * The method a request names: one of METHODS, in its own case.
	 *
	 * @param array<array-key,mixed> $request The request.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function method_of( array $request, string $url ): string {
		$method = $request['method'] ?? null;
		if ( ! \in_array( $method, self::METHODS, true ) ) {
			self::refuse( 'invalid method ' . Core::as_string( $method ) . " {$url}" );
		}
		return $method;
	}

	/**
	 * The body a request sends: null for a GET or a DELETE, which send none,
	 * and the string, '' when absent, for a POST.
	 *
	 * @param array<array-key,mixed> $request The request: its url, method and body.
	 * @param string                 $method  Its method, as method_of() read it.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @return string|null
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function body_of( array $request, string $method, string $url ): ?string {
		$body = $request['body'] ?? null;
		if ( 'POST' !== $method ) {
			if ( null !== $body ) {
				self::refuse( "body on a {$method} {$url}" );
			}
			return null;
		}
		if ( null === $body ) {
			return '';
		}
		if ( ! \is_string( $body ) ) {
			self::refuse( "invalid body {$url}" );
		}
		if ( \strlen( $body ) > self::MAX_BODY_BYTES ) {
			self::refuse( 'body over ' . self::MAX_BODY_BYTES . " bytes {$url}" );
		}
		return $body;
	}

	/**
	 * The header lines a request sends beside the credential, each with its
	 * lowercased name: none when it names none. A line with no value is
	 * refused, because libcurl reads it as removing that header.
	 *
	 * @param array<array-key,mixed> $request The request: its url, method, body and headers.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @param string                 $held    The header the vault's credential rides in, lowercased, or ''.
	 * @return list<array{0:string,1:string}> Each line as `[ lowercased name, line ]`.
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function headers_of( array $request, string $url, string $held ): array {
		$lines = $request['headers'] ?? [];
		if ( ! \is_array( $lines ) || ! \array_is_list( $lines ) ) {
			self::refuse( "invalid headers {$url}" );
		}
		$headers = [];
		foreach ( $lines as $line ) {
			if ( ! \is_string( $line ) ) {
				self::refuse( "invalid headers {$url}" );
			}
			if ( false !== \strpbrk( $line, "\r\n" ) ) {
				self::refuse( "header carries CR or LF {$url}" );
			}
			if ( 1 !== \preg_match( self::HEADER_LINE, $line, $match ) ) {
				self::refuse( "invalid headers {$url}" );
			}
			$name = \strtolower( $match[1] );
			if ( \in_array( $name, Vault::FRAMING_HEADERS, true ) ) {
				self::refuse( "refused header {$match[1]} {$url}" );
			}
			if ( '' !== $held && ( 'authorization' === $name || $held === $name ) ) {
				self::refuse( "refused header {$match[1]} beside a vault credential {$url}" );
			}
			if ( '' === \trim( $match[2] ) ) {
				self::refuse( "empty header {$match[1]} {$url}" );
			}
			$headers[] = [ $name, $line ];
		}
		return $headers;
	}

	/**
	 * The proxy a request goes through, or null for none: a bare
	 * `<scheme>://<host>:<port>`, a trailing slash allowed. A request carrying
	 * a credential, the vault's or in its own header lines, takes a proxy only
	 * over https, where the credential rides inside the tunnel's TLS and the
	 * proxy never reads it. Each refusal names the url and never the proxy,
	 * which may carry a credential.
	 *
	 * @param array<array-key,mixed> $request    The request: its url, method, body, headers and proxy.
	 * @param string                 $url        The trimmed url, for the refusal.
	 * @param bool                   $credential Whether the request carries a credential, as credential_like() reads it.
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function proxy_of( array $request, string $url, bool $credential ): ?string {
		$proxy = $request['proxy'] ?? null;
		if ( null === $proxy ) {
			return null;
		}
		if ( $credential && 0 !== \strncasecmp( $url, 'https://', 8 ) ) {
			self::refuse( "refused proxy beside a credential on a plain url {$url}" );
		}
		if ( ! \is_string( $proxy ) ) {
			self::refuse( "invalid proxy {$url}" );
		}
		if ( false !== \strpbrk( $proxy, "\r\n" ) ) {
			self::refuse( "proxy carries CR or LF {$url}" );
		}
		if ( \str_contains( $proxy, '@' ) ) {
			self::refuse( "invalid proxy carrying userinfo {$url}" );
		}
		$parts = \wp_parse_url( $proxy );
		$bare  = \is_array( $parts )
			&& \in_array( \strtolower( Core::as_string( $parts['scheme'] ?? '' ) ), self::PROXY_SCHEMES, true )
			&& '' !== Core::as_string( $parts['host'] ?? '' )
			&& isset( $parts['port'] )
			&& \in_array( $parts['path'] ?? '', [ '', '/' ], true )
			&& ! isset( $parts['query'] ) && ! isset( $parts['fragment'] );
		if ( ! $bare ) {
			self::refuse( "invalid proxy {$url}" );
		}
		return $proxy;
	}

	/**
	 * The response headers a request reads, lowercased: none when it names
	 * none. Each refusal names the header as the request spelled it.
	 *
	 * @param array<array-key,mixed> $request The request.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @param string                 $held    The header the vault's credential rides in, lowercased, or ''.
	 * @return list<string>
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function response_headers_of( array $request, string $url, string $held ): array {
		$names = $request['response_headers'] ?? [];
		if ( ! \is_array( $names ) || ! \array_is_list( $names ) || \count( $names ) > self::MAX_RESPONSE_HEADERS ) {
			self::refuse( "invalid response headers {$url}" );
		}
		$read = [];
		foreach ( $names as $name ) {
			if ( ! \is_string( $name ) || ! Vault::is_header_name( $name ) ) {
				self::refuse( "invalid response headers {$url}" );
			}
			$lower = \strtolower( $name );
			if ( \in_array( $lower, Vault::FRAMING_HEADERS, true ) || \in_array( $lower, self::SECRET_RESPONSE_HEADERS, true ) ) {
				self::refuse( "refused response header {$name} {$url}" );
			}
			if ( $held === $lower ) {
				self::refuse( "refused response header {$name} beside a vault credential {$url}" );
			}
			$read[] = $lower;
		}
		return $read;
	}

	/**
	 * Start the transfer on the shared multi, holding the input message with
	 * the handle, because the output is a copy of it. A dispatch that yields no
	 * handle emits its TM_ERROR at once. A fetch carrying a credential under
	 * `vault_require_ssl` takes https alone, its redirects too, and no
	 * redirect to another host, port or scheme carries the credential.
	 *
	 * @param array<int,mixed>               $message    The input message.
	 * @param string                         $url        The url.
	 * @param string                         $method     GET, POST or DELETE.
	 * @param string|null                    $body       A POST's body, or null for a GET or a DELETE.
	 * @param string                         $credential The credential header line, or ''.
	 * @param list<array{0:string,1:string}> $lines      The request's own header lines, by name.
	 * @param string|null                    $proxy      The proxy the fetch goes through, or null for none.
	 * @param list<string>                   $names      The response headers to read, lowercased.
	 */
	private function fetch( array $message, string $url, string $method, ?string $body, string $credential, array $lines, ?string $proxy, array $names ): void {
		$protocols = '' !== $credential && Vault::require_ssl() ? \CURLPROTO_HTTPS : self::PROTOCOLS;
		$guard   = self::redirect_guard( $method, $credential, $lines );
		$follow  = $this->follow && '' === $guard;
		$verb    = match ( $method ) {
			'POST'   => [
				\CURLOPT_POST       => true,
				\CURLOPT_POSTFIELDS => (string) $body,
			],
			'DELETE' => [
				\CURLOPT_HTTPGET       => true,
				\CURLOPT_CUSTOMREQUEST => 'DELETE',
			],
			default  => [ \CURLOPT_HTTPGET => true ],
		};
		$typed   = \in_array( 'content-type', \array_column( $lines, 0 ), true );
		$headers = null === $body || $typed ? [] : [ 'Content-Type: application/json' ];
		$headers = [ ...$headers, ...\array_column( $lines, 1 ) ];
		if ( '' !== $credential ) {
			$headers[] = $credential;
		}
		$opts = [
			\CURLOPT_URL             => $url,
			\CURLOPT_PROTOCOLS       => $protocols,
			\CURLOPT_REDIR_PROTOCOLS => $protocols,
			\CURLOPT_FOLLOWLOCATION  => $follow,
			\CURLOPT_UNRESTRICTED_AUTH => false,
			\CURLOPT_MAXREDIRS       => self::MAX_REDIRECTS,
			\CURLOPT_TIMEOUT         => self::REQUEST_TIMEOUT,
			\CURLOPT_USERAGENT       => self::USER_AGENT,
		] + $verb + Vault::tls_opts();
		if ( [] !== $headers ) {
			$opts[ \CURLOPT_HTTPHEADER ] = $headers;
		}
		if ( null !== $proxy ) {
			$opts[ \CURLOPT_PROXY ]   = $proxy;
			$opts[ \CURLOPT_NOPROXY ] = '';
		}
		$started = $this->start_transfer(
			$opts,
			[
				'message' => $message,
				'url'     => $url,
				'names'   => $names,
				'guard'   => $guard,
			],
			$names
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
	 * Following them, only the redirect guard leaves a 3xx's Location
	 * unfollowed, and that answers a TM_ERROR naming why, never a value.
	 * A request that named response headers answers its body as a TM_STRUCT
	 * `{ body, headers }`.
	 *
	 * @param int                                                                 $result   The transfer's CURLE_* code.
	 * @param array{code:int,body:string,redirect:string,headers:array<string,string>} $response Its status, body, unfollowed Location and kept headers.
	 * @param array{message:array<int,mixed>,url:string,names:list<string>,guard:string} $request The input message, the url, the response headers it named, and why it followed no redirect.
	 */
	protected function on_transfer_done( int $result, array $response, mixed $request ): void {
		$url = $request['url'];
		if ( \CURLE_OK !== $result ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_strerror
			$reason = Core::as_string( \curl_strerror( $result ) );
			$this->emit( $request['message'], Message::TM_ERROR, "curl error {$result} ({$reason}) {$url}" );
			return;
		}
		$is_3xx = $response['code'] >= 300 && $response['code'] < 400;
		if ( $is_3xx && '' !== $response['redirect'] ) {
			if ( $this->follow ) {
				$this->emit( $request['message'], Message::TM_ERROR, "redirect not followed: {$request['guard']} {$url}" );
				return;
			}
			$this->emit( $request['message'], Message::TM_RESPONSE, $response['redirect'] );
			return;
		}
		if ( ( $is_3xx && ! $this->follow ) || $response['code'] >= 400 ) {
			$this->emit( $request['message'], Message::TM_ERROR, "HTTP {$response['code']} {$url}" );
			return;
		}
		if ( [] !== $request['names'] ) {
			$answer = [
				'body'    => $response['body'],
				'headers' => $response['headers'],
			];
			$this->emit( $request['message'], Message::TM_STRUCT, $answer );
			return;
		}
		$this->emit( $request['message'], Message::TM_BYTESTREAM, $response['body'] );
	}

	/**
	 * Why a fetch follows no redirect, as its TM_ERROR names it, or '' when
	 * it may: a credential that would not stay on its origin, a DELETE, whose
	 * method would follow it to another url.
	 *
	 * @param string                         $method     GET, POST or DELETE.
	 * @param string                         $credential The credential header line, or ''.
	 * @param list<array{0:string,1:string}> $lines      The request's own header lines, by name.
	 */
	private static function redirect_guard( string $method, string $credential, array $lines ): string {
		if ( ! self::stays_on_origin( $credential, $lines ) ) {
			return 'credential in ' . ( [] === $lines ? \explode( ':', $credential, 2 )[0] : 'request headers' );
		}
		return 'DELETE' === $method ? 'a DELETE' : '';
	}

	/**
	 * Whether libcurl keeps every credential a request carries on its origin
	 * across a redirect: none at all, or the vault's alone in `Authorization`,
	 * which it drops when a redirect changes host, port or scheme.
	 *
	 * @param string                         $credential The credential header line, or ''.
	 * @param list<array{0:string,1:string}> $lines      The request's own header lines, by name.
	 */
	private static function stays_on_origin( string $credential, array $lines ): bool {
		return ! self::credential_like( $credential, $lines )
			|| ( [] === $lines && 0 === \strncasecmp( $credential, self::AUTHORIZATION, \strlen( self::AUTHORIZATION ) ) );
	}

	/**
	 * Whether a request carries something that may be a credential: the
	 * vault's line, or any header line of its own.
	 *
	 * @param string                         $credential The credential header line, or ''.
	 * @param list<array{0:string,1:string}> $lines      The request's own header lines, by name.
	 */
	private static function credential_like( string $credential, array $lines ): bool {
		return '' !== $credential || [] !== $lines;
	}

	/**
	 * The credential header line to send with the url ('' for none): the line
	 * of the one vault group entry on the url's origin, under which
	 * `vault_require_ssl` applies to the url.
	 *
	 * @param string $url The trimmed url.
	 * @return string
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private function credential_for( string $url ): string {
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
		return Vault::credential_header( \reset( $matched ) );
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
	 * Forward a copy of the input message with its whole TYPE and its VALUE
	 * replaced; `Node::fill()` stamps TO from `target`.
	 *
	 * @param array<int,mixed>                              $message The input message.
	 * @param int                                           $type    TM_BYTESTREAM, TM_STRUCT, TM_RESPONSE or TM_ERROR.
	 * @param string|array{body:string,headers:array<string,string>} $value The body, the body and its headers, the Location, or the error text.
	 */
	private function emit( array $message, int $type, string|array $value ): void {
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
			'description' => 'Fetch the URL a TM_BYTESTREAM carries (a GET), or run the TM_STRUCT request { url, method GET, POST or DELETE, body as JSON, headers as `Name: value` lines, proxy as `<scheme>://<host>:<port>`, response_headers as names to read back }, without blocking, and emit the body, the TM_STRUCT { body, headers } when response headers were named, or a TM_ERROR naming the url and why.',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'vault_group', 'type' => 'vault_group', 'description' => 'Optional Vault group: a url on one entry\'s origin carries its credential header, and one on two entries\' origin is refused.' ],
			],
			'commands'    => [],
		];
	}
}
