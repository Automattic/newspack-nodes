<?php
/**
 * Crawler_Node::links(): the absolute same-origin links a page carries.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Crawler_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Crawler_Node::class )]
class CrawlerLinksTest extends TestCase {

	private const PAGE = 'https://site-4417.example:8443/dir/page.html';

	public function test_links_resolve_relative_hrefs_and_drop_fragments(): void {
		$html = '<a href="next.html#top">n</a><a href="/root?q=1">r</a><a href="../up/">u</a><a href="//site-4417.example:8443/pr">p</a>';
		$this->assertSame(
			[ 'https://site-4417.example:8443/dir/next.html', 'https://site-4417.example:8443/root?q=1', 'https://site-4417.example:8443/up/', 'https://site-4417.example:8443/pr' ],
			Crawler_Node::links( $html, self::PAGE )
		);
	}

	public function test_base_href_is_the_base_for_relative_links(): void {
		$html = '<base href="https://site-4417.example:8443/other/"><a href="leaf">l</a>';
		$this->assertSame( [ 'https://site-4417.example:8443/other/leaf' ], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_other_origins_and_non_http_links_are_skipped(): void {
		$html = '<a href="https://other-9.example/">h</a><a href="http://site-4417.example:8443/">s</a><a href="https://site-4417.example/">port</a><a href="mailto:a@b.example">m</a><a href="javascript:void(0)">j</a>';
		$this->assertSame( [], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_entities_decode_and_repeats_collapse(): void {
		$html = '<a href="a.html?x=1&amp;y=2">1</a><a href="a.html?x=1&amp;y=2">2</a><a href="b c.html">ws</a>';
		$this->assertSame( [ 'https://site-4417.example:8443/dir/a.html?x=1&y=2' ], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_an_empty_or_binary_body_yields_nothing(): void {
		$this->assertSame( [], Crawler_Node::links( '', self::PAGE ) );
		$this->assertSame( [], Crawler_Node::links( "\x00\xff\x89PNG\r\n", self::PAGE ) );
	}

	/**
	 * RFC 3986 5.4.1 through links(), base http://a/b/c/d;p?q, fragments
	 * dropped. `//g` names another host and is covered by the cross-origin
	 * test; every dot-segment branch runs through the references above.
	 *
	 * @return array<string,array{string,string}>
	 */
	public static function rfc_references(): array {
		return [
			'g'          => [ 'g', 'http://a/b/c/g' ],
			'./g'        => [ './g', 'http://a/b/c/g' ],
			'g/'         => [ 'g/', 'http://a/b/c/g/' ],
			'/g'         => [ '/g', 'http://a/g' ],
			'?y'         => [ '?y', 'http://a/b/c/d;p?y' ],
			'g?y'        => [ 'g?y', 'http://a/b/c/g?y' ],
			'#s'         => [ '#s', 'http://a/b/c/d;p?q' ],
			'g#s'        => [ 'g#s', 'http://a/b/c/g' ],
			';x'         => [ ';x', 'http://a/b/c/;x' ],
			'.'          => [ '.', 'http://a/b/c/' ],
			'./'         => [ './', 'http://a/b/c/' ],
			'..'         => [ '..', 'http://a/b/' ],
			'../'        => [ '../', 'http://a/b/' ],
			'../g'       => [ '../g', 'http://a/b/g' ],
			'../..'      => [ '../..', 'http://a/' ],
			'../../'     => [ '../../', 'http://a/' ],
			'../../g'    => [ '../../g', 'http://a/g' ],
			'../../../g' => [ '../../../g', 'http://a/g' ],
		];
	}

	#[DataProvider( 'rfc_references' )]
	public function test_rfc_3986_reference_resolution( string $ref, string $expected ): void {
		$this->assertSame( [ $expected ], Crawler_Node::links( '<a href="' . $ref . '">x</a>', 'http://a/b/c/d;p?q' ) );
	}

	public function test_cross_host_network_path_reference_is_skipped(): void {
		$this->assertSame( [], Crawler_Node::links( '<a href="//g">x</a>', 'http://a/b/c/d;p?q' ) );
	}

	public function test_an_explicit_default_port_equals_the_implicit_one(): void {
		$page = 'https://site-4417.example/dir/page.html';
		$html = '<a href="https://site-4417.example:443/x">a</a><a href="/x">b</a>';
		$this->assertSame( [ 'https://site-4417.example/x' ], Crawler_Node::links( $html, $page ) );
	}

	public function test_an_empty_path_and_a_default_port_normalize_to_one_url(): void {
		$page = 'https://site-4417.example/dir/page.html';
		$html = '<a href="https://site-4417.example">a</a><a href="https://site-4417.example/">b</a><a href="https://site-4417.example:443/">c</a>';
		$this->assertSame( [ 'https://site-4417.example/' ], Crawler_Node::links( $html, $page ) );
	}

	public function test_scheme_and_host_are_lowercased_and_the_path_keeps_its_case(): void {
		$html = '<a href="HTTPS://SITE-4417.Example:8443/Up/Case">a</a>';
		$this->assertSame( [ 'https://site-4417.example:8443/Up/Case' ], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_a_link_carrying_userinfo_is_skipped(): void {
		$html = '<a href="https://u:p@site-4417.example:8443/a">a</a><a href="https://u@site-4417.example:8443/b">b</a>';
		$this->assertSame( [], Crawler_Node::links( $html, self::PAGE ) );
	}

	/** The link is resolved without its userinfo, so `origin_of()` never sees it there. */
	public function test_a_link_whose_authority_holds_two_at_signs_is_skipped(): void {
		$html = '<a href="https://x@evil-44.example@site-4417.example:8443/c">c</a><a href="//svc-9:pw-9@site-4417.example:8443/d">d</a>';
		$this->assertSame( [], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_an_empty_base_href_leaves_the_page_url_as_the_base(): void {
		$html = '<base href=""><a href="leaf">l</a>';
		$this->assertSame( [ 'https://site-4417.example:8443/dir/leaf' ], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_the_first_base_that_has_an_href_wins(): void {
		$html = '<base target="_blank"><base href="https://site-4417.example:8443/first/"><base href="/second/"><a href="leaf">l</a>';
		$this->assertSame( [ 'https://site-4417.example:8443/first/leaf' ], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_a_non_ascii_href_keeps_its_utf8_bytes(): void {
		$html = '<a href="/caf' . "\u{e9}-\u{4e2d}" . '">a</a>';
		$this->assertSame( [ 'https://site-4417.example:8443/caf' . "\u{e9}-\u{4e2d}" ], Crawler_Node::links( $html, self::PAGE ) );
	}

	public function test_a_callers_pending_libxml_errors_survive(): void {
		$previous = \libxml_use_internal_errors( true );
		\libxml_clear_errors();
		try {
			( new \DOMDocument() )->loadXML( '<unclosed>' );
			$pending = \libxml_get_errors();
			$this->assertNotEmpty( $pending );
			Crawler_Node::links( '<a href="/x">x</a><b><p></i>', self::PAGE );
			$after = \libxml_get_errors();
			$this->assertGreaterThanOrEqual( \count( $pending ), \count( $after ) );
			$this->assertSame( $pending[0]->message, $after[0]->message );
			$this->assertTrue( \libxml_use_internal_errors( true ) );
		} finally {
			\libxml_clear_errors();
			\libxml_use_internal_errors( $previous );
		}
	}

	public function test_links_leaves_the_internal_error_mode_as_it_found_it(): void {
		$previous = \libxml_use_internal_errors( false );
		try {
			Crawler_Node::links( '<a href="/x">x</a><b><p></i>', self::PAGE );
			$this->assertFalse( \libxml_use_internal_errors( false ) );
		} finally {
			\libxml_use_internal_errors( $previous );
		}
	}

	public function test_a_non_http_scheme_with_a_host_and_a_missing_or_empty_href_are_skipped(): void {
		$html = '<a href="ftp://site-4417.example:8443/f">f</a><a href="ftp://site-4417.example:21/f">g</a><a href="">e</a><a>n</a>';
		$this->assertSame( [], Crawler_Node::links( $html, self::PAGE ) );
	}
}
