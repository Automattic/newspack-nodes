<?php
namespace Newspack_Nodes\Tests;

class BoundedTicks {
	public static function callable( int $n ): callable {
		$remaining = $n;
		return function () use ( &$remaining ): bool {
			return $remaining-- > 0;
		};
	}
}
