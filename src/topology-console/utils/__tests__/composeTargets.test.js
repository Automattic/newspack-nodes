import { buildComposeTargets } from '../composeTargets';
import names from '../../../runtime/reserved-node-names.json';

describe( 'buildComposeTargets', () => {
	it( 'puts _command_interpreter first, then each node id and — only when has_config — its :config sidecar, sorted', () => {
		const nodes = [
			{ id: 'echo', has_config: true },
			{ id: 'tee_a', has_config: true },
		];
		expect( buildComposeTargets( nodes ) ).toEqual( [
			names.COMMAND_INTERPRETER,
			'echo',
			'echo:config',
			'tee_a',
			'tee_a:config',
		] );
	} );

	it( 'omits the :config sidecar for a node that has none (has_config falsey)', () => {
		const nodes = [
			{ id: 'echo', has_config: false },
			{ id: 'plain' }, // no flag at all
			{ id: 'tee_a', has_config: true },
		];
		expect( buildComposeTargets( nodes ) ).toEqual( [
			names.COMMAND_INTERPRETER,
			'echo',
			'plain',
			'tee_a',
			'tee_a:config',
		] );
	} );

	it( 'still leads with _command_interpreter when nodes is empty', () => {
		expect( buildComposeTargets( [] ) ).toEqual( [
			names.COMMAND_INTERPRETER,
		] );
	} );

	it( 'handles a missing/undefined nodes array', () => {
		expect( buildComposeTargets( undefined ) ).toEqual( [
			names.COMMAND_INTERPRETER,
		] );
	} );

	it( 'de-dupes and drops a redundant _command_interpreter entry from nodes', () => {
		const nodes = [
			{ id: names.COMMAND_INTERPRETER },
			{ id: 'echo', has_config: true },
		];
		expect( buildComposeTargets( nodes ) ).toEqual( [
			names.COMMAND_INTERPRETER,
			'echo',
			'echo:config',
		] );
	} );

	it( 'skips nodes with no id', () => {
		const nodes = [ { id: '' }, { id: 'echo', has_config: true }, {} ];
		expect( buildComposeTargets( nodes ) ).toEqual( [
			names.COMMAND_INTERPRETER,
			'echo',
			'echo:config',
		] );
	} );
} );
