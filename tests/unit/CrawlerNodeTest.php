<?php
/**
 * Crawler_Node: a same-site crawl through its own Curl sibling, with the
 * frontier in its own sqlite Table sibling.
 *
 * The graph is real — a Router, an interpreter, the crawler's Curl and Table
 * siblings and a capturing target — and only libcurl is stood in for, through
 * the dispatch and result seams.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Crawler_Node;
use Newspack_Nodes\Curl_Node;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/** A target that refuses every message, as a stopping Partition raises. */
final class Crawler_Down_Target_Fixture_Node extends Node {
	public function fill( array $message ): void {
		throw new \RuntimeException( 'target-down-8812' );
	}
}

/** Passes every request to the real Table except those `$drops` leaves unanswered. */
final class Crawler_Filtering_Table_Fixture_Node extends Node {
	/** @param \Closure(mixed): bool $drops Given a request VALUE. */
	public function __construct( private readonly Node $table, private readonly \Closure $drops ) {
		parent::__construct();
	}

	public function fill( array $message ): void {
		if ( ! ( $this->drops )( $message[ Message::VALUE ] ) ) {
			$this->table->fill( $message );
		}
	}
}

#[CoversClass( Crawler_Node::class )]
final class CrawlerNodeTest extends TestCase {

	private const SITE = 'https://site-5531.example';

	private string $dir = '';

	private Command_Interpreter_Node $ci;

	private Capture_Sink_Node $pages;

	/** @var list<string> Every url a dispatch was handed, in order. */
	private array $dispatched = [];

	/** @var array<string,\CurlHandle> The handle each url's dispatch returned. */
	private array $handles = [];

	/** @var array<int,string> The url each handle fetches, by spl_object_id. */
	private array $url_of = [];

	/** @var array<string,string> The body each url answers with. */
	private array $bodies = [];

	/** @var list<int> Stack depth at each dispatch. */
	private array $depths = [];

	/** @var array<string,array<int,mixed>> The opts each url's dispatch was handed. */
	private array $opts = [];

