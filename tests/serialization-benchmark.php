<?php
/**
 * Serialization throughput benchmark — port of Tachikoma's
 * examples/benchmarks/serialization.
 *
 * Sweeps payload sizes 64B -> 1MB (doubling) and measures Message::packed()
 * (pack) and Message::unpacked() (unpack) throughput at each size.
 *
 * Run inside live WordPress so Message, wp_json_encode, and ABSPATH are real:
 *   wp eval-file tests/serialization-benchmark.php
 *
 * It is a timing-driven benchmark, not a PHPUnit test — no assertions.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \class_exists( '\Newspack_Nodes\Message' ) ) {
	\fwrite( \STDERR, "Newspack_Nodes\\Message not loaded — run via `wp eval-file` with the plugin active.\n" );
	exit( 1 );
}

$total    = 10000;
$buf_size = 64;
$delay    = 1;

// Fixed JSON-envelope overhead with an empty VALUE; subtracted so each filled
// payload lands near its target buf_size. Tachikoma hardcodes 20 for its binary
// header, but JSON's wrapper plus a real timestamp differ — so measure it rather
// than guess. A '.' fills VALUE: one unescaped byte, unlike a NUL, which JSON
// would balloon to a 6-char escape, turning the sweep into an escape-bloat test.

while ( $buf_size <= 1048576 ) {
	$message  = base_message();
	$overhead = \strlen( Message::packed( $message ) );
	$fill     = \max( 1, $buf_size - $overhead );

	$message[ Message::VALUE ] = \str_repeat( '.', $fill );

	$packed = Message::packed( $message );
	$size   = \strlen( $packed );
	echo "\nsize: $size\n";
	check_pack( $message, $size, $total, $delay );
	check_unpack( $packed, $size, $total, $delay );
	$buf_size *= 4;
}

/** A TM_BYTESTREAM message with an empty VALUE. */
function base_message(): array {
	$message                  = Message::new_message();
	$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
	return $message;
}

/** @param array<int, mixed> $message */
function check_pack( array $message, int $size, int $total, int $delay ): void {
	$check = 0;
	$count = 0;
	$then  = \microtime( true );
	while ( true ) {
		Message::packed( $message );
		if ( $check++ >= $total ) {
			$span   = \microtime( true ) - $then;
			$count += $check;
			if ( $span >= $delay ) {
				report( 'pack', $count, $size, $span );
				break;
			}
			$check = 0;
		}
	}
}

function check_unpack( string $packed, int $size, int $total, int $delay ): void {
	$check = 0;
	$count = 0;
	$then  = \microtime( true );
	while ( true ) {
		Message::unpacked( $packed );
		if ( $check++ >= $total ) {
			$span   = \microtime( true ) - $then;
			$count += $check;
			if ( $span >= $delay ) {
				report( 'unpack', $count, $size, $span );
				break;
			}
			$check = 0;
		}
	}
}

function report( string $type, int $count, int $size, float $span ): void {
	\printf(
		"%6s %.2f MB per second - %.2f messages per second\n",
		$type,
		$count * $size / 1024 / 1024 / $span,
		$count / $span
	);
}
