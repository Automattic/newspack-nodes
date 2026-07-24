<?php
/**
 * NewspackLog
 *
 * Egress into `do_action( 'newspack_log', $code, $message, $params )` — the
 * sanctioned Newspack observability pipeline. Newspack Manager listens and at
 * log_level >= 2 ships fire-and-forget over the Jetpack connection to WPCOM →
 * logstash → Kibana (`log2logstash` index) / Grafana. The hook is designed to
 * be called bare: with no Manager installed it is a silent no-op, so this
 * node costs nothing on self-hosted stacks.
 *
 * A TM_STRUCT VALUE rides as the entry's `data`; a TM_BYTESTREAM VALUE rides
 * as the message text. log_level 2 = ship to logstash, never page Slack.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * NewspackLog node.
 */
class Newspack_Log_Node extends Node {
	use Schema_Reflection;

	private string $code = '';

	/**
	 * `<code>` — required; the logstash `feature`-style code Kibana filters by.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException Without a code argument.
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
