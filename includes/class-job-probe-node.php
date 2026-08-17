<?php
/**
 * Job_Probe: the Job_Worker-stats sweep. See Probe_Node for the sweep itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Job_Probe: the Job_Worker-stats sweep, the jobs analog of Topic_Probe. A
 * Job_Worker owns many job IDENTITIES, so one swept worker yields MANY records
 * into the shared `jobstats` log where one Consumer yields one, and each carries
 * a free-text last-run message that has to be trimmed to stay under PIPE_BUF.
 */
class Job_Probe_Node extends Probe_Node {

	/** Every Job_Worker; one with no runs yet has an empty accumulator. */
	protected function probe( Node $node ): array {
		if ( ! $node instanceof Job_Worker_Node ) {
			return [];
		}
		return $node->probe_stats();
	}

	/**
	 * A handler's last-run message is arbitrary text, so it is the one field worth
	 * sacrificing to keep the record writable; a record that will not fit even
	 * emptied is dropped loud rather than emitted for Partition to refuse.
	 */
	protected function fit_to_line( array $message ): ?array {
		$fitted = Line_Fitter::fit( $message, [ Jobstats_Record::LAST_MESSAGE ] );
		if ( null === $fitted ) {
			$record = $message[ Message::VALUE ];
			$key    = \is_array( $record ) ? Core::as_string( $record[ Jobstats_Record::IDENTITY ] ?? '' ) : '';
			$this->print_less_often( 'Job_Probe dropped an unfittable record: ', $key );
		}
		return $fitted;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Monitor',
			'description' => 'Sweeps every Job_Worker in this process every N seconds; emits one stats snapshot (runs, errors, durations, last-run) per job identity into the jobstats log.',
			'arguments'   => [
				[ 'name' => 'interval_s', 'type' => 'int', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Sweep cadence in seconds between Job_Worker-stats snapshots; empty or absent defaults to 15.' ],
			],
		] );
	}
}
