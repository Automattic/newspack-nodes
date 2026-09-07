<?php
/**
 * Newspack_Log: egress into the sanctioned Newspack observability pipeline.
 *
 * fill() fires `do_action( 'newspack_log', $code, $text, $params )`. Newspack
 * Manager listens and, at log_level >= 2, ships the entry fire-and-forget over
 * the Jetpack connection to WPCOM, where logstash indexes it (`log2logstash`)
 * for Kibana and Grafana. The action is meant to be called bare: with no
 * Manager installed nothing listens and the call is a silent no-op, so a
 * topology carrying this node costs a self-hosted stack nothing.
 *
 * A topology wires `Probe_To_Graphite_Node` into this node to land the same
 * plaintext lines `Graphite_Node` ships over UDP, or wires a `Tee` in front to
 * send them both ways. Any other producer's records are taken the same way.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Newspack_Log node — `make_node Newspack_Log <name> <code>`.
 *
 * A terminus: fill() hands the record to WordPress and forwards nothing, so it
 * needs no sink.
 */
class Newspack_Log_Node extends Node {
	use Schema_Reflection;

	/**
	 * The code every entry is filed under, and the field Kibana filters by.
	 * arguments() derives it from the first token; empty until then.
	 */
	private string $code = '';

	/**
	 * `<code>` — required; the log entry code Kibana filters by.
	 *
	 * Every entry this node files carries the same code, and the code is what
	 * makes an entry findable, so an absent or blank token throws at make_node
	 * time rather than filing a worker's whole output under the empty string.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> The tokens as given.
	 * @throws \InvalidArgumentException When the code token is missing or blank.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->arguments = $args;
		$code            = Core::as_string( $args[0] ?? '', '' );
		if ( '' === $code ) {
			throw new \InvalidArgumentException( 'NewspackLog requires a code argument (the log entry code Kibana filters by)' );
		}
		$this->code = $code;
		return $args;
	}

	/**
	 * File the message VALUE as one `newspack_log` entry.
	 *
	 * Only TM_STRUCT and TM_BYTESTREAM are filed. Control messages — a TM_EOF
	 * drain, a TM_ERROR bounce — carry no record, and filing them would put
	 * transport noise in Kibana under a metrics code.
	 *
	 * The VALUE's own shape, not the type flag, picks the shape of the entry: an
	 * array rides as the entry's `data` with the code standing in as the message
	 * text, and anything else rides as the text itself, trailing newlines
	 * trimmed because a line producer terminates its payload and the entry text
	 * is not a file line. Every entry is typed `debug` at log_level 2, which
	 * ships to logstash without paging Slack — what a metrics feed wants.
	 *
	 * The counter advances on every accepted message, so `ls -c` reports what
	 * this node filed. Nothing reports back: do_action returns no disposition,
	 * and fill() has none to give (ADR-13).
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type = Core::as_int( $message[ Message::TYPE ], 0 );
		if ( ! ( $type & ( Message::TM_STRUCT | Message::TM_BYTESTREAM ) ) ) {
			return;
		}
		++$this->counter;
		$value  = $message[ Message::VALUE ];
		$params = [
			'type'      => 'debug',
			'log_level' => 2,
			'data'      => \is_array( $value ) ? $value : [],
		];
		$text   = \is_array( $value ) ? $this->code : \rtrim( Core::as_string( $value ), "\n" );
		\do_action( 'newspack_log', $this->code, $text, $params );
	}

	/**
	 * Palette entry and argument form for the topology console. `has_target` is
	 * false because the action is the terminus: there is nothing downstream to
	 * connect this node to.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Forwards records to the newspack_log action (Newspack Manager → logstash → Kibana/Grafana; no-op without Manager).',
			'arguments'   => [
				[ 'name' => 'code', 'type' => 'string', 'required' => true, 'description' => 'Log entry code (the Kibana filter key).' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => false,
		];
	}
}
