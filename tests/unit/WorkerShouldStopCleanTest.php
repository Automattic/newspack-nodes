<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Worker_Should_Stop_Clean::class )]
class WorkerShouldStopCleanTest extends TestCase {

	public function test_clean_stop_is_a_worker_should_stop(): void {
		// A broad `catch ( Worker_Should_Stop )` (ADR-14) must still catch the clean
		// variant, so every existing cooperative-stop path keeps working unchanged;
		// only code that explicitly distinguishes the subtype acts on it.
		$this->assertInstanceOf( Worker_Should_Stop::class, new Worker_Should_Stop_Clean() );
	}
}
