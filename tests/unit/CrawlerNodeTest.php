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

/** Answers every request `$refuses` picks with a TM_ERROR, as a Table refusing it. */
final class Crawler_Refusing_Table_Fixture_Node extends Node {
	/** @param \Closure(mixed): bool $refuses Given a request VALUE. */
	public function __construct( private readonly Table_Node $table, private readonly \Closure $refuses ) {
		parent::__construct();
	}

	public function fill( array $message ): void {
		if ( ! ( $this->refuses )( $message[ Message::VALUE ] ) ) {
			$this->table->fill( $message );
			return;
		}
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_ERROR;
		$reply[ Message::FROM ]  = $this->table->name();
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::VALUE ] = "ADD refused-7740\n";
		$this->table->sink()->fill( $reply );
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

	/** Build a crawler as a worker's topology does: `{partition}` bound, target wired. */
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
		$crawler = $this->crawler( 'crawl-4471', '86400', 'crawl-g7' );

		$curl = Core::node( 'crawl-4471:curl' );
		$this->assertInstanceOf( Curl_Node::class, $curl );
		$this->assertSame( [ 'crawl-g7' ], $curl->arguments() );
		$this->assertSame( 'crawl-4471', $curl->target(), 'answers come back to the crawler' );
		$this->assertSame( $crawler, $curl->publisher() );
		$this->assertSame( [ 'crawl-4471', '86400', 'sqlite' ], $this->seen( $crawler )->arguments() );
		$this->assertSame( $crawler, $this->seen( $crawler )->publisher() );
		$this->assertSame( $this->ci, $curl->sink() );
		$this->assertSame( $this->ci, $this->seen( $crawler )->sink() );
		$this->assertSame( 'router', $crawler->timer_mode() );
		$this->assertSame( Crawler_Node::TICK_MS, $crawler->interval_ms );
	}

	/** A crawler as `crawler()` builds it, keeping Curl's whole window in flight. */
	private function wide( string $name = 'crawl-4471' ): Crawler_Node {
		return $this->crawler( $name, '7203', '', '0', (string) Curl_Node::MAX_IN_FLIGHT );
	}

	public function test_the_vault_group_is_optional(): void {
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
		$crawler->arguments( [ '9100', 'group-12' ] );

		$this->assertSame( '', $old_curl?->name(), 'the old Curl was removed' );
		$this->assertSame( '', $old_seen->name(), 'the old Table was removed' );
		$this->assertSame( [ 'group-12' ], Core::node( 'crawl-4471:curl' )?->arguments() );
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
		$crawler                = $this->crawler( 'crawl-4471', '7203', 'group-41' );
		Core::$var['partition'] = '3';

		try {
			$crawler->arguments( [ '0', 'group-96' ] );
			$this->fail( 'a ttl below 1 is refused' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'crawl-4471:seen', $e->getMessage() );
		}

		$this->assertSame( [ '7203', 'group-41' ], $crawler->arguments() );
		$this->assertStringStartsWith( "make_node Crawler crawl-4471 7203 group-41\n", $crawler->dump_config() );
		$this->assertSame( [ 'group-41' ], Core::node( 'crawl-4471:curl' )?->arguments() );
		$this->assertSame( [ 'crawl-4471', '7203', 'sqlite' ], $this->seen( $crawler )->arguments() );
		$this->assertTrue( $crawler->timer_is_active() );
	}

	public function test_a_replay_omitting_the_vault_group_drops_it(): void {
		$crawler                = $this->crawler( 'crawl-4471', '7203', 'group-41' );
		Core::$var['partition'] = '3';

		$crawler->arguments( [ '9100' ] );

		$this->assertSame( [], Core::node( 'crawl-4471:curl' )?->arguments() );
		$this->assertSame( [ '9100' ], $crawler->arguments() );
	}

	public function test_a_refused_rebuild_whose_restore_fails_raises_both(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', 'group-41' );

		try {
			$crawler->arguments( [ '0' ] );
			$this->fail( 'both builds refuse' );
		} catch ( Failures $e ) {
			$messages = \array_map( static fn ( \Throwable $f ): string => $f->getMessage(), $e->all() );
			$this->assertCount( 2, $messages );
			$this->assertStringContainsString( 'TTL of at least 1', $messages[0], 'the replay\'s own refusal' );
			$this->assertStringContainsString( 'needs a bound partition', $messages[1], 'the restore\'s' );
		}
		$this->assertSame( [ '7203', 'group-41' ], $crawler->arguments() );
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
		$crawler = $this->wide();
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
		$this->assertSame( [ [ Message::TM_INFO, 'already seen ' . self::SITE . '/' ] ], \array_map( static fn ( array $m ): array => [ $m[ Message::TYPE ], $m[ Message::VALUE ] ], $this->pages->captured ), 'only the repeat is answered before the transfer completes' );
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

	/** @return array<string,array{0: bool}> */
	public static function failed_adds(): array {
		return [
			'the Table refuses the ADD'         => [ true ],
			'the Table leaves the ADD unanswered' => [ false ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'failed_adds' )]
	public function test_a_seed_whose_add_fails_answers_an_error_and_never_already_seen( bool $refuse ): void {
		$crawler = $this->crawler();
		$seen    = $this->seen( $crawler );
		$url     = self::SITE . '/failed-add-29';
		$add     = static fn ( mixed $value ): bool => \is_array( $value ) && isset( $value['ADD'] );
		Core::register_node( 'crawl-4471:seen', $refuse ? new Crawler_Refusing_Table_Fixture_Node( $seen, $add ) : new Crawler_Filtering_Table_Fixture_Node( $seen, $add ) );

		$this->in_drain( fn () => $this->seed( $crawler, $url ) );

		$this->assertCount( 1, $this->pages->captured );
		$out = $this->pages->captured[0];
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( "ADD to crawl-4471:seen failed {$url}", $out[ Message::VALUE ] );
		$this->assertSame( $url, $out[ Message::KEY ] );
		$this->assertSame( [], $this->dispatched );
		$this->assertNull( $seen->lookup( $url ), 'nothing was recorded as seen' );
	}

	public function test_a_seed_is_normalized_as_a_link_is(): void {
		$crawler = $this->crawler();

		$this->in_drain( fn () => $this->seed( $crawler, 'HTTPS://Site-5531.Example:443#top' ) );
		$this->complete( self::SITE . '/', $this->links_body( '/', self::SITE . '/#again' ) );

		$this->assertSame( [ self::SITE . '/' ], $this->dispatched, 'the home page is fetched once' );
	}

	public function test_a_reseed_of_an_answered_url_says_it_was_already_seen(): void {
		$crawler = $this->crawler();
		$url     = self::SITE . '/again-63';
		$this->in_drain( fn () => $this->seed( $crawler, $url ) );
		$this->complete( $url, $this->links_body( '/again-63', '/again-63#self' ) );
		$this->assertSame( [ Message::TM_BYTESTREAM ], \array_column( $this->pages->captured, Message::TYPE ), 'a link already seen stays silent' );

		$message                = $this->seed_message( "  {$url}#top\n" );
		$message[ Message::TO ] = 'leftover-31';
		$this->in_drain( static fn () => $crawler->fill( $message ) );

		$this->assertCount( 2, $this->pages->captured );
		$out = $this->pages->captured[1];
		$this->assertSame( Message::TM_INFO, $out[ Message::TYPE ] );
		$this->assertSame( "already seen {$url}", $out[ Message::VALUE ] );
		$this->assertSame( $url, $out[ Message::KEY ] );
		$this->assertSame( 'seeder-3381', $out[ Message::FROM ] );
		$this->assertSame( [ $url ], $this->dispatched, 'Curl fetches it once' );
	}

	public function test_seeds_on_two_origins_each_carry_their_own_groups_credential(): void {
		$this->seed_vault_servers(
			[
				'site-a' => [ 'url' => self::SITE, 'auth_username' => 'svc-a19', 'auth_password' => 'pw-a28', 'group' => 'crawl-g7' ],
				'site-b' => [ 'url' => 'https://other-7710.example:9443', 'auth_username' => 'svc-b37', 'auth_password' => 'pw-b46', 'group' => 'crawl-g7' ],
			]
		);
		$crawler = $this->crawler( 'crawl-4471', '7203', 'crawl-g7', '0', '3' );

		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/a-1' ) );
		$this->in_drain( fn () => $this->seed( $crawler, 'https://other-7710.example:9443/b-2' ) );
		$this->in_drain( fn () => $this->seed( $crawler, 'https://bare-8820.example/c-3' ) );

		$auth = fn ( string $url ): array => \array_values( \array_filter( $this->opts[ $url ][ \CURLOPT_HTTPHEADER ] ?? [], static fn ( string $h ): bool => \str_starts_with( $h, 'Authorization:' ) ) );
		$this->assertSame( [ 'Authorization: ' . Vault::credential_header( 'svc-a19', 'pw-a28' ) ], $auth( self::SITE . '/a-1' ) );
		$this->assertSame( [ 'Authorization: ' . Vault::credential_header( 'svc-b37', 'pw-b46' ) ], $auth( 'https://other-7710.example:9443/b-2' ) );
		$this->assertSame( [], $auth( 'https://bare-8820.example/c-3' ), 'an origin outside the group goes bare' );
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
		$crawler = $this->wide();
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
		$crawler = $this->wide();
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
		$crawler = $this->wide();
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
		$crawler = $this->wide();
		$this->seen( $crawler )->add_members(
			[
				'inflight' => [ [ self::SITE . '/f-1' => 1, self::SITE . '/f-2' => 1 ], 900 ],
				'pending'  => [ [ self::SITE . '/f-3' => 1 ], 900 ],
			]
		);
		$crawler->remove_node();

		$crawler = $this->wide();
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ self::SITE . '/f-1', self::SITE . '/f-2', self::SITE . '/f-3' ], $this->dispatched, 'the first tick fetches all three' );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( 3, $this->dispatched, 'the second tick adds nothing' );
	}

	public function test_a_recovery_the_table_does_not_answer_is_retried_next_tick(): void {
		$crawler = $this->wide();
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
		$crawler = $this->wide();
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/r-{$i}", \range( 1, Table_Node::MAX_MEMBERS_LIMIT + 3 ) );
		$this->seen( $crawler )->add_members( [ 'inflight' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );
		$crawler->remove_node();
		$crawler = $this->wide();

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->dispatched );
		$this->assertCount( Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'inflight' ), 'only the fetches in flight remain there' );
		$this->assertCount( Table_Node::MAX_MEMBERS_LIMIT + 3 - Curl_Node::MAX_IN_FLIGHT, $this->members( $crawler, 'pending' ) );
	}

	/** Every request the crawler's Table has answered, across its verbs. */
	private function table_calls( Crawler_Node $crawler ): int {
		return \array_sum( \array_column( $this->seen( $crawler )->stats(), 'calls' ) );
	}

	/** Fire the crawler's tick $times times, each inside a drain. */
	private function ticks( Crawler_Node $crawler, int $times ): void {
		for ( $i = 0; $i < $times; $i++ ) {
			$this->in_drain( static fn () => $crawler->fire_cb() );
		}
	}

	/** Answer every dispatch at once with a TM_ERROR, as a failed curl_init does. */
	private function answer_every_dispatch_at_once(): void {
		Event_Framework::$curl_dispatch = function ( array $opts ): bool {
			$this->dispatched[] = (string) $opts[ \CURLOPT_URL ];
			return false;
		};
	}

	public function test_an_idle_crawler_asks_the_table_nothing_after_its_first_tick(): void {
		$crawler = $this->wide();

		$this->ticks( $crawler, 1 );
		$this->assertSame( 2, $this->table_calls( $crawler ), 'the recovery and one move' );
		$this->ticks( $crawler, 37 );

		$this->assertSame( 2, $this->table_calls( $crawler ), 'nothing is pending, so no tick asks' );
		$this->assertSame( [], $this->dispatched );
	}

	public function test_seeds_are_refilled_tick_by_tick_until_pending_drains_then_the_ticks_go_quiet(): void {
		$this->answer_every_dispatch_at_once();
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '0', '3' );
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/h-{$i}", \range( 1, 5 ) );
		foreach ( $urls as $url ) {
			$this->seed( $crawler, $url );
		}

		$this->ticks( $crawler, 2 );
		$this->assertSame( $urls, $this->dispatched, 'two ticks drain five urls three at a time' );
		$this->assertSame( [], $this->members( $crawler, 'pending' ) );
		$calls = $this->table_calls( $crawler );
		$this->ticks( $crawler, 23 );

		$this->assertSame( $calls, $this->table_calls( $crawler ), 'a drained frontier asks nothing' );
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/h-6' ) );
		$this->assertSame( [ ...$urls, self::SITE . '/h-6' ], $this->dispatched, 'a new seed wakes it' );
	}

	public function test_a_restarted_crawler_recovers_inflight_on_its_first_tick_then_goes_quiet(): void {
		$crawler = $this->wide();
		$url     = self::SITE . '/left-71';
		$this->seen( $crawler )->add_members( [ 'inflight' => [ [ $url => 1 ], 900 ] ] );
		$crawler->remove_node();
		$crawler = $this->wide();

		$this->ticks( $crawler, 1 );
		$this->assertSame( [ $url ], $this->dispatched, 'the first tick recovers and fetches it' );
		$calls = $this->table_calls( $crawler );
		$this->ticks( $crawler, 19 );

		$this->assertSame( $calls, $this->table_calls( $crawler ) );
	}

	public function test_a_move_short_of_its_ask_stops_the_next_tick_asking(): void {
		$crawler = $this->wide();
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/k-{$i}", \range( 1, 3 ) );
		$this->seen( $crawler )->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );

		$this->ticks( $crawler, 1 );
		$this->assertSame( $urls, $this->dispatched, 'sixteen asked, three moved' );
		$moves = $this->seen( $crawler )->stats()['SMOVE']['calls'];
		$this->ticks( $crawler, 11 );

		$this->assertSame( $moves, $this->seen( $crawler )->stats()['SMOVE']['calls'], 'thirteen free slots, and no ask' );
	}

	public function test_a_move_the_table_leaves_unanswered_is_asked_again_next_tick(): void {
		$crawler = $this->wide();
		$url     = self::SITE . '/unanswered-58';
		$seen    = $this->seen( $crawler );
		$seen->add_members( [ 'pending' => [ [ $url => 1 ], 900 ] ] );
		$refill = static fn ( mixed $value ): bool => \is_string( $value ) && \str_contains( $value, ' pending inflight' );
		Core::register_node( 'crawl-4471:seen', new Crawler_Filtering_Table_Fixture_Node( $seen, $refill ) );

		$this->ticks( $crawler, 1 );
		$this->assertSame( [], $this->dispatched, 'the move went unanswered' );
		Core::register_node( 'crawl-4471:seen', $seen );
		$this->ticks( $crawler, 1 );

		$this->assertSame( [ $url ], $this->dispatched );
	}

	public function test_an_idle_crawler_under_a_delay_asks_the_table_nothing(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '350', '2' );
		$this->assertSame( 'event_framework', $crawler->timer_mode() );

		$this->ticks( $crawler, 1 );
		$calls = $this->table_calls( $crawler );
		$this->ticks( $crawler, 41 );

		$this->assertSame( $calls, $this->table_calls( $crawler ) );
		$this->assertSame( [], $this->dispatched );
	}

	public function test_a_seed_before_the_first_tick_is_fetched_exactly_once(): void {
		$crawler = $this->wide();
		$this->seen( $crawler )->add_members( [ 'inflight' => [ [ self::SITE . '/f-1' => 1 ], 900 ] ] );
		$crawler->remove_node();
		$crawler = $this->wide();

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
		$crawler = $this->crawler( 'crawl-4471', '86400', 'crawl-g7' );

		$this->assertSame(
			"make_node Crawler crawl-4471 86400 crawl-g7\nconnect_node crawl-4471 pages-6219\n",
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

	public function test_concurrency_three_keeps_three_transfers_in_flight(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '0', '3' );
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );
		$paths = \array_map( static fn ( int $i ): string => "/c-{$i}", \range( 1, 40 ) );

		$this->complete( self::SITE . '/', $this->links_body( ...$paths ) );

		$curl = Core::node( 'crawl-4471:curl' );
		$this->assertInstanceOf( Curl_Node::class, $curl );
		$this->assertCount( 4, $this->dispatched, 'three starts after the seed' );
		$this->assertSame( 3, $curl->transfers_in_flight(), 'three live transfers' );
		$this->assertCount( 3, $this->members( $crawler, 'inflight' ) );
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$this->assertCount( 4, $this->dispatched, 'a tick with three in flight starts none' );

		$this->complete( $this->dispatched[2] );

		$this->assertCount( 5, $this->dispatched, 'one answer starts exactly one more' );
		$this->assertSame( 3, $curl->transfers_in_flight() );
	}

	public function test_the_default_concurrency_keeps_one_transfer_in_flight(): void {
		$crawler = $this->crawler();
		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );

		$this->complete( self::SITE . '/', $this->links_body( '/d-1', '/d-2', '/d-3' ) );

		$this->assertSame( [ self::SITE . '/', self::SITE . '/d-1' ], $this->dispatched );
		$this->assertSame( 1, Core::node( 'crawl-4471:curl' )?->transfers_in_flight() );
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$this->assertCount( 2, $this->dispatched, 'a tick with one in flight starts none' );

		$this->complete( self::SITE . '/d-1' );

		$this->assertSame( [ self::SITE . '/', self::SITE . '/d-1', self::SITE . '/d-2' ], $this->dispatched );
	}

	public function test_a_delay_spaces_starts_on_the_driven_clock(): void {
		$this->use_loop_time();
		$starts                         = [];
		Event_Framework::$curl_dispatch = function ( array $opts ) use ( &$starts ): bool {
			$this->dispatched[] = (string) $opts[ \CURLOPT_URL ];
			$starts[]           = Core::$now;
			return false;
		};
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '750', '3' );
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/t-{$i}", \range( 1, 6 ) );
		$this->seen( $crawler )->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );
		$this->assertSame( 'event_framework', $crawler->timer_mode() );
		$this->assertSame( 750, $crawler->interval_ms );

		$ticks = 0;
		Event_Framework::instance()->drain( fn (): bool => \count( $this->dispatched ) < 4 && ++$ticks < 40 );

		$this->assertCount( 4, $this->dispatched );
		foreach ( [ 1, 2, 3 ] as $i ) {
			$gap = $starts[ $i ] - $starts[ $i - 1 ];
			$this->assertGreaterThanOrEqual( 0.749, $gap, "start {$i} waits the delay" );
			$this->assertLessThan( 0.8, $gap, "start {$i} waits no longer" );
		}
	}

	public function test_under_a_delay_only_the_tick_starts_a_fetch(): void {
		$crawler     = $this->crawler( 'crawl-4471', '7203', '', '750', '3' );
		Core::$clock = static fn (): float => 1790000000.0;

		$this->in_drain( fn () => $this->seed( $crawler, self::SITE . '/' ) );
		$this->assertSame( [], $this->dispatched, 'a seed waits for the tick' );
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$this->assertSame( [ self::SITE . '/' ], $this->dispatched );

		Core::$clock = static fn (): float => 1790000000.75;
		$this->complete( self::SITE . '/', $this->links_body( '/u-1', '/u-2' ) );
		$this->assertCount( 1, $this->dispatched, 'an answer waits for the tick' );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertSame( [ self::SITE . '/', self::SITE . '/u-1' ], $this->dispatched, 'one start a tick' );
	}

	public function test_a_retuned_delay_still_spaces_the_next_start_from_the_last(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '2000', '3' );
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/g-{$i}", \range( 1, 3 ) );
		$this->seen( $crawler )->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );
		$this->assertSame( 'router', $crawler->timer_mode() );
		$at = static function ( float $now ): void {
			Core::$clock = static fn (): float => $now;
		};

		$at( 1790000000.0 );
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$crawler->arguments( [ '7203', '', '3000', '3' ] );
		$at( 1790000000.5 );
		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( 1, $this->dispatched, 'the retuned timer waits 3s from its last fire' );
		$at( 1790000003.5 );
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$this->assertCount( 2, $this->dispatched );
	}

	public function test_a_zero_delay_starts_back_to_back_on_the_refill_tick(): void {
		$starts                         = [];
		$inner                          = Event_Framework::$curl_dispatch;
		Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$starts, $inner ): \CurlHandle {
			$starts[] = Core::$now;
			return $inner( $opts );
		};
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '0', '3' );
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/z-{$i}", \range( 1, 5 ) );
		$this->seen( $crawler )->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );

		$this->in_drain( static fn () => $crawler->fire_cb() );

		$this->assertCount( 3, $starts );
		$this->assertCount( 1, \array_unique( $starts ), 'three starts on one tick' );
		$this->assertSame( 'router', $crawler->timer_mode(), 'no timer of its own' );
		$this->assertSame( Crawler_Node::TICK_MS, $crawler->interval_ms );
	}

	public function test_a_pacing_replay_keeps_the_siblings_and_retunes(): void {
		$crawler = $this->crawler();
		$curl    = Core::node( 'crawl-4471:curl' );
		$seen    = $this->seen( $crawler );
		$urls    = \array_map( static fn ( int $i ): string => self::SITE . "/v-{$i}", \range( 1, 5 ) );
		$seen->add_members( [ 'pending' => [ \array_fill_keys( $urls, 1 ), 900 ] ] );

		$crawler->arguments( [ '7203', '', '750', '3' ] );

		$this->assertSame( $curl, Core::node( 'crawl-4471:curl' ), 'the siblings stand' );
		$this->assertSame( $seen, $this->seen( $crawler ) );
		$this->assertSame( 'event_framework', $crawler->timer_mode() );
		$this->assertSame( 750, $crawler->interval_ms );
		$crawler->arguments( [ '7203', '', '0', '3' ] );
		$this->assertSame( 'router', $crawler->timer_mode() );
		$this->assertSame( Crawler_Node::TICK_MS, $crawler->interval_ms );
		$this->in_drain( static fn () => $crawler->fire_cb() );
		$this->assertCount( 3, $this->dispatched, 'the new concurrency fills the window' );
	}

	public function test_a_refused_replay_leaves_the_crawler_unchanged(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', '', '250', '2' );

		$why = $this->refusal( static fn () => $crawler->arguments( [ '7203', '', '250', '17' ] ) );

		$this->assertSame( "Bad arguments for Crawler 'crawl-4471': concurrency wants a whole number from 1 to 16, got '17'", $why );
		$this->assertSame( [ '7203', '', '250', '2' ], $crawler->arguments() );
		$this->assertSame( 250, $crawler->interval_ms );
	}

	public function test_a_delay_at_the_floor_takes_its_own_slot(): void {
		$crawler = $this->crawler( 'crawl-4471', '7203', '', (string) Crawler_Node::MIN_DELAY_MS, '1' );

		$this->assertSame( 100, Crawler_Node::MIN_DELAY_MS );
		$this->assertSame( 'event_framework', $crawler->timer_mode() );
		$this->assertSame( Crawler_Node::MIN_DELAY_MS, $crawler->interval_ms );
	}

	public function test_dump_config_round_trips_both_settings(): void {
		$crawler = $this->crawler( 'crawl-4471', '86400', 'crawl-g7', '750', '3' );

		$dump = $crawler->dump_config();
		$this->assertSame( "make_node Crawler crawl-4471 86400 crawl-g7 750 3\nconnect_node crawl-4471 pages-6219\n", $dump );
		$crawler->remove_node();
		$replayed = $this->crawler( 'crawl-4471', ...\array_slice( \explode( ' ', \strtok( $dump, "\n" ) ), 3 ) );
		$this->assertSame( $dump, $replayed->dump_config() );
		$this->assertSame( 750, $replayed->interval_ms );
	}

	/** The message, unescaped, of the refusal $fn throws. */
	private function refusal( callable $fn ): string {
		try {
			$fn();
		} catch ( \InvalidArgumentException $e ) {
			return \html_entity_decode( $e->getMessage(), \ENT_QUOTES );
		}
		$this->fail( 'nothing was refused' );
	}

	/** @return array<string,array{0:string,1:string,2:string}> */
	public static function bad_settings(): array {
		return [
			'a delay in words'      => [ 'soon', '1', "delay_ms wants a whole number, got 'soon'" ],
			'a negative delay'      => [ '-5', '1', "delay_ms wants a whole number, got '-5'" ],
			'a concurrency in words' => [ '0', 'many', "concurrency wants a whole number, got 'many'" ],
			'no concurrency'        => [ '0', '0', "concurrency wants a whole number from 1 to 16, got '0'" ],
			'too much concurrency'  => [ '0', '17', "concurrency wants a whole number from 1 to 16, got '17'" ],
			'a delay under the floor' => [ '5', '1', "delay_ms wants 0, or a whole number from 100 up, got '5'" ],
			'a delay just under it' => [ '99', '1', "delay_ms wants 0, or a whole number from 100 up, got '99'" ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'bad_settings' )]
	public function test_make_node_refuses_a_bad_setting( string $delay, string $concurrency, string $why ): void {
		$refusal = $this->refusal( fn () => $this->crawler( 'crawl-4471', '7203', '', $delay, $concurrency ) );

		$this->assertSame( "Bad arguments for Crawler 'crawl-4471': {$why}", $refusal );
		$this->assertNull( Core::node( 'crawl-4471:seen' ) );
	}

	public function test_node_schema_declares_the_four_arguments_and_no_verbs(): void {
		$crawler = $this->crawler();
		$schema  = Crawler_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertTrue( $schema['has_target'] );
		$this->assertSame( [ 'ttl', 'vault_group', 'delay_ms', 'concurrency' ], \array_column( $schema['arguments'], 'name' ) );
		$this->assertSame( [ 'int', 'vault_group', 'int', 'int' ], \array_column( $schema['arguments'], 'type' ) );
		$this->assertSame( [ '', 0, 1 ], \array_column( $schema['arguments'], 'default' ) );
		$this->assertTrue( $schema['arguments'][0]['required'] );
		$this->assertSame( [], $schema['commands'] );
		$this->assertNull( Core::node( "{$crawler->name()}:config" ), 'no verb, no config interpreter' );
	}
}
