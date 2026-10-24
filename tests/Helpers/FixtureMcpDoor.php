<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Mcp_Door;

/**
 * A door over `Fixture_Mcp_CI_Node`, mounted as `fixture-mcp`. It takes its
 * REST namespace in its constructor, so one class serves two doors, and reads
 * `{span}` from `$span` when the tools are listed.
 */
class Fixture_Mcp_Door extends Mcp_Door {

	/** The node every fixture tool fronts. */
	private const CI = [
		'node'  => 'fixture-mcp',
		'class' => Fixture_Mcp_CI_Node::class,
	];

	/** What `{span}` reads as; a test changes it after construction. */
	public string $span = '37';

	public function __construct( private string $namespace ) {}

	protected function rest_namespace(): string {
		return $this->namespace;
	}

	protected function tools(): array {
		return [
			'fixture_echo' => self::CI + [
				'verb'    => 'echo_args',
				'summary' => 'Echo the arguments over the last {span} fixture slots.',
				'args'    => [
					'word'  => '{declared} Over {span} slots.',
					'count' => 'How many times.',
					'tags'  => 'Tags, one token each.',
				],
			],
			'fixture_poke' => self::CI + [
				'verb'    => 'poke',
				'summary' => 'Poke the fixture.',
				'args'    => [],
			],
			'fixture_wipe' => self::CI + [
				'verb'    => 'wipe',
				'summary' => 'Wipe the fixture.',
				'args'    => [],
			],
		];
	}

	protected function instructions(): string {
		return 'Fixture tools echo what they are given.';
	}

	protected function caveat(): string {
		return 'Fixture caveat: nothing here is measured.';
	}

	protected function fills(): array {
		return [ '{span}' => $this->span ];
	}

	protected function server_info(): array {
		return [ 'name' => 'fixture-door', 'version' => '9.4.1' ];
	}
}
