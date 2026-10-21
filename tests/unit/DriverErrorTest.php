<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Driver_Error;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Driver_Error — a database driver's message as it may leave the site: its
 * code, and the message cut at its first quote, where the values the driver
 * echoes begin; a SIGNAL as its number alone; within 256 bytes.
 */
#[CoversClass( Driver_Error::class )]
final class DriverErrorTest extends TestCase {

	/**
	 * Code, message, and what may leave the site: `tests/fixtures/driver-error.json`,
	 * the case list gyrobase's `t/driver-error.t` reads from its own copy and
	 * dndocker's `tools/check-firehose-parity.py` holds identical.
	 *
	 * @return array<string,array{0: int|string|null, 1: string, 2: string}>
	 */
	public static function shapes(): array {
		$cases = \json_decode( (string) \file_get_contents( \dirname( __DIR__ ) . '/fixtures/driver-error.json' ), true );
		$out   = [];
		foreach ( $cases as $case ) {
			[ $label, $code, $message, $shaped ] = $case;
			// A case of raw bytes JSON cannot carry rides base64-encoded.
			if ( 'base64' === ( $case[4] ?? '' ) ) {
				[ $message, $shaped ] = [ \base64_decode( $message ), \base64_decode( $shaped ) ];
			}
			$out[ $label ] = [ $code, $message, $shaped ];
		}
		return $out;
	}

	/**
	 * A PHP fatal's message, and what may leave the site.
	 *
	 * @return array<string,array{0: string, 1: string}>
	 */
	public static function fatals(): array {
		return [
			'a value spelling a stack trace, mysqli' => [
				"Uncaught mysqli_sql_exception: Duplicate entry 'weka-7746@kea.test\nStack trace:x' for key 'k' in /srv/a.php:12\nStack trace:\n#0 /srv/a.php(12): mysqli_query(Object(mysqli), 'INSERT ...')\n#1 {main}\n  thrown",
				'Uncaught mysqli_sql_exception',
			],
			'a value spelling a stack trace, PDO' => [
				"Uncaught PDOException: SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'weka-7746@kea.test\nStack trace:x' for key 'k' in /srv/a.php:12\nStack trace:\n#0 /srv/a.php(12): PDOStatement->execute(Array)\n#1 {main}\n  thrown",
				'Uncaught PDOException: SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry',
			],
			'a PDO message with no quote keeps its text and drops the trace' => [
				"Uncaught PDOException: SQLSTATE[HY000] [2002] Connection refused in /srv/a.php:12\nStack trace:\n#0 /srv/a.php(12): PDO->__construct('mysql:host=kea-7746')\n#1 {main}\n  thrown",
				'Uncaught PDOException: SQLSTATE[HY000] [2002] Connection refused in /srv/a.php:12',
			],
			'a PDO message with no file line still drops the trace' => [
				"Uncaught PDOException: SQLSTATE[HY000] [2002] gone\nStack trace:\n#0 {main}",
				'Uncaught PDOException: SQLSTATE[HY000] [2002] gone',
			],
			'a fatal that is no uncaught exception drops its trace' => [
				"Allowed memory size of 134217728 bytes exhausted\nStack trace:\n#0 kea_7746('weka')",
				'Allowed memory size of 134217728 bytes exhausted',
			],
		];
	}

	#[DataProvider( 'fatals' )]
	public function test_a_fatal_keeps_none_of_its_values( string $fatal, string $shaped ): void {
		$this->assertSame( $shaped, Driver_Error::fatal( $fatal ) );
	}

	/** A wpdb's refusal is shaped by its own errno; no refusal reads empty. */
	public function test_of_wpdb_shapes_a_handles_last_error(): void {
		$db = new \stdClass();
		$db->last_error      = "Duplicate entry 'weka-7746@kea.test' for key 'user_email'";
		Driver_Error::$errno = static fn ( object $seen ): int => $seen === $db ? 1062 : 0;
		try {
			$this->assertSame( '[1062] Duplicate entry', Driver_Error::of_wpdb( $db ) );
			$db->last_error = '';
			$this->assertSame( '', Driver_Error::of_wpdb( $db ) );
		} finally {
			Driver_Error::$errno = null;
		}
	}

	#[DataProvider( 'shapes' )]
	public function test_a_driver_message_keeps_its_code_and_none_of_its_values( int|string|null $code, string $message, string $shaped ): void {
		$this->assertSame( $shaped, Driver_Error::shape( $code, $message ) );
	}

	public function test_a_long_message_is_capped_at_256_bytes(): void {
		$shaped = Driver_Error::shape( 1205, \str_repeat( 'kea lock wait 7746 ', 40 ) );

		$this->assertSame( 256, \strlen( $shaped ) );
		$this->assertStringStartsWith( '[1205] kea lock wait 7746 ', $shaped );
	}

