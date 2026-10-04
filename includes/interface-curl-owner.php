<?php
/**
 * Curl_Owner: a node that starts transfers on the Event_Framework's shared multi.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The completion contract for a transfer started through
 * `Event_Framework::start_curl()`. The framework filters `curl_multi_info_read`
 * for CURLMSG_DONE, finds the record the transfer was started under, calls
 * `on_curl_done()`, and releases the handle afterwards whatever it threw.
 *
 * The handle comes along because a streaming owner reads its HTTP status and
 * libcurl's error detail off it; a buffered owner, through `Curl_Transfer`,
 * never sees it.
 *
 * @template TContext
 */
interface Curl_Owner {

	/**
	 * One transfer this node started has finished.
	 *
	 * @param \CurlHandle $handle  The completed easy handle, released after this returns.
	 * @param int         $result  The transfer's CURLE_* code.
	 * @param TContext    $context What the transfer was started under.
	 */
	public function on_curl_done( \CurlHandle $handle, int $result, mixed $context ): void;
}