	/** @var array<string,string> The Location each url answers a 301 with. */
	private array $locations = [];

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->dir = $this->make_temp_dir( 'crawler-' );
		$this->use_base_dir( $this->dir, [ 'vault_require_ssl' => false ] );
		Event_Framework::$curl_dispatch = function ( array $opts ): \CurlHandle {
			$url                = (string) $opts[ \CURLOPT_URL ];
			$this->dispatched[] = $url;
			$this->opts[ $url ] = $opts;
			$this->depths[]     = \count( \debug_backtrace( \DEBUG_BACKTRACE_IGNORE_ARGS ) );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			$easy                                   = \curl_init();
			$this->handles[ $url ]                  = $easy;
			$this->url_of[ \spl_object_id( $easy ) ] = $url;
			return $easy;
		};
		Curl_Node::$curl_result = function ( \CurlHandle $easy ): array {
			$url = $this->url_of[ \spl_object_id( $easy ) ];
			return [
				'code'     => isset( $this->locations[ $url ] ) ? 301 : 200,
				'body'     => $this->bodies[ $url ] ?? '',
				'redirect' => $this->locations[ $url ] ?? '',
			];
		};
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$this->ci = new Command_Interpreter_Node();
		$this->ci->name( Node_Names::COMMAND_INTERPRETER );
		$this->ci->sink( $router );
		$this->pages = new Capture_Sink_Node();
		$this->pages->name( 'pages-6219' );
	}

	protected function tearDown(): void {
		Event_Framework::$curl_dispatch = null;
		Curl_Node::$curl_result         = null;
		unset( Core::$var['partition'] );
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::reset();
		parent::tearDown();
	}

	/** Build a crawler as a worker's topology does: `<partition>` bound, target wired. */
	private function crawler( string $name = 'crawl-4471', string ...$args ): Crawler_Node {
		Core::$var['partition'] = '3';
		try {
			$node = $this->ci->make_node( 'Crawler', $name, ...( [] === $args ? [ '7203' ] : $args ) );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->assertInstanceOf( Crawler_Node::class, $node );
		$node->target( 'pages-6219' );
		return $node;
	}

	/** Run $work once inside a running drain loop, where a fetch may start. */
	private function in_drain( \Closure $work ): void {
		$done = false;
		Event_Framework::instance()->drain(
			static function () use ( $work, &$done ): bool {
				if ( ! $done ) {
					$done = true;
					$work();
				}
				return false;
			}
		);
	}

	private function seed( Crawler_Node $crawler, string $url ): void {
		$crawler->fill( $this->seed_message( $url ) );
	}

	/** @return array<int,mixed> */
	private function seed_message( string $url ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::FROM ]  = 'seeder-3381';
		$m[ Message::VALUE ] = $url;
		return $m;
	}

	/** Complete one url's transfer inside a drain, answering $body. */
	private function complete( string $url, string $body = '', int $result = \CURLE_OK ): void {
		$this->bodies[ $url ] = $body;
		$this->in_drain( fn () => $this->complete_curl( $this->handles[ $url ], $result ) );
	}

	/** Complete one url's transfer inside a drain as a 301 to $location. */
	private function redirect( string $url, string $location ): void {
		$this->locations[ $url ] = $location;
		$this->in_drain( fn () => $this->complete_curl( $this->handles[ $url ] ) );
	}

	private function seen( Crawler_Node $crawler ): Table_Node {
		$seen = Core::node( "{$crawler->name()}:seen" );
		$this->assertInstanceOf( Table_Node::class, $seen );
		return $seen;
	}

	/** @return array<array-key,mixed> */
	private function members( Crawler_Node $crawler, string $set ): array {
		return $this->seen( $crawler )->members_of( [ $set ], Table_Node::MAX_MEMBERS_LIMIT )[ $set ] ?? [];
	}

	/** @return list<string> */
	private function links_body( string ...$paths ): string {
		return \implode( '', \array_map( static fn ( string $p ): string => "<a href=\"{$p}\">x</a>", $paths ) );
	}

	public function test_arguments_build_the_curl_and_seen_siblings(): void {
		$crawler = $this->crawler( 'crawl-4471', '86400', 'vault-77' );

		$curl = Core::node( 'crawl-4471:curl' );
		$this->assertInstanceOf( Curl_Node::class, $curl );
		$this->assertSame( [ 'vault-77' ], $curl->arguments() );
		$this->assertSame( 'crawl-4471', $curl->target(), 'answers come back to the crawler' );
		$this->assertSame( $crawler, $curl->publisher() );
		$this->assertSame( [ 'crawl-4471', '86400', 'sqlite' ], $this->seen( $crawler )->arguments() );
		$this->assertSame( $crawler, $this->seen( $crawler )->publisher() );
		$this->assertSame( $this->ci, $curl->sink() );
		$this->assertSame( $this->ci, $this->seen( $crawler )->sink() );
		$this->assertSame( 'router', $crawler->timer_mode() );
		$this->assertSame( Crawler_Node::TICK_MS, $crawler->interval_ms );
	}

	public function test_the_vault_id_is_optional(): void {
		$crawler = $this->crawler();
		$this->assertSame( [], Core::node( 'crawl-4471:curl' )?->arguments() );
		$this->assertSame( [ 'crawl-4471', '7203', 'sqlite' ], $this->seen( $crawler )->arguments() );
	}

	public function test_a_missing_ttl_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->crawler( 'crawl-4471', '' );
	}

	public function test_a_replay_with_new_tokens_rebuilds_both_siblings(): void {
		$crawler  = $this->crawler();
		$old_curl = Core::node( 'crawl-4471:curl' );
		$old_seen = $this->seen( $crawler );

		Core::$var['partition'] = '3';
		$crawler->arguments( [ '9100', 'vault-12' ] );

		$this->assertSame( '', $old_curl?->name(), 'the old Curl was removed' );
		$this->assertSame( '', $old_seen->name(), 'the old Table was removed' );
		$this->assertSame( [ 'vault-12' ], Core::node( 'crawl-4471:curl' )?->arguments() );
		$this->assertSame( [ 'crawl-4471', '9100', 'sqlite' ], $this->seen( $crawler )->arguments() );
		$this->assertSame( 'crawl-4471', Core::node( 'crawl-4471:curl' )?->target() );
	}

	public function test_a_replay_with_a_fetch_in_flight_refetches_it(): void {
		$crawler = $this->crawler();
		$url     = self::SITE . '/replayed-24';
		$this->in_drain( fn () => $this->seed( $crawler, $url ) );

		Core::$var['partition'] = '3';
		$crawler->arguments( [ '9100' ] );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ $url, $url ], $this->dispatched, 'the discarded fetch is recovered' );
	}

	public function test_a_refused_rebuild_restores_the_crawler_it_replaced(): void {
		$crawler                = $this->crawler( 'crawl-4471', '7203', 'vault-41' );
		Core::$var['partition'] = '3';

		try {
			$crawler->arguments( [ '0', 'vault-96' ] );
			$this->fail( 'a ttl below 1 is refused' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'crawl-4471:seen', $e->getMessage() );
		}

		$this->assertSame( [ '7203', 'vault-41' ], $crawler->arguments() );
		$this->assertStringStartsWith( "make_node Crawler crawl-4471 7203 vault-41\n", $crawler->dump_config() );
		$this->assertSame( [ 'vault-41' ], Core::node( 'crawl-4471:curl' )?->arguments() );
		$this->assertSame( [ 'crawl-4471', '7203', 'sqlite' ], $this->seen( $crawler )->arguments() );
		$this->assertTrue( $crawler->timer_is_active() );
	}

	public function test_a_replay_omitting_the_vault_id_drops_it(): void {
		$crawler                = $this->crawler( 'crawl-4471', '7203', 'vault-41' );
		Core::$var['partition'] = '3';

		$crawler->arguments( [ '9100' ] );

		$this->assertSame( [], Core::node( 'crawl-4471:curl' )?->arguments() );
		$this->assertSame( [ '9100' ], $crawler->arguments() );
	}

	public function test_a_refused_rebuild_whose_restore_fails_raises_both(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', 'vault-41' );

		try {
			$crawler->arguments( [ '0' ] );
			$this->fail( 'both builds refuse' );
		} catch ( Failures $e ) {
			$messages = \array_map( static fn ( \Throwable $f ): string => $f->getMessage(), $e->all() );
			$this->assertCount( 2, $messages );
			$this->assertStringContainsString( 'TTL of at least 1', $messages[0], 'the replay\'s own refusal' );
			$this->assertStringContainsString( 'needs a bound partition', $messages[1], 'the restore\'s' );
		}
		$this->assertSame( [ '7203', 'vault-41' ], $crawler->arguments() );
	}

	public function test_a_refused_first_build_leaves_nothing_registered(): void {
		try {
			$this->crawler( 'crawl-4471', '0' );
			$this->fail( 'a ttl below 1 is refused' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'crawl-4471:seen', $e->getMessage() );
		}

		$this->assertNull( Core::node( 'crawl-4471' ) );
		$this->assertNull( Core::node( 'crawl-4471:curl' ) );
		$this->assertNull( Core::node( 'crawl-4471:seen' ) );
	}

	public function test_a_rename_retargets_the_curl_sibling(): void {
		$crawler  = $this->crawler();
		$old_curl = Core::node( 'crawl-4471:curl' );

		$crawler->name( 'crawl-renamed-88' );

		$curl = Core::node( 'crawl-renamed-88:curl' );
		$this->assertInstanceOf( Curl_Node::class, $curl );
		$this->assertSame( 'crawl-renamed-88', $curl->target() );
		$this->assertNotSame( $old_curl, $curl, 'a rename always replaces Curl' );
		$this->assertSame( '', $old_curl?->name() );
	}

	public function test_a_rename_with_a_fetch_in_flight_refetches_it(): void {
		$crawler = $this->crawler();
		$url     = self::SITE . '/moving-17';
		$this->in_drain( fn () => $this->seed( $crawler, $url ) );
		$minted = $this->handles[ $url ];

		$crawler->name( 'crawl-renamed-88' );
		$this->bodies[ $url ] = '<a href="/after-18">x</a>';
		$this->in_drain( fn () => $this->complete_curl( $minted ) );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [], $this->pages->captured, 'the answer minted under the old name reaches nothing' );
		$this->assertSame( [ $url, $url ], $this->dispatched, 'recovery refetches it' );
		$this->assertNotSame( $minted, $this->handles[ $url ] );

		$this->complete( $url, '<a href="/after-18">x</a>' );

		$this->assertCount( 1, $this->pages->captured );
		$this->assertSame( Message::TM_BYTESTREAM, $this->pages->captured[0][ Message::TYPE ] );
		$this->assertSame( 'crawl-renamed-88', $this->pages->captured[0][ Message::FROM ] );
		$this->assertSame( [ $url, $url, self::SITE . '/after-18' ], $this->dispatched );
	}

	public function test_a_rename_with_a_fetch_in_flight_frees_the_whole_window(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/moving-17' ) );

		$crawler->name( 'crawl-renamed-88' );
		$urls = \array_map( static fn ( int $i ): string => \sprintf( '%s/w-%02d', self::SITE, $i ), \range( 1, Curl_Node::MAX_IN_FLIGHT ) );
		$this->seen( $crawler )->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( 1 + Curl_Node::MAX_IN_FLIGHT, $this->dispatched, 'the released fetch holds no slot' );
	}

	public function test_a_seed_is_fetched_once_and_a_repeat_within_the_ttl_is_not(): void {
		$crawler = $this->crawler();

		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );

		$this->assertSame( [ self::SITE . '/' ], $this->dispatched );
		$this->assertSame( [], $this->pages->captured, 'nothing is answered until the transfer completes' );
	}

	public function test_a_pending_url_outlives_the_seen_ttl(): void {
		$crawler     = $this->crawler( 'crawl-4471', '60' );
		$url         = self::SITE . '/ttl-5';
		Core::$clock = static fn (): float => 1790000000.0;
		$this->seed( $crawler, $url );

		Core::$clock = static fn (): float => 1790000061.0;
		$this->assertArrayHasKey( $url, $this->members( $crawler, 'pending' ), 'the frontier keeps it past the 60 s ttl' );
		Core::$clock = static fn (): float => 1790000000.0 + Crawler_Node::FRONTIER_TTL;
		$this->assertSame( [], $this->members( $crawler, 'pending' ), 'for one year' );
	}

	public function test_a_url_pending_refuses_is_forgotten_as_seen(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		$crawler = $this->crawler();
		$seen    = $this->seen( $crawler );
		$url     = self::SITE . '/lost-88';
		$sadd    = static fn ( mixed $value ): bool => \is_array( $value ) && isset( $value['SADD'] );
		Core::register_node( 'crawl-4471:seen', new Crawler_Filtering_Table_Fixture_Node( $seen, $sadd ) );

		$this->seed( $crawler, $url );

		$this->assertNull( $seen->lookup( $url ), 'its seen key is removed' );
		$this->assertCount( 1, \array_filter( $lines, static fn ( string $line ): bool => \str_contains( $line, 'pending' ) ) );
		Core::register_node( 'crawl-4471:seen', $seen );
		$this->in_drain( fn () => $this->seed( $crawler, $url ) );
		$this->assertSame( [ $url ], $this->dispatched, 'a later sighting finds it new' );
	}

	public function test_a_seed_is_normalized_as_a_link_is(): void {
		$crawler = $this->crawler();

		$this->in_drain( fn () => $this->seed( $crawler, 'HTTPS://Site-5531.Example:443#top' ) );
		$this->complete( self::SITE . '/', $this->links_body( '/', self::SITE . '/#again' ) );

		$this->assertSame( [ self::SITE . '/' ], $this->dispatched, 'the home page is fetched once' );
	}

	public function test_a_seed_holding_whitespace_is_an_invalid_url(): void {
		$crawler = $this->crawler();

		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/a b' ) );

		$this->assertSame( [ [ Message::TM_ERROR, 'invalid url ' . self::SITE . '/a b' ] ], \array_map( static fn ( array $m ): array => [ $m[ Message::TYPE ], $m[ Message::VALUE ] ], $this->pages->captured ) );
		$this->assertSame( [], $this->dispatched );
	}

	public function test_the_curl_sibling_does_not_follow_redirects(): void {
		$crawler = $this->crawler();

		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );

		$this->assertFalse( $this->opts[ self::SITE . '/' ][ \CURLOPT_FOLLOWLOCATION ] );
	}

	public function test_a_same_origin_redirect_reaches_target_and_its_location_is_fetched_next(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/old-1' ) );

		$this->redirect( self::SITE . '/old-1', self::SITE . '/new-2#part' );

		$this->assertSame( [ [ Message::TM_RESPONSE, self::SITE . '/old-1', self::SITE . '/new-2#part' ] ], \array_map( static fn ( array $m ): array => [ $m[ Message::TYPE ], $m[ Message::KEY ], $m[ Message::VALUE ] ], $this->pages->captured ) );
		$this->assertSame( [ self::SITE . '/old-1', self::SITE . '/new-2' ], $this->dispatched );
		$this->assertSame( [ self::SITE . '/new-2' ], \array_map( 'strval', \array_keys( $this->members( $crawler, 'inflight' ) ) ) );
	}

	public function test_an_off_site_redirect_reaches_target_and_is_not_queued(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/old-1' ) );

		$this->redirect( self::SITE . '/old-1', 'https://elsewhere-4410.example/new-2' );

		$this->assertCount( 1, $this->pages->captured );
		$this->assertSame( Message::TM_RESPONSE, $this->pages->captured[0][ Message::TYPE ] );
		$this->assertSame( [ self::SITE . '/old-1' ], $this->dispatched );
		$this->assertSame( [], $this->members( $crawler, 'pending' ) );
		$this->assertSame( [], $this->members( $crawler, 'inflight' ) );
	}

	public function test_a_relative_location_resolves_against_the_page(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/dir/old-1' ) );

		$this->redirect( self::SITE . '/dir/old-1', '../moved/x-3' );

		$this->assertSame( [ self::SITE . '/dir/old-1', self::SITE . '/moved/x-3' ], $this->dispatched );
	}

	public function test_an_invalid_seed_answers_invalid_url_to_target(): void {
		$crawler = $this->crawler();

		$message                = $this->seed_message( "  nope\n" );
		$message[ Message::TO ] = 'leftover-31';

		$this->in_drain( static fn () => $crawler->fill( $message ) );

		$this->assertCount( 1, $this->pages->captured );
		$out = $this->pages->captured[0];
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'invalid url nope', $out[ Message::VALUE ] );
		$this->assertSame( 'seeder-3381', $out[ Message::FROM ] );
		$this->assertSame( [], $this->dispatched );
	}

	public function test_a_body_reaches_target_and_its_same_origin_links_are_fetched(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );

		$body = $this->links_body( '/a-11', 'b-12', self::SITE . '/c-13#frag', 'https://off-site-77.example/d' );
		$this->complete( self::SITE . '/', $body );

		$this->assertCount( 1, $this->pages->captured );
		$out = $this->pages->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( $body, $out[ Message::VALUE ] );
		$this->assertSame( self::SITE . '/', $out[ Message::KEY ] );
		$this->assertSame( 'crawl-4471', $out[ Message::FROM ] );
		$this->assertSame(
			[ self::SITE . '/', self::SITE . '/a-11', self::SITE . '/b-12', self::SITE . '/c-13' ],
			$this->dispatched,
			'three more transfers start, and the off-site page is never fetched'
		);
		$this->assertSame( [], $this->members( $crawler, 'pending' ) );
		$this->assertSame( [ self::SITE . '/a-11', self::SITE . '/b-12', self::SITE . '/c-13' ], \array_map( 'strval', \array_keys( $this->members( $crawler, 'inflight' ) ) ) );
	}

	public function test_the_window_holds_sixteen_in_flight_and_each_answer_starts_one(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );
		$paths = \array_map( static fn ( int $i ): string => \sprintf( '/p-%02d', $i ), \range( 1, 40 ) );

		$this->complete( self::SITE . '/', $this->links_body( ...$paths ) );

		$this->assertCount( 1 + Curl_Node::MAX_IN_FLIGHT, $this->dispatched, 'exactly sixteen in flight' );
		$this->assertCount( 40 - Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'pending' ) );
		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'inflight' ) );
		$moves = $this->seen( $crawler )->stats()['SMOVE'];
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$this->assertSame( $moves, $this->seen( $crawler )->stats()['SMOVE'], 'a tick with a full window asks the Table nothing' );

		$this->complete( $this->dispatched[1] );

		$this->assertCount( 2 + Curl_Node::MAX_IN_FLIGHT, $this->dispatched, 'one answer starts exactly one more' );
		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'inflight' ) );
		$this->assertSame( [ Message::TM_BYTESTREAM, Message::TM_BYTESTREAM ], \array_column( $this->pages->captured, Message::TYPE ), 'no fetch is turned away busy' );
	}

	public function test_a_forward_that_throws_keeps_the_url_in_flight_and_its_links(): void {
		$crawler = $this->crawler();
		$down    = new Crawler_Down_Target_Fixture_Node();
		$down->name( 'down-5530' );
		$crawler->target( 'down-5530' );
		$url = self::SITE . '/home-3';
		$this->in_drain( fn () => $this->seed( $crawler, $url ) );

		try {
			$this->complete( $url, $this->links_body( '/l-1', '/l-2' ) );
			$this->fail( 'the target refuses' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'target-down-8812', $e->getMessage() );
		}

		$this->assertSame( [ $url ], \array_map( 'strval', \array_keys( $this->members( $crawler, 'inflight' ) ) ), 'the next start refetches it' );
		$this->assertSame( [ self::SITE . '/l-1', self::SITE . '/l-2' ], \array_map( 'strval', \array_keys( $this->members( $crawler, 'pending' ) ) ) );
	}

	public function test_an_error_answer_reaches_target_and_leaves_inflight(): void {
		$crawler = $this->crawler();
		$url     = self::SITE . '/broken-29';
		$this->in_drain( fn () => $this->seed( $crawler, $url ) );
		$this->assertArrayHasKey( $url, $this->members( $crawler, 'inflight' ) );

		$this->complete( $url, '', \CURLE_COULDNT_CONNECT );

		$this->assertCount( 1, $this->pages->captured );
		$out = $this->pages->captured[0];
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertStringStartsWith( 'curl error 7 ', Core::as_string( $out[ Message::VALUE ] ) );
		$this->assertSame( $url, $out[ Message::KEY ] );
		$this->assertSame( [], $this->members( $crawler, 'inflight' ) );
		$this->assertSame( [ $url ], $this->dispatched, 'an answered url is done, never retried' );
	}

	public function test_a_seed_outside_a_drain_waits_in_pending_for_the_next_tick(): void {
		$crawler = $this->crawler();
		$url     = self::SITE . '/later-41';

		$this->seed( $crawler, $url );

		$this->assertSame( [], $this->dispatched );
		$this->assertSame( [], $this->pages->captured );
		$this->assertArrayHasKey( $url, $this->members( $crawler, 'pending' ) );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ $url ], $this->dispatched );
		$this->assertSame( [], $this->members( $crawler, 'pending' ) );
	}

	public function test_synchronous_answers_take_one_window_per_tick_without_recursing(): void {
		Event_Framework::$curl_dispatch = function ( array $opts ): bool {
			$this->dispatched[] = (string) $opts[ \CURLOPT_URL ];
			$this->depths[]     = \count( \debug_backtrace( \DEBUG_BACKTRACE_IGNORE_ARGS ) );
			return false;
		};
		$crawler = $this->crawler();
		$urls    = \array_map( static fn ( int $i ): string => \sprintf( '%s/q-%02d', self::SITE, $i ), \range( 1, 20 ) );
		$this->seen( $crawler )->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$first = \array_slice( $urls, 0, Curl_Node::MAX_IN_FLIGHT );
		$this->assertSame( $first, $this->dispatched, 'one tick answers one window of urls' );
		$this->assertSame( 2, $this->seen( $crawler )->stats()['SMOVE']['calls'], 'the recovery and one move' );
		$this->assertCount( 1, \array_unique( $this->depths ), 'every dispatch runs at one stack depth' );
		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->pages->captured );
		foreach ( $this->pages->captured as $i => $out ) {
			$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
			$this->assertSame( "curl_init failed {$urls[ $i ]}", $out[ Message::VALUE ] );
			$this->assertSame( $urls[ $i ], $out[ Message::KEY ] );
		}
		$this->assertSame( [], $this->members( $crawler, 'inflight' ) );
		$this->assertSame( \array_slice( $urls, Curl_Node::MAX_IN_FLIGHT ), \array_map( 'strval', \array_keys( $this->members( $crawler, 'pending' ) ) ) );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( $urls, $this->dispatched, 'the next tick takes the rest' );
		$this->assertSame( [], $this->members( $crawler, 'pending' ) );
	}

	public function test_a_rebuilt_crawler_fetches_what_was_in_flight_on_its_first_tick(): void {
		$crawler = $this->crawler();
		$this->seen( $crawler )->add_members(
			[
				'inflight' => [ [ self::SITE . '/f-1' => 1, self::SITE . '/f-2' => 1 ], 900 ],
				'pending'  => [ [ self::SITE . '/f-3' => 1 ], 900 ],
			]
		);
		$crawler->remove_node();

		$crawler = $this->crawler();
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ self::SITE . '/f-1', self::SITE . '/f-2', self::SITE . '/f-3' ], $this->dispatched, 'the first tick fetches all three' );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( 3, $this->dispatched, 'the second tick adds nothing' );
	}

	public function test_a_recovery_the_table_does_not_answer_is_retried_next_tick(): void {
		$crawler = $this->crawler();
		$url     = self::SITE . '/stranded-63';
		$queued  = self::SITE . '/queued-12';
		$seen    = $this->seen( $crawler );
		$seen->add_members(
			[
				'inflight' => [ [ $url => 1 ], 900 ],
				'pending'  => [ [ $queued => 1 ], 900 ],
			]
		);
		$recovery = static fn ( mixed $value ): bool => \is_string( $value ) && \str_contains( $value, ' inflight pending' );
		Core::register_node( 'crawl-4471:seen', new Crawler_Filtering_Table_Fixture_Node( $seen, $recovery ) );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [], $this->dispatched, 'nothing is fetched while recovery is owed' );
		Core::register_node( 'crawl-4471:seen', $seen );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ $queued, $url ], $this->dispatched, 'the failed recovery runs again' );
	}

	public function test_recovery_returns_more_than_one_move_of_inflight(): void {
		$crawler = $this->crawler();
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/r-{$i}", \range( 1, Table_Node::MAX_MEMBERS_LIMIT + 3 ) );
		$this->seen( $crawler )->add_members( [ 'inflight' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );
		$crawler->remove_node();
		$crawler = $this->crawler();

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->dispatched );
		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'inflight' ), 'only the fetches in flight remain there' );
		$this->assertCount( Table_Node::MAX_MEMBERS_LIMIT + 3 - Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'pending' ) );
	}

	public function test_a_seed_before_the_first_tick_is_fetched_exactly_once(): void {
		$crawler = $this->crawler();
		$this->seen( $crawler )->add_members( [ 'inflight' => [ [ self::SITE . '/f-1' => 1 ], 900 ] ] );
		$crawler->remove_node();
		$crawler = $this->crawler();

		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/s-9' ) );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ self::SITE . '/f-1', self::SITE . '/s-9' ], $this->dispatched );
	}

	public function test_a_struct_is_dropped(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		$crawler                 = $this->crawler();
		$message                 = $this->seed_message( self::SITE . '/' );
		$message[ Message::TYPE ] = Message::TM_STRUCT;

		$this->in_drain( static fn () => $crawler->fill( $message ) );

		$this->assertSame( [], $this->dispatched );
		$this->assertSame( [], $this->pages->captured );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( 'not a TM_BYTESTREAM url', $lines[0] );
	}

	public function test_dump_config_replays_the_crawler_alone(): void {
		$crawler = $this->crawler( 'crawl-4471', '86400', 'vault-77' );

		$this->assertSame(
			"make_node Crawler crawl-4471 86400 vault-77\nconnect_node crawl-4471 pages-6219\n",
			$crawler->dump_config()
		);
		$this->assertStringNotContainsString( 'crawl-4471:', Core::as_string( $this->ci->dispatch( 'dump_config' ) ) );
	}

	public function test_remove_node_unregisters_both_siblings(): void {
		$crawler = $this->crawler();

		$crawler->remove_node();

		$this->assertNull( Core::node( 'crawl-4471:curl' ) );
		$this->assertNull( Core::node( 'crawl-4471:seen' ) );
		$this->assertNull( Core::node( 'crawl-4471' ) );
	}

	public function test_node_schema_declares_the_two_arguments(): void {
		$schema = Crawler_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertTrue( $schema['has_target'] );
		$this->assertSame( [], $schema['commands'] );
		$this->assertSame( [ 'ttl', 'vault_id' ], \array_column( $schema['arguments'], 'name' ) );
		$this->assertSame( [ 'int', 'vault_id' ], \array_column( $schema['arguments'], 'type' ) );
		$this->assertTrue( $schema['arguments'][0]['required'] );
	}
}
