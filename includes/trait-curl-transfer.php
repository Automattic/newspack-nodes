<?php
/**
 * Curl_Transfer: one buffered libcurl transfer per request, run through the
 * Event_Framework's shared multi.
 *
 * What a node that fetches one whole body needs and does not decide for
 * itself: the cap on that body, a buffer of its own per transfer, the
 * response headers it names, and the read of the status and body once it
 * completes. The Event_Framework owns the
 * handle — making it, holding it and releasing it — so a node supplies its
 * request opts, a context, and `on_transfer_done()`, and never sees a handle.
 *
 * `SSE_In_Node` is the other multi user and keeps its own streaming write
 * callback: an event stream is never one buffered body.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Buffered transfers on the shared multi.
 *
 * @template TContext
 */
trait Curl_Transfer {

	/** Default cap on one response body, 8 MiB; it is buffered into the PHP heap. */
	public const MAX_REPLY_BYTES = 8388608;

	/** Bytes of one response header's value a transfer keeps. */
	public const MAX_HEADER_BYTES = 256;

	/**
	 * libcurl result-read seam. Null reads the handle's HTTP code and the
	 * transfer's own buffer. Tests reassign it to inject a status and a body,
	 * so the classification and the forwarding run as real production code
	 * without a network transfer.
	 *
	 * Signature: `function ( \CurlHandle $easy ): array{code:int,body:string,redirect:string}`,
	 * `redirect` the absolute Location libcurl reports for a 3xx it did not
	 * follow, '' for none.
	 *
	 * @var (\Closure(\CurlHandle): array{code:int,body:string,redirect:string})|null
	 */
	public static ?\Closure $curl_result = null;

	/** Transfers this node has started that have not completed or been released. */
	private int $in_flight = 0;

	/**
	 * Add the body cap to a node's opts and start the transfer under
	 * `$context`. Each transfer buffers into its own string, appended in place,
	 * and, when `$names` names any, keeps the first value of each of those
	 * response headers, trimmed and cut to MAX_HEADER_BYTES, from the final
	 * response's head alone: a status line starts the headers again, so a
	 * redirect hop's give way, and the blank line ending a head stops them, so
	 * a chunked body's trailers never land. A dispatch that yields no handle
	 * starts nothing; the caller reports it.
	 *
	 * @param array<int,mixed> $opts    The node's own request opts.
	 * @param TContext         $context What `on_transfer_done()` is handed back.
	 * @param list<string>     $names   The response headers to keep, lowercased; none reads none.
	 * @return bool Whether a transfer is now in flight.
	 */
	protected function start_transfer( array $opts, mixed $context, array $names ): bool {
		$body    = '';
		$headers = [];
		$cap     = $this->reply_cap();
		if ( [] !== $names ) {
			$ended = false;
			$opts[ \CURLOPT_HEADERFUNCTION ] = static function ( $easy, string $line ) use ( &$headers, &$ended, $names ): int {
				if ( \str_starts_with( $line, 'HTTP/' ) ) {
					$headers = [];
					$ended   = false;
				} elseif ( '' === \trim( $line ) ) {
					$ended = true;
				} elseif ( ! $ended && 1 === \preg_match( '/^(' . Vault::HEADER_NAME . '):(.*)$/s', $line, $match ) ) {
					$name = \strtolower( $match[1] );
					if ( \in_array( $name, $names, true ) && ! isset( $headers[ $name ] ) ) {
						$headers[ $name ] = \substr( \trim( $match[2] ), 0, self::MAX_HEADER_BYTES );
					}
				}
				return \strlen( $line );
			};
		}
		$opts += [
			// MAXFILESIZE needs a declared length; the callback does the work.
			\CURLOPT_MAXFILESIZE   => $cap,
			\CURLOPT_WRITEFUNCTION => static function ( $easy, string $chunk ) use ( &$body, $cap ): int {
				$len = \strlen( $chunk );
				if ( \strlen( $body ) + $len > $cap ) {
					return 0; // short write: libcurl aborts the transfer
				}
				$body .= $chunk;
				return $len;
			},
		];
		$transfer = [
			'context' => $context,
			'body'    => static function () use ( &$body ): string {
				return $body;
			},
			'headers' => static function () use ( &$headers ): array {
				return $headers;
			},
		];
		if ( null === Event_Framework::instance()->start_curl( $this, $opts, $transfer ) ) {
			return false;
		}
		++$this->in_flight;
		return true;
	}

	/** The cap on one response body this node buffers; a node may raise it. */
	protected function reply_cap(): int {
		return self::MAX_REPLY_BYTES;
	}

	/**
	 * Read a finished transfer — its status and body when it completed, zero
	 * and '' when libcurl failed it — and hand that to `on_transfer_done()`,
	 * with the response headers it kept, which the header callback, not the
	 * result seam, fills.
	 *
	 * @api Called by the Event_Framework.
	 *
	 * @param \CurlHandle                                                                             $handle   The completed easy handle.
	 * @param int                                                                                     $result   The transfer's CURLE_* code.
	 * @param array{context:TContext,body:\Closure(): string,headers:\Closure(): array<string,string>} $transfer What `start_transfer()` started it under.
	 */
	public function on_curl_done( \CurlHandle $handle, int $result, mixed $transfer ): void {
		--$this->in_flight;
		$response = [
			'code'     => 0,
			'body'     => '',
			'redirect' => '',
		];
		if ( \CURLE_OK === $result ) {
			// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_getinfo
			$read = self::$curl_result ?? static fn ( \CurlHandle $easy ): array => [
				'code'     => \curl_getinfo( $easy, \CURLINFO_HTTP_CODE ),
				'body'     => ( $transfer['body'] )(),
				'redirect' => Core::as_string( \curl_getinfo( $easy, \CURLINFO_REDIRECT_URL ) ),
			];
			// phpcs:enable
			$response = $read( $handle );
		}
		$response['headers'] = ( $transfer['headers'] )();
		$this->on_transfer_done( $result, $response, $transfer['context'] );
	}

	/**
	 * Act on one finished transfer.
	 *
	 * @param int                         $result   The transfer's CURLE_* code.
	 * @param array{code:int,body:string,redirect:string,headers:array<string,string>} $response Its status, body, unfollowed Location and kept headers; zero and '' unless CURLE_OK.
	 * @param TContext                    $context  What `start_transfer()` was handed.
	 */
	abstract protected function on_transfer_done( int $result, array $response, mixed $context ): void;

	/**
	 * How many transfers this node has in flight, kept as a count so a check
	 * per fill costs nothing.
	 *
	 * @api Crawler_Node
	 */
	public function transfers_in_flight(): int {
		return $this->in_flight;
	}

	/**
	 * Teardown: release every transfer still in flight, silently. A teardown
	 * is a planned exit, such as a worker ending its lifetime mid-crawl. The
	 * crawler refetches what it left in flight on its next start; any other
	 * owner loses those transfers, as ADR-3 accepts.
	 */
	protected function release_all(): void {
		Event_Framework::instance()->release_curl( $this );
		$this->in_flight = 0;
	}
}
