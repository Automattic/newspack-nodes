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
 * is `{ url, method, body, headers, proxy, response_headers, connect_timeout,
 * timeout }`: `method` GET, POST or DELETE, a POST's `body` a string of at
 * most the node's body cap, `DEFAULT_BODY_CAP` until `set_body_cap()` raises
 * it, sent as `application/json`, `headers` an optional list of
 * `Name: value` lines sent after it, a `Content-Type` among them replacing
 * the JSON one, `proxy` an optional `<scheme>://<host>:<port>` the fetch goes
 * through, its scheme one of `PROXY_SCHEMES`, which a `no_proxy` variable
 * never bypasses, `timeout` the optional whole seconds, from 1 to
 * `MAX_REQUEST_TIMEOUT`, the whole request may take, its hops included,
 * `REQUEST_TIMEOUT` when absent, and `connect_timeout` the optional whole
 * seconds, from 1 to that timeout, the connection may take. Any other method, a body on a GET or a DELETE, a body over the
 * cap, a header line holding CR or LF, holding no value, naming one of
 * `Vault::FRAMING_HEADERS`, or naming `Authorization` or the credential's own
 * header where the vault lends the origin one, a proxy of another shape,
 * carrying userinfo, holding CR or LF, or beside a credential on a plain url,
 * and a connect timeout or a timeout of another kind, answers a TM_ERROR naming the url
 * and never a header's value or the proxy.
 * Both forms share everything below and the in-flight cap.
 *
 * A TM_STRUCT may also name `response_headers`, at most
 * MAX_RESPONSE_HEADERS header names: its success answers a TM_STRUCT copy
 * whose VALUE is `{ body, headers }`, each named header the response sent by
 * its lowercased name, its first value trimmed and cut to
 * `Curl_Transfer::MAX_HEADER_BYTES`. A name that is not a header token, one of
 * `Vault::FRAMING_HEADERS`, `Set-Cookie`, `Authorization`, or the header the
 * vault's credential for the origin rides in is refused, so an answer never
 * carries a cookie or a credential.
 *
 * Under a vault group each fetch looks for the group's entry on the url's
 * origin, its scheme, host and port: with none it fetches without a
 * credential, with one it sends the header line `Vault::credential_header()`
 * answers for it, and with two or more it refuses. The credential thus starts
 * on its own origin. A redirect may take the fetch elsewhere only while the
 * credential rides in `Authorization`, which libcurl drops when a redirect
 * changes host, port or scheme. A credential in any other header follows no
 * redirect, and neither does a request carrying header lines of its own, any of
 * which may be a credential, nor a DELETE, whose method libcurl would carry
 * along: a 3xx naming a Location answers a TM_ERROR
 * `redirect not followed: credential in <header> <url>`,
 * `credential in request headers` or `a DELETE`, never a value. A proxy beside
 * either kind of credential is taken only over https.
 *
 * With `follow_redirects( false )` a fetch follows no redirect: a 3xx naming
 * a Location answers a TM_RESPONSE copy whose VALUE is that absolute url, and
 * a 3xx naming none answers a TM_ERROR as a status of 400 or more does.
 *
 * A TM_STRUCT whose url a response chose names `public_only` true and
 * reaches public addresses alone, without a proxy: public_of() judges the
 * host, a check before sending (PHP 8.4) or a pinned lookup judges the
 * address it connects to, and the node follows each redirect itself under
 * the same guard.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Curl node — `make_node Curl <name> [vault_group]`.
 *
 * @phpstan-type Fetch array{message:array<int,mixed>,request:array<array-key,mixed>,hops:int,home:string,public:bool,prereq:bool,pin:list<string>,deadline:int,connect:int|null,left:int,url:string,names:list<string>,guard:string,refused:\Closure(): bool}
 * @implements Curl_Owner<array{context:Fetch,body:\Closure(): string,headers:\Closure(): array<string,string>}>
 */
class Curl_Node extends Node implements Curl_Owner {
	use Schema_Reflection;

