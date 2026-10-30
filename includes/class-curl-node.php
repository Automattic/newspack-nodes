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
 * is `{ url, method, body }`: `method` GET or POST, and a POST's `body` a
 * string of at most `MAX_BODY_BYTES`, sent as `application/json`. Any other
 * method, a body on a GET, or a body over the cap answers a TM_ERROR naming
 * the url. Both forms share everything below and the in-flight cap.
 *
 * Under a vault group each fetch looks for the group's entry on the url's
 * origin, its scheme, host and port: none fetches with no credential, one
 * sends the header line `Vault::credential_header()` answers for it, and two
 * or more refuse. The credential thus starts on its own origin. A redirect
 * may take the fetch elsewhere only while the credential rides in
 * `Authorization`, which libcurl drops when a redirect changes host, port or
 * scheme. A credential in any other header follows no redirect, and a 3xx
 * naming a Location answers a TM_ERROR `redirect not followed: credential in
 * <header> <url>`, naming the header and never its value.
 *
 * With `follow_redirects( false )` a fetch follows no redirect: a 3xx naming
 * a Location answers a TM_RESPONSE copy whose VALUE is that absolute url, and
 * a 3xx naming none answers a TM_ERROR as a status of 400 or more does.
 *
 * Unless `curl_allow_private_addresses` is set, libcurl's pre-request
 * callback checks the address each request actually connected to, every
 * redirect hop included, so the address judged is the one libcurl reached,
 * never one a separate lookup resolved. A private or reserved address aborts
 * the transfer, which answers a TM_ERROR `private address refused: <ip>
 * <url>`. Through a proxy, which libcurl takes from the proxy environment
 * variables, the check judges the proxy's address, not the target's. Where
 * PHP lacks that callback (before 8.4), every fetch answers a TM_ERROR
 * saying so rather than fetching unchecked.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Curl node — `make_node Curl <name> [vault_group]`.
 *
 * @implements Curl_Owner<array{context:array{message:array<int,mixed>,url:string,refused:string},body:\Closure(): string}>
 */
class Curl_Node extends Node implements Curl_Owner {
	use Schema_Reflection;

	/** @use Curl_Transfer<array{message:array<int,mixed>,url:string,refused:string}> */
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

	/** Redirects followed before libcurl fails the transfer. */
	public const MAX_REDIRECTS = 5;

	/** Transfer timeout for one fetch, in seconds. */
	public const REQUEST_TIMEOUT = 30;

	/** The User-Agent every fetch sends; some hosts refuse a request naming none. */
	public const USER_AGENT = 'newspack-nodes/' . \NEWSPACK_NODES_VERSION;

	/**
	 * IPv6 prefixes carrying an IPv4 address, each with the byte the IPv4
	 * starts at: IPv4-mapped, NAT64 and 6to4. Such an address is judged by
	 * the IPv4 it carries.
	 */
	private const IPV4_EMBEDDINGS = [
		'::ffff:0:0/96' => 12,
		'64:ff9b::/96'  => 12,
		'2002::/16'     => 2,
	];

	/**
	 * Ranges refused beside those `filter_var()`'s private and reserved flags
	 * refuse, which on PHP 8.4 leave these passing. `::/96` is IPv4-compatible
	 * and `::ffff:0:0:0/96` IPv4-translated, both refused whatever they carry.
	 */
	private const REFUSED_RANGES = [
		'100.64.0.0/10',
		'192.0.0.0/24',
		'192.0.2.0/24',
		'192.88.99.0/24',
		'198.18.0.0/15',
		'198.51.100.0/24',
		'203.0.113.0/24',
		'224.0.0.0/4',
		'::/96',
		'::ffff:0:0:0/96',
		'100::/64',
		'2001::/23',
		'2001:db8::/32',
		'fec0::/10',
		'64:ff9b:1::/48',
		'ff00::/8',
	];

