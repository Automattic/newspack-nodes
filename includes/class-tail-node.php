<?php
/**
 * Tail: durable follower of a Log's `{file}.{seg}` segments.
 *
 * Reads through the inherited Consumer read model — the durable offsetlog
 * cursor, snapshot co-commit, segment roll, dead-letter quarantine and time
 * travel — and parts from Consumer at three seams declared below: it reads a
 * `Log` (`{file}.{seg}`) rather than a `Partition` (`{dir}/{seg}.log`), its
 * first argument is a source FILE base rather than a directory, and a fresh
 * reader with no durable cursor starts at END. `forward_line()` is the fourth
 * override: each complete line's raw bytes leave as a TM_BYTESTREAM instead of
 * an unpacked Message.
 *
 * That pairing with `Log_Node` is why both classes exist. A Log writes the
 * producer's own bytes, so a Tail hands a reader the lines an operator would
 * see in a pager; a Consumer over a Partition hands it the substrate's packed
 * envelopes, readable only by the substrate.
 *
 * `File_Tail_Node` is the sibling that follows a SINGLE filename with `tail -F`
 * logrotate semantics. It is a subclass rather than a mode flag on this class:
 * the two share the `Durable_Reader` line-assembly spine and the durable
 * offsetlog cursor, and differ only in the byte source.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Tail node — `make_node Tail <name> <source_file> [offsetlog_dir] [deadletter_dir]`.
 */
class Tail_Node extends Consumer_Node {

	/**
	 * Segmented source: the `{file}.{seg}` layout this class reads.
	 *
	 * Both tokens name a SOURCE, not a mode flag on this node. A `Log_Sources`
	 * registry entry carries one and `Log_Sources::open_tail()` is the single
	 * place it becomes a class, which is why `node_schema()` declares no `mode`
	 * argument for an operator to set.
	 */
	public const MODE_SEGMENTED = 'segmented';

	/** Single-filename source, opened as a `File_Tail_Node` with `tail -F` semantics. */
	public const MODE_FILE = 'file';

	/**
	 * Base path of the Log to follow; its segments are {source_file}.0, .1, ….
	 *
	 * `parse_schema_args()` assigns this from the first positional token, and
	 * `resolve_args()` hands it to Consumer, which stores the same string
	 * (trailing slash stripped) in `source_dir` and confines it with
	 * `Config::assert_within_base()`.
	 */
	protected string $source_file = '';

	/**
	 * Source seam: read a Log ({file}.{seg}), not a Partition ({dir}/{seg}.log).
	 * Both shapes are segmented and both rotate, so every part of the inherited
	 * read model that walks a segment list applies unchanged.
	 *
	 * @return Partition_Node The source node Consumer builds and publishes as its `source` sibling.
	 */
	protected function make_source(): Partition_Node {
		return new Log_Node();
	}

	/**
	 * Path seam: Tail's source path is `source_file`, a file base rather than a
	 * directory. Consumer keeps whatever comes back in `source_dir`, so the read
	 * model never branches on which of the two shapes it is pointed at.
	 *
	 * @return array{0:string,1:string} Source path, then offsetlog path.
	 */
	protected function resolve_args(): array {
		return [ $this->source_file, $this->offsetlog_dir ];
	}

	/**
	 * First-spawn seam: a fresh Tail with no durable cursor starts at END.
	 *
	 * A follower shows what arrives after it starts. Consumer's 0:0 would replay
	 * the whole retained log to a dashboard that asked only to watch. A durable
	 * checkpoint still outranks this, so a restart resumes instead of skipping.
	 *
	 * @return string|null The seek sentinel a fresh reader applies.
	 */
	protected function default_offset(): ?string {
		return 'end';
	}

	/**
	 * Emit seam: send one complete line's raw bytes — newline restored — as a
	 * TM_BYTESTREAM, in place of Consumer's unpack-a-Message forward. The buffer
	 * and cursor scan that hands over each line stays in
	 * `Durable_Reader::drain_buffer()`, so both source shapes reuse it and both
	 * get `line_mode` for free.
	 *
	 * FROM is stamped directly rather than through `stamp_message()` because a
	 * Tail is a source: it MINTS the trail at this I/O boundary instead of
	 * prepending itself to one a producer already wrote.
	 *
	 * The ID carries this reader's own position breadcrumb,
	 * `segment:offset:length` — in `File_Tail_Node` the inode rides the segment
	 * slot — which the browser's `SeekTracker` reads to tell when a replay has
	 * reached the live tail and to flip the view back to Live. Leave the ID empty
	 * and that flip never fires for a Tail-fed stream.
	 *
	 * @param string $line       One complete line, without its trailing newline.
	 * @param int    $abs_offset The line's start offset within the current segment or generation.
	 */
	protected function forward_line( string $line, int $abs_offset ): void {
		$bytes = $line . "\n";
		$size  = \strlen( $bytes );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::FROM ]      = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$message[ Message::ID ]        = "{$this->cursor_segment}:{$abs_offset}:{$size}";
		$message[ Message::VALUE ]     = $bytes;
		parent::fill( $message );
	}

	/**
	 * Topology console manifest: Consumer's, with argument 0 replaced.
	 *
	 * A Tail's first token is a file base rather than a partition directory. The
	 * offsetlog and dead-letter arguments, the verbs, the requests and the
	 * category stay Consumer's verbatim, so a seam added there reaches this class
	 * with no edit here.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$schema = parent::node_schema();
		$arguments      = Core::arr( $schema['arguments'] ?? [] );
		$arguments[0]   = [
			'name'        => 'source_file',
			'type'        => 'string',
			'required'    => true,
			'description' => 'Base path of the Log to poll ({source_file}.0, .1, …). Each complete line is emitted.',
		];
		return \array_merge( $schema, [
			'description' => 'Tails a Log\'s {file}.{seg} segments; emits each line as raw TM_BYTESTREAM bytes to its sink.',
			'arguments'   => \array_values( $arguments ),
		] );
	}
}