	/** @use Curl_Transfer<Fetch> */
	use Curl_Transfer;

	/** Transfers in flight at once; a fill past it is turned away as busy. */
	public const MAX_IN_FLIGHT = 16;

	/**
	 * Largest body a request may carry until `set_body_cap()` raises it,
	 * 64 KiB. An API query or a GraphQL page request is a few KB; the cap
	 * bounds a runaway, not a real request.
	 */
	public const DEFAULT_BODY_CAP = 65536;

	/**
	 * The highest cap `set_body_cap()` takes, 1 MiB. The largest real body is
	 * a model request carrying a 65,536-byte item body JSON-encoded twice,
	 * about 460 KB. A node at the cap holds MAX_IN_FLIGHT bodies, each in PHP
	 * and again in libcurl's copy, 32 MiB, beside its reply buffers.
	 */
	private const MAX_BODY_CAP = 1048576;

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

	/** Redirects followed before libcurl, or the node for a public-only request, fails the transfer. */
	public const MAX_REDIRECTS = 5;

	/** The statuses whose redirect turns a POST into a GET, as libcurl turns it. */
	private const REDIRECTS_TO_GET = [ 301, 302, 303 ];

	/** The first 96 bits of `64:ff9b::/96`, the well-known NAT64 prefix (RFC 6052). */
	private const NAT64_PREFIX = "\x00\x64\xff\x9b\x00\x00\x00\x00\x00\x00\x00\x00";

	/** The first 48 bits of `64:ff9b:1::/48`, the local-use NAT64 prefix (RFC 8215). */
	private const NAT64_LOCAL_PREFIX = "\x00\x64\xff\x9b\x00\x01";

	/** Transfer timeout for one fetch whose request names no `timeout`, in seconds. */
	public const REQUEST_TIMEOUT = 30;

	/** The longest `timeout` a request may name, in seconds. */
	public const MAX_REQUEST_TIMEOUT = 120;

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

	/**
	 * Name-lookup seam for a public-only request on a PHP without
	 * `CURLOPT_PREREQFUNCTION`: the addresses its host resolves to, every one
	 * checked before the transfer starts and the first pinned to it. Null asks
	 * DNS for A and AAAA records (`dns_get_record()`). Tests reassign it to
	 * answer a host without DNS.
	 *
	 * Signature: `function ( string $host ): list<string>`, empty for none.
	 *
	 * @var (\Closure(string): list<string>)|null
	 */
	public static ?\Closure $resolve = null;

	/**
	 * Seam for whether libcurl can check a connection before sending: null
	 * reads `defined( 'CURLOPT_PREREQFUNCTION' )`, true from PHP 8.4. Tests
	 * reassign it to run the lookup-and-pin path PHP 8.2 and 8.3 take.
	 *
	 * Signature: `function (): bool`.
	 *
	 * @var (\Closure(): bool)|null
	 */
	public static ?\Closure $prereq_available = null;

	/** Vault group whose entries lend each fetch on their origin a credential; '' for none. */
	protected string $vault_group = '';

	/** Whether a fetch follows redirects; `follow_redirects()` sets it. */
	private bool $follow = true;

	/** Bytes a POST request's body may carry; `set_body_cap()` raises it. */
	private int $body_cap = self::DEFAULT_BODY_CAP;