	public function test_the_cap_falls_on_a_character_boundary(): void {
		$shaped = Driver_Error::shape( 1205, \str_repeat( '错', 200 ) );

		$this->assertLessThanOrEqual( 256, \strlen( $shaped ) );
		$this->assertGreaterThan( 250, \strlen( $shaped ) );
		$this->assertTrue( \mb_check_encoding( $shaped, 'UTF-8' ) );
	}

	public function test_a_pdo_exception_is_shaped_by_its_code(): void {
		$e = new \PDOException( "SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'weka-7746' for key 'k'", 23000 );

		$this->assertSame( '[23000] SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry', Driver_Error::of( $e ) );
	}

	public function test_a_mysqli_signal_keeps_its_number(): void {
		$this->assertSame( '[1644]', Driver_Error::of( new \mysqli_sql_exception( 'bad email weka@kea.test', 1644 ) ) );
	}

	public function test_a_driver_subclass_is_shaped(): void {
		$this->assertSame( '[1062] Duplicate entry', Driver_Error::of( new Kea_Driver_Exception( "Duplicate entry 'weka-7746' for key 'k'", 1062 ) ) );
	}

	public function test_any_other_throwable_keeps_its_message(): void {
		$this->assertSame( "kea 'quoted' stays 7746", Driver_Error::of( new \RuntimeException( "kea 'quoted' stays 7746" ) ) );
	}

	public function test_errno_reads_the_seam_given_the_handle(): void {
		$db               = new \stdClass();
		Driver_Error::$errno = static fn ( object $seen ): int => $seen === $db ? 1213 : 0;
		try {
			$this->assertSame( 1213, Driver_Error::errno( $db ) );
		} finally {
			Driver_Error::$errno = null;
		}
	}

	public function test_errno_of_a_handle_with_no_mysqli_connection_is_zero(): void {
		$this->assertSame( 0, Driver_Error::errno( new \stdClass() ) );
	}

	public function test_an_uncaught_driver_exception_keeps_its_class_and_the_cut(): void {
		$fatal = "Uncaught PDOException: SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'weka-7746@kea.test' for key 'user_email' in /srv/kea.php:12\nStack trace:\n#0 /srv/kea.php(12): PDOStatement->execute(Array)\n#1 {main}\n  thrown";

		$this->assertSame( 'Uncaught PDOException: SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry', Driver_Error::fatal( $fatal ) );
	}

	public function test_an_uncaught_signal_keeps_its_state(): void {
		$fatal = "Uncaught PDOException: SQLSTATE[45000]: <<Unknown error>>: 1644 bad email weka@kea.test in /srv/kea.php:12\nStack trace:\n#0 {main}\n  thrown";

		$this->assertSame( 'Uncaught PDOException: SQLSTATE[45000]', Driver_Error::fatal( $fatal ) );
	}

	/** A mysqli fatal prints no code, so a SIGNAL cannot be told: the class alone. */
	public function test_an_uncaught_mysqli_exception_keeps_its_class_alone(): void {
		$fatal = "Uncaught mysqli_sql_exception: bad email weka-7746@kea.test in /srv/kea.php:12\nStack trace:\n#0 {main}\n  thrown";

		$this->assertSame( 'Uncaught mysqli_sql_exception', Driver_Error::fatal( $fatal ) );
	}

	public function test_an_uncaught_driver_subclass_is_cut(): void {
		$fatal = 'Uncaught ' . Kea_Driver_Exception::class . ": Duplicate entry 'weka-7746' for key 'k' in /srv/kea.php:12\nStack trace:\n#0 {main}\n  thrown";

		$this->assertSame( 'Uncaught ' . Kea_Driver_Exception::class . ': Duplicate entry', Driver_Error::fatal( $fatal ) );
	}

	public function test_any_other_fatal_drops_its_stack_trace_and_keeps_its_message(): void {
		$fatal = "Uncaught RuntimeException: kea feed refused in /srv/kea.php:12\nStack trace:\n#0 /srv/kea.php(9): kea_import('weka-7746')\n#1 {main}\n  thrown";

		$this->assertSame( 'Uncaught RuntimeException: kea feed refused in /srv/kea.php:12', Driver_Error::fatal( $fatal ) );
	}
}

/** A driver exception's subclass, which the rule shapes as its parent. */
final class Kea_Driver_Exception extends \PDOException {
	/**
	 * A subclass carrying an errno, as an application's wrapper would.
	 *
	 * @param string $message The driver's message.
	 * @param int    $code    The driver's errno.
	 */
	public function __construct( string $message, int $code ) {
		parent::__construct( $message );
		$this->code = $code;
	}
}
