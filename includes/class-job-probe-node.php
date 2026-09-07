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
 * into the shared `jobstats` log where one Consumer yields one, and each record
 * carries a free-text last-run message. That message is why this is the only
 * probe that trims a record to fit the PIPE_BUF cap.
 *
 * `topologies/job-worker.tsl` mounts the sweep beside the workers it claims and
 * sinks it into `jobstats.p0`, the one log every job-worker partition appends to.
 */
class Job_Probe_Node extends Probe_Node {

	/**
	 * Claim every Job_Worker in this process. A worker that has run no job yet
	 * holds an empty accumulator and yields nothing.
	 *
	 * @param Node $node A node from this process's registry.
	 * @return array<int,array<int,int|string>> One Jobstats_Record per job identity.
	 */
	protected function probe( Node $node ): array {
		if ( ! $node instanceof Job_Worker_Node ) {
			return [];
		}
		return $node->probe_stats();
	}

	/**
	 * Halve the last-run message until the packed record fits the PIPE_BUF cap. A
	 * handler's message is arbitrary text, so it is the one field worth sacrificing
	 * to keep the record writable; a record that will not fit even with that field
	 * emptied is dropped loud rather than emitted for Partition to refuse. The drop
	 * names the identity, but `print_less_often()` keys on the head text alone, so
	 * one throttle window names a single offender.
	 *
	 * @param array<int,mixed> $message The minted record message.
	 * @return array<int,mixed>|null The message to emit, or null to drop it.
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

	/**
	 * Topology console manifest: the `Monitor` palette entry and the one
	 * `interval_s` positional, which replaces the `interval_ms` Timer_Node
	 * declares because the merge takes `arguments` whole. Declaring it here is
	 * the whole parse — ADR-11 puts defaults and coercion in
	 * `parse_schema_args()`, and `Probe_Node::arguments()` calls that before
	 * arming the sweep timer.
	 *
	 * @return array<string,mixed>
	 */
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