	/**
	 * `IPV4_EMBEDDINGS` and `REFUSED_RANGES` packed, built on first use and
	 * kept for the process: each embedding as network, prefix bits and IPv4
	 * offset, each range as network and prefix bits.
	 *
	 * @var array{0:list<array{0:string,1:int,2:int}>,1:list<array{0:string,1:int}>}|null
	 */
	private static ?array $networks = null;

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
	 * Pre-request-callback availability seam, replacing
	 * `\defined( 'CURLOPT_PREREQFUNCTION' )`, which PHP 8.4 adds. Tests
	 * reassign it to `fn () => false` to reach the refusal an older PHP
	 * answers, without running one.
	 * Signature: `function (): bool`
	 *
	 * @var (\Closure(): bool)|null
	 */
	public static ?\Closure $prereq_available = null;

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
			$checked    = self::checks_address( $url );
			$credential = $this->credential_for( $url );
			$body       = self::body_of( $request, $url );
		} catch ( \UnexpectedValueException $refusal ) {
			$this->emit( $message, Message::TM_ERROR, $refusal->getMessage() );
			return;
		}
		$this->fetch( $message, $url, $body, $credential, $checked );
	}

	/**
	 * Whether a fetch checks the address it connects to: always, unless
	 * `curl_allow_private_addresses` is set.
	 *
	 * @param string $url The trimmed url, for the refusal.
	 * @throws \UnexpectedValueException When it must check and PHP has no pre-request callback.
	 */
	private static function checks_address( string $url ): bool {
		if ( Config::bool( 'curl_allow_private_addresses' ) ) {
			return false;
		}
		$available = self::$prereq_available ?? static fn (): bool => \defined( 'CURLOPT_PREREQFUNCTION' );
		if ( ! $available() ) {
			self::refuse( "curl_allow_private_addresses is off and refusing a private address needs PHP 8.4 {$url}" );
		}
		return true;
	}

	/**
	 * The body a request sends: null for a GET, which sends none, and the
	 * string, '' when absent, for a POST.
	 *
	 * @param array<array-key,mixed> $request The request: its url, method and body.
	 * @param string                 $url     The trimmed url, for the refusal.
	 * @return string|null
	 * @throws \UnexpectedValueException Naming the refusal, as the TM_ERROR carries it.
	 */
	private static function body_of( array $request, string $url ): ?string {
		$method = $request['method'] ?? null;
		$body   = $request['body'] ?? null;
		if ( 'GET' === $method ) {
			if ( null !== $body ) {
				self::refuse( "body on a GET {$url}" );
			}
			return null;
		}
		if ( 'POST' !== $method ) {
			self::refuse( 'invalid method ' . Core::as_string( $method ) . " {$url}" );
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
	 * Start the transfer on the shared multi, holding the input message with
	 * the handle, because the output is a copy of it. A dispatch that yields no
	 * handle emits its TM_ERROR at once. A fetch carrying a credential under
	 * `vault_require_ssl` takes https alone, its redirects too, and no
	 * redirect to another host, port or scheme carries the credential. A
	 * checked fetch records the address its pre-request callback refused in
	 * the transfer's own context, where the completion reads it.
	 *
	 * @param array<int,mixed> $message    The input message.
	 * @param string           $url        The url.
	 * @param string|null      $body       A POST's body, or null for a GET.
	 * @param string           $credential The credential header line, or ''.
	 * @param bool             $checked    Whether to refuse a private address.
	 */
	private function fetch( array $message, string $url, ?string $body, string $credential, bool $checked ): void {
		$protocols = '' !== $credential && Vault::require_ssl() ? \CURLPROTO_HTTPS : self::PROTOCOLS;
		$follow  = $this->follow && self::stays_on_origin( $credential );
		$method  = null === $body
			? [ \CURLOPT_HTTPGET => true ]
			: [
				\CURLOPT_POST       => true,
				\CURLOPT_POSTFIELDS => $body,
			];
		$headers = null === $body ? [] : [ 'Content-Type: application/json' ];
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
		] + $method + Vault::tls_opts();
		if ( [] !== $headers ) {
			$opts[ \CURLOPT_HTTPHEADER ] = $headers;
		}
		$refused = '';
		if ( $checked ) {
			$opts[ \CURLOPT_PREREQFUNCTION ] = static function ( \CurlHandle $ch, string $primary_ip ) use ( &$refused ): int {
				if ( self::is_public_address( $primary_ip ) ) {
					return \CURL_PREREQFUNC_OK;
				}
				$refused = $primary_ip;
				return \CURL_PREREQFUNC_ABORT;
			};
		}
		$started = $this->start_transfer(
			$opts,
			[
				'message' => $message,
				'url'     => $url,
				'refused' => &$refused,
			]
		);
		if ( ! $started ) {
			$this->emit( $message, Message::TM_ERROR, "curl_init failed {$url}" );
		}
	}

	/**
	 * Emit the completed fetch as a copy of its input message: the body below
	 * status 400, a TM_ERROR naming the status at or above it, a TM_ERROR
	 * naming the address the pre-request callback refused, and a TM_ERROR
	 * naming the curl error when the transfer failed otherwise — a timeout, a
	 * refused connection, or the body cap's short write. Following no redirects, a
	 * 3xx answers its Location as a TM_RESPONSE, or with none, a TM_ERROR.
	 * Following them, only the credential guard leaves a 3xx's Location
	 * unfollowed, and that answers a TM_ERROR naming the credential's header.
	 *
	 * @param int                                         $result   The transfer's CURLE_* code.
	 * @param array{code:int,body:string,redirect:string} $response Its status, body and unfollowed Location.
	 * @param array{message:array<int,mixed>,url:string,refused:string} $request The input message, the url and the refused address.
	 */
	protected function on_transfer_done( int $result, array $response, mixed $request ): void {
		$url = $request['url'];
		if ( \CURLE_OK !== $result ) {
			$refused = $request['refused'];
			if ( '' !== $refused ) {
				$this->emit( $request['message'], Message::TM_ERROR, "private address refused: {$refused} {$url}" );
				return;
			}
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_strerror
			$reason = Core::as_string( \curl_strerror( $result ) );
			$this->emit( $request['message'], Message::TM_ERROR, "curl error {$result} ({$reason}) {$url}" );
			return;
		}
		$is_3xx = $response['code'] >= 300 && $response['code'] < 400;
		if ( $is_3xx && '' !== $response['redirect'] ) {
			if ( $this->follow ) {
				$this->emit( $request['message'], Message::TM_ERROR, 'redirect not followed: credential in ' . $this->credential_name( $url ) . " {$url}" );
				return;
			}
			$this->emit( $request['message'], Message::TM_RESPONSE, $response['redirect'] );
			return;
		}
		if ( ( $is_3xx && ! $this->follow ) || $response['code'] >= 400 ) {
			$this->emit( $request['message'], Message::TM_ERROR, "HTTP {$response['code']} {$url}" );
			return;
		}
		$this->emit( $request['message'], Message::TM_BYTESTREAM, $response['body'] );
	}

	/**
	 * Whether a connected address is public: not one `filter_var()`'s private
	 * and reserved flags refuse, nor in `REFUSED_RANGES`. An address under
	 * one of `IPV4_EMBEDDINGS` is judged by the IPv4 it carries; a string
	 * that is not an address fails.
	 *
	 * @param string $ip The address libcurl connected to.
	 */
	private static function is_public_address( string $ip ): bool {
		$packed = \inet_pton( $ip );
		if ( false === $packed ) {
			return false;
		}
		[ $embeddings, $refused ] = self::$networks ??= self::pack_networks();
		foreach ( $embeddings as [ $network, $bits, $offset ] ) {
			if ( self::in_range( $packed, $network, $bits ) ) {
				$packed = \substr( $packed, $offset, 4 );
				$ip     = Core::as_string( \inet_ntop( $packed ) );
				break;
			}
		}
		if ( false === \filter_var( $ip, \FILTER_VALIDATE_IP, \FILTER_FLAG_NO_PRIV_RANGE | \FILTER_FLAG_NO_RES_RANGE ) ) {
			return false;
		}
		foreach ( $refused as [ $network, $bits ] ) {
			if ( self::in_range( $packed, $network, $bits ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Pack `IPV4_EMBEDDINGS` and `REFUSED_RANGES` into the shape
	 * `$networks` holds.
	 *
	 * @return array{0:list<array{0:string,1:int,2:int}>,1:list<array{0:string,1:int}>}
	 */
	private static function pack_networks(): array {
		$embeddings = [];
		foreach ( self::IPV4_EMBEDDINGS as $cidr => $offset ) {
			[ $network, $bits ] = self::pack_cidr( $cidr );
			$embeddings[]       = [ $network, $bits, $offset ];
		}
		$ranges = [];
		foreach ( self::REFUSED_RANGES as $cidr ) {
			$ranges[] = self::pack_cidr( $cidr );
		}
		return [ $embeddings, $ranges ];
	}

	/**
	 * A CIDR range's network, as `inet_pton()` packs it, and its prefix bits.
	 *
	 * @param string $cidr `<network>/<bits>`.
	 * @return array{0:string,1:int}
	 */
	private static function pack_cidr( string $cidr ): array {
		[ $network, $bits ] = \explode( '/', $cidr );
		return [ Core::as_string( \inet_pton( $network ) ), (int) $bits ];
	}

	/**
	 * Whether a packed address falls in a packed network of its own family.
	 *
	 * @param string $packed  The address, as `inet_pton()` packs it.
	 * @param string $network The network, packed the same way.
	 * @param int    $bits    The network's prefix length.
	 */
	private static function in_range( string $packed, string $network, int $bits ): bool {
		if ( \strlen( $network ) !== \strlen( $packed ) ) {
			return false;
		}
		$whole = $bits >> 3;
		if ( 0 !== \strncmp( $packed, $network, $whole ) ) {
			return false;
		}
		$mask = ( 0xff << ( 8 - ( $bits & 7 ) ) ) & 0xff;
		return 0 === $mask || ( \ord( $packed[ $whole ] ) & $mask ) === ( \ord( $network[ $whole ] ) & $mask );
	}

	/**
	 * Whether libcurl keeps this credential line on its origin across a
	 * redirect: no line, or one in `Authorization`, which it drops when a
	 * redirect changes host, port or scheme.
	 *
	 * @param string $credential The credential header line, or ''.
	 */
	private static function stays_on_origin( string $credential ): bool {
		return '' === $credential || 0 === \strncasecmp( $credential, self::AUTHORIZATION, \strlen( self::AUTHORIZATION ) );
	}

	/**
	 * The name of the header the url's credential rides in, read again from
	 * the Vault, never its value; '' when none resolves now.
	 *
	 * @param string $url The fetched url.
	 */
	private function credential_name( string $url ): string {
		try {
			return \explode( ':', $this->credential_for( $url ), 2 )[0];
		} catch ( \UnexpectedValueException ) {
			return '';
		}
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
			'description' => 'Fetch the URL a TM_BYTESTREAM carries (a GET), or run the TM_STRUCT request { url, method GET or POST, body as JSON }, without blocking, and emit the body, or a TM_ERROR naming the url and why.',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'vault_group', 'type' => 'vault_group', 'description' => 'Optional Vault group: a url on one entry\'s origin carries its credential header, and one on two entries\' origin is refused.' ],
			],
			'commands'    => [],
		];
	}
}