	/**
	 * Start the transfer of the url or request VALUE carries inside a running
	 * event loop and below MAX_IN_FLIGHT, else answer a TM_ERROR naming why;
	 * anything but a TM_BYTESTREAM or a TM_STRUCT is dropped.
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
		$this->start( $message, $request, null );
	}

	/**
	 * Emit the completed fetch as a copy of its input message: its body, a
	 * redirect as the file docblock describes, or a TM_ERROR naming a refused
	 * address, a curl error or a status of 400 or more.
	 *
	 * @param int                                                                 $result   The transfer's CURLE_* code.
	 * @param array{code:int,body:string,redirect:string,ip:string,headers:array<string,string>} $response Its status, body, unfollowed Location, connected address and kept headers.
	 * @param Fetch                                                               $request  The input message, the request, its hops, whether it is public-only, the url, the response headers it named, and why it followed no redirect.
	 */
	protected function on_transfer_done( int $result, array $response, mixed $request ): void {
		$url = $request['url'];
		if ( ( $request['refused'] )() ) {
			$this->emit( $request['message'], Message::TM_ERROR, "refused private address {$url}" );
			return;
		}
		if ( \CURLE_OK !== $result ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_strerror
			$reason = Core::as_string( \curl_strerror( $result ) );
			$this->emit( $request['message'], Message::TM_ERROR, "curl error {$result} ({$reason}) {$url}" );
			return;
		}
		if ( $request['public'] && ! self::is_public_address( $response['ip'] ) ) {
			$this->emit( $request['message'], Message::TM_ERROR, "refused private address {$url}" );
			return;
		}
		$is_3xx = $response['code'] >= 300 && $response['code'] < 400;
		if ( $is_3xx && '' !== $response['redirect'] ) {
			if ( $this->follow && $request['public'] && '' === $request['guard'] ) {
				$this->hop( $request, $response['code'], $response['redirect'] );
				return;
			}
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
	 * Fetch a public-only request's Location as its next hop, held to the same
	 * guard, or answer a TM_ERROR once MAX_REDIRECTS hops are spent. A 301,
	 * 302 or 303 sends a POST on as a GET with no body.
	 *
	 * @param Fetch  $request  The hop that answered the redirect.
	 * @param int    $code     Its status.
	 * @param string $location The absolute Location.
	 */
	private function hop( array $request, int $code, string $location ): void {
		if ( $request['hops'] >= self::MAX_REDIRECTS ) {
			$this->emit( $request['message'], Message::TM_ERROR, 'redirects past ' . self::MAX_REDIRECTS . " {$request['url']}" );
			return;
		}
		$next = [ 'url' => $location ] + $request['request'];
		if ( 'POST' === ( $next['method'] ?? null ) && \in_array( $code, self::REDIRECTS_TO_GET, true ) ) {
			$next['method'] = 'GET';
			unset( $next['body'] );
		}
		$this->start( $request['message'], $next, $request );
	}

	/**
	 * Start one request's transfer, the first or a public-only request's next
	 * hop, or emit a TM_ERROR copy of `$message` naming why none starts. The
	 * first validates the timeouts and sets the deadline, which each hop takes
	 * from the one before it; every transfer gets the milliseconds left by a
	 * fresh clock read, taken again after a blocking lookup, which is charged.
	 *
	 * @param array<int,mixed>       $message The input message, which the answer copies.
	 * @param array<array-key,mixed> $request The request: its url, method and the rest.
	 * @param Fetch|null             $prior   The hop that answered this one's redirect; null for the first.
	 */
	private function start( array $message, array $request, ?array $prior ): void {
		$url = \trim( Core::as_string( $request['url'] ?? '' ) );
		try {
			$origin = self::origin_of( $url );
			$home   = $prior['home'] ?? $origin;
			$named  = \strtolower( Core::as_string( \wp_parse_url( $url, \PHP_URL_HOST ) ) );
			$public = self::public_of( $request, $url, \rtrim( $named, '.' ) );
			if ( ! Event_Framework::instance()->is_running() ) {
				self::refuse( "no event loop {$url}" );
			}
			$in_flight = $this->transfers_in_flight();
			if ( $in_flight >= self::MAX_IN_FLIGHT ) {
				self::refuse( "busy: {$in_flight} requests in flight {$url}" );
			}
			// Off the first origin a hop carries no credential, as in libcurl.
			$credential = $home === $origin ? $this->credential_for( $url ) : '';
			$held       = self::held_header( $credential );
			$method     = self::method_of( $request, $url );
			$body       = self::body_of( $request, $method, $url, $this->body_cap );
			$lines      = self::headers_of( $request, $url, $held );
			$proxy      = self::proxy_of( $request, $url, self::credential_like( $credential, $lines ) );
			$names      = self::response_headers_of( $request, $url, $held );
			$now        = self::now_ms();
			if ( null === $prior ) {
				$timeout  = self::seconds_of( $request, 'timeout', 'invalid timeout', self::MAX_REQUEST_TIMEOUT, $url ) ?? self::REQUEST_TIMEOUT;
				$connect  = self::seconds_of( $request, 'connect_timeout', 'invalid connect timeout', $timeout, $url );
				$deadline = $now + $timeout * 1000;
			} else {
				$connect  = $prior['connect'];
				$deadline = $prior['deadline'];
			}
			$prereq = $public && ( self::$prereq_available ?? static fn (): bool => \defined( 'CURLOPT_PREREQFUNCTION' ) )();
			$pin    = $public && ! $prereq ? self::pin_of( $url, $named ) : [];
			if ( [] !== $pin ) {
				$now = self::now_ms();
			}
			$left = $deadline - $now;
			if ( $left < 1 ) {
				self::refuse( "timed out {$url}" );
			}
		} catch ( \UnexpectedValueException $refusal ) {
			$this->emit( $message, Message::TM_ERROR, $refusal->getMessage() );
			return;
		}
		$context = [
			'message'  => $message,
			'request'  => $request,
			'hops'     => null === $prior ? 0 : $prior['hops'] + 1,
			'home'     => $home,
			'public'   => $public,
			'prereq'   => $prereq,
			'pin'      => $pin,
			'deadline' => $deadline,
			'connect'  => $connect,
			'left'     => $left,
		];
		$this->fetch( $context, $url, $method, $body, $credential, $lines, $proxy, $names );
	}

	/**
	 * Whether a request names `public_only`, refusing one whose host is an
	 * address outside the global ranges, a single label or a numeric form, or
	 * that names a proxy: every check that needs no lookup.
	 *
	 * @param array<array-key,mixed> $request The request.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @param string                 $host    Its host, lowercased, with no trailing dot.
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function public_of( array $request, string $url, string $host ): bool {
		$public = $request['public_only'] ?? false;
		if ( ! \is_bool( $public ) ) {
			self::refuse( "invalid public_only {$url}" );
		}
		if ( ! $public ) {
			return false;
		}
		if ( null !== ( $request['proxy'] ?? null ) ) {
			self::refuse( "refused proxy on a public-only request {$url}" );
		}
		$address = \trim( $host, '[]' );
		if ( false !== \filter_var( $address, \FILTER_VALIDATE_IP ) ) {
			if ( ! self::is_public_address( $address ) ) {
				self::refuse( "refused private address {$url}" );
			}
			return true;
		}
		if ( ! \str_contains( $host, '.' ) ) {
			self::refuse( "refused single-label host {$url}" );
		}
		// A numeric last label is an address form libcurl's resolver reads.
		if ( 1 === \preg_match( '/\.(?:0x[0-9a-f]*|[0-9]+)$/', $host ) ) {
			self::refuse( "refused numeric host {$url}" );
		}
		return true;
	}

	/**
	 * The `+host:port:address` `CURLOPT_RESOLVE` entries pinning a public-only
	 * name, under both spellings of a rooted one, to the address it was
	 * checked at, refusing one resolving to nothing or to any address that is
	 * not public; none for an address literal. This path blocks the loop on
	 * its lookup; the PREREQFUNCTION path, from PHP 8.4, does not.
	 *
	 * @param string $url   The trimmed url of a request public_of() passed.
	 * @param string $named Its host, lowercased, as the url spells it.
	 * @return list<string> `+host:port:address` lines.
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function pin_of( string $url, string $named ): array {
		$host = \rtrim( $named, '.' );
		if ( false !== \filter_var( \trim( $host, '[]' ), \FILTER_VALIDATE_IP ) ) {
			return [];
		}
		$addresses = ( self::$resolve ?? self::lookup( ... ) )( $host );
		if ( [] === $addresses ) {
			self::refuse( "unresolved host {$url}" );
		}
		foreach ( $addresses as $resolved ) {
			if ( ! self::is_public_address( $resolved ) ) {
				self::refuse( "refused private address {$url}" );
			}
		}
		$scheme = \strtolower( Core::as_string( \wp_parse_url( $url, \PHP_URL_SCHEME ) ) );
		$port   = \wp_parse_url( $url, \PHP_URL_PORT ) ?? self::DEFAULT_PORTS[ $scheme ];
		$pinned = false === \filter_var( $addresses[0], \FILTER_VALIDATE_IP, \FILTER_FLAG_IPV6 ) ? $addresses[0] : "[{$addresses[0]}]";
		return \array_map( static fn ( string $name ): string => "+{$name}:{$port}:{$pinned}", \array_values( \array_unique( [ $named, $host ] ) ) );
	}

	/**
	 * A host's A and AAAA addresses, as DNS answers them; none when it answers
	 * nothing.
	 *
	 * @param string $host The host name.
	 * @return list<string>
	 */
	private static function lookup( string $host ): array {
		$addresses = [];
		foreach ( \dns_get_record( $host, \DNS_A | \DNS_AAAA ) ?: [] as $record ) {
			$addresses[] = Core::as_string( $record['ip'] ?? $record['ipv6'] ?? '' );
		}
		return $addresses;
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
	 * @param int                    $cap     The node's body cap, in bytes.
	 * @return string|null
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function body_of( array $request, string $method, string $url, int $cap ): ?string {
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
		if ( \strlen( $body ) > $cap ) {
			self::refuse( "body over {$cap} bytes {$url}" );
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
	 * The whole seconds a request names under `$key`, from 1 to `$max`, or
	 * null when it names none.
	 *
	 * @param array<array-key,mixed> $request The request.
	 * @param string                 $key     `timeout` or `connect_timeout`.
	 * @param string                 $refusal The refusal's text, before the url.
	 * @param int                    $max     The most it may name.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function seconds_of( array $request, string $key, string $refusal, int $max, string $url ): ?int {
		$seconds = $request[ $key ] ?? null;
		if ( null !== $seconds && ( ! \is_int( $seconds ) || $seconds < 1 || $seconds > $max ) ) {
			self::refuse( "{$refusal} {$url}" );
		}
		return $seconds;
	}

	/**
	 * Start the transfer on the shared multi, holding the input message with
	 * the handle, because the output is a copy of it. A dispatch that yields no
	 * handle emits its TM_ERROR at once. A fetch carrying a credential under
	 * `vault_require_ssl` takes https alone, its redirects too, and a
	 * redirect to another host, port or scheme never carries the credential.
	 *
	 * @param array{message:array<int,mixed>,request:array<array-key,mixed>,hops:int,home:string,public:bool,prereq:bool,pin:list<string>,deadline:int,connect:int|null,left:int} $context The input message, the request, its hops so far, the first url's origin, whether it is public-only, whether libcurl checks its connection before sending, the address its host is pinned to, when the whole request times out in epoch ms, the seconds its connection may take, null for no bound but that, and the milliseconds this transfer may take.
	 * @param string                         $url        The url.
	 * @param string                         $method     GET, POST or DELETE.
	 * @param string|null                    $body       A POST's body, or null for a GET or a DELETE.
	 * @param string                         $credential The credential header line, or ''.
	 * @param list<array{0:string,1:string}> $lines      The request's own header lines, by name.
	 * @param string|null                    $proxy      The proxy the fetch goes through, or null for none.
	 * @param list<string>                   $names      The response headers to read, lowercased.
	 */
	private function fetch( array $context, string $url, string $method, ?string $body, string $credential, array $lines, ?string $proxy, array $names ): void {
		$protocols = '' !== $credential && Vault::require_ssl() ? \CURLPROTO_HTTPS : self::PROTOCOLS;
		$guard     = self::redirect_guard( $method, $credential, $lines );
		$follow    = $this->follow && '' === $guard && ! $context['public'];
		$verb      = match ( $method ) {
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
		$typed     = \in_array( 'content-type', \array_column( $lines, 0 ), true );
		$headers   = null === $body || $typed ? [] : [ 'Content-Type: application/json' ];
		$headers   = [ ...$headers, ...\array_column( $lines, 1 ) ];
		if ( '' !== $credential ) {
			$headers[] = $credential;
		}
		$opts = [
			\CURLOPT_URL               => $url,
			\CURLOPT_PROTOCOLS         => $protocols,
			\CURLOPT_REDIR_PROTOCOLS   => $protocols,
			\CURLOPT_FOLLOWLOCATION    => $follow,
			\CURLOPT_UNRESTRICTED_AUTH => false,
			\CURLOPT_MAXREDIRS         => self::MAX_REDIRECTS,
			\CURLOPT_TIMEOUT_MS        => $context['left'],
			\CURLOPT_USERAGENT         => self::USER_AGENT,
		] + $verb + Vault::tls_opts();
		if ( [] !== $headers ) {
			$opts[ \CURLOPT_HTTPHEADER ] = $headers;
		}
		if ( null !== $proxy ) {
			$opts[ \CURLOPT_PROXY ]   = $proxy;
			$opts[ \CURLOPT_NOPROXY ] = '';
		}
		if ( null !== $context['connect'] ) {
			$opts[ \CURLOPT_CONNECTTIMEOUT ] = $context['connect'];
		}
		if ( $context['public'] ) {
			$opts[ \CURLOPT_PROXY ] = '';
		}
		if ( [] !== $context['pin'] ) {
			$opts[ \CURLOPT_RESOLVE ]       = $context['pin'];
			$opts[ \CURLOPT_FRESH_CONNECT ] = true;
		}
		$refused = false;
		if ( $context['prereq'] ) {
			$opts[ \CURLOPT_PREREQFUNCTION ] = static function ( \CurlHandle $easy, string $connected ) use ( &$refused ): int {
				$refused = $refused || ! self::is_public_address( $connected );
				return $refused ? \CURL_PREREQFUNC_ABORT : \CURL_PREREQFUNC_OK;
			};
		}
		$started = $this->start_transfer(
			$opts,
			$context + [
				'url'     => $url,
				'names'   => $names,
				'guard'   => $guard,
				'refused' => static function () use ( &$refused ): bool {
					return $refused;
				},
			],
			$names
		);
		if ( ! $started ) {
			$this->emit( $context['message'], Message::TM_ERROR, "curl_init failed {$url}" );
		}
	}

	/**
	 * The live clock in whole milliseconds, the unit a request's deadline is
	 * kept in. A hop starts from a completion, before the tick re-pins
	 * `Core::$now`, and a lookup blocks, so the cached tick would be stale.
	 */
	private static function now_ms(): int {
		return (int) \round( Core::live_now() * 1000 );
	}

	/**
	 * Whether an address lies in a global range, as RFC 6890 marks them:
	 * never private, loopback, link-local, shared or reserved, an IPv4-mapped
	 * form included. An address in the well-known NAT64 prefix is judged by the
	 * IPv4 address it carries; the local-use NAT64 prefix and the deprecated
	 * site-local range, which the filter passes, are not global.
	 *
	 * @param string $address An IPv4 or IPv6 address; anything else is not public.
	 */
	private static function is_public_address( string $address ): bool {
		if ( false === \filter_var( $address, \FILTER_VALIDATE_IP, \FILTER_FLAG_GLOBAL_RANGE ) ) {
			return false;
		}
		$packed = Core::as_string( \inet_pton( $address ) );
		if ( 16 !== \strlen( $packed ) ) {
			return true;
		}
		if ( \str_starts_with( $packed, self::NAT64_PREFIX ) ) {
			return self::is_public_address( Core::as_string( \inet_ntop( \substr( $packed, 12 ) ) ) );
		}
		$site_local = "\xfe" === $packed[0] && 0xc0 === ( \ord( $packed[1] ) & 0xc0 );
		return ! $site_local && ! \str_starts_with( $packed, self::NAT64_LOCAL_PREFIX );
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
	 * Whether a vault group holds an entry on the url's origin, so a fetch
	 * of it under the group would carry, or be refused for, a credential.
	 * Two entries on one origin answer true; the fetch itself refuses them.
	 * A fact of the group and the Vault, asked with no node built.
	 *
	 * @api Source_Node and Intelligence_Health (newspack-intelligence)
	 *
	 * @param string $group The vault group; '' for none.
	 * @param string $url   The url to fetch.
	 * @return bool
	 * @throws \UnexpectedValueException When it is not an absolute http(s) url with a host, or carries userinfo.
	 */
	public static function lends_credential( string $group, string $url ): bool {
		return [] !== self::entries_on( $group, self::origin_of( \trim( $url ) ) );
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
		$matched = self::entries_on( $this->vault_group, $origin );
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
	 * A vault group's entries whose stored url sits on the origin, by id.
	 *
	 * @param string $group  The vault group.
	 * @param string $origin The origin, as `origin_of()` answers it.
	 * @return array<string,array<string,mixed>>
	 */
	private static function entries_on( string $group, string $origin ): array {
		$vault   = Vault::get_instance();
		$matched = [];
		foreach ( $vault->in_group( $group ) as $id ) {
			$server = $vault->get( $id );
			if ( null !== $server && $origin === self::origin_or_null( Vault::url_of( $server ) ) ) {
				$matched[ $id ] = $server;
			}
		}
		return $matched;
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
	 * A count of transfers a node keeps in flight, refused outside 1 to
	 * MAX_IN_FLIGHT.
	 *
	 * @api Crawler_Node, and newspack-intelligence's feed.
	 * @throws \InvalidArgumentException Naming the count, outside the range.
	 */
	public static function concurrency_of( int $count ): int {
		if ( $count < 1 || $count > self::MAX_IN_FLIGHT ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text for a log or CLI; an int cannot carry markup.
			throw new \InvalidArgumentException( 'concurrency wants a whole number from 1 to ' . self::MAX_IN_FLIGHT . ", got '{$count}'" );
		}
		return $count;
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
	 * Raise the largest body a POST request to this node may carry.
	 *
	 * @api newspack-intelligence's LLM_Call, on the Curl it builds.
	 * @param int $bytes From DEFAULT_BODY_CAP to MAX_BODY_CAP.
	 * @throws \InvalidArgumentException Naming the count, outside the range.
	 */
	public function set_body_cap( int $bytes ): void {
		if ( $bytes < self::DEFAULT_BODY_CAP || $bytes > self::MAX_BODY_CAP ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text for a log or CLI; an int cannot carry markup.
			throw new \InvalidArgumentException( 'body cap wants a whole number from ' . self::DEFAULT_BODY_CAP . ' to ' . self::MAX_BODY_CAP . ", got '{$bytes}'" );
		}
		$this->body_cap = $bytes;
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
			'description' => 'Fetch the URL a TM_BYTESTREAM carries (a GET), or run the TM_STRUCT request { url, method GET, POST or DELETE, body as JSON, headers as `Name: value` lines, proxy as `<scheme>://<host>:<port>`, response_headers as names to read back, timeout and connect_timeout as whole seconds, public_only true for a url a response chose }, without blocking, and emit the body, the TM_STRUCT { body, headers } when response headers were named, or a TM_ERROR naming the url and why.',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'vault_group', 'type' => 'vault_group', 'description' => 'Optional Vault group: a url on one entry\'s origin carries its credential header, and one on two entries\' origin is refused.' ],
			],
			'commands'    => [],
		];
	}
}
