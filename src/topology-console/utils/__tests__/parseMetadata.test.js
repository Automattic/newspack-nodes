import { parseMetadata } from '../parseMetadata';

describe( 'parseMetadata', () => {
	it( 'returns empty graph for malformed input', () => {
		expect( parseMetadata( null ) ).toEqual( { nodes: [], edges: [] } );
		expect( parseMetadata( '' ) ).toEqual( { nodes: [], edges: [] } );
		expect( parseMetadata( 'not-json' ) ).toEqual( {
			nodes: [],
			edges: [],
		} );
	} );

	it( 'parses a JSON object payload directly', () => {
		const payload = {
			alpha: {
				class: 'Echo',
				counter: 42,
				sink: '_command_interpreter',
				target: 'beta',
				debug_state: 0,
				arguments: '',
			},
		};
		const { nodes, edges } = parseMetadata( payload );
		expect( nodes ).toEqual( [
			{
				id: 'alpha',
				count: 42,
				sink: '_command_interpreter',
				class: 'Echo',
				debugState: 0,
				arguments: '',
				lgstMsg: 0,
				bytesRead: 0,
				bytesWritten: 0,
			},
		] );
		expect( edges ).toEqual( [ { from: 'alpha', to: 'beta' } ] );
	} );

	it( 'parses an array target (Tee) into multiple edges', () => {
		const { edges } = parseMetadata( {
			tee: {
				class: 'Tee',
				counter: 10,
				sink: '_command_interpreter',
				target: [ 'a', 'b', 'c' ],
				debug_state: 0,
				arguments: '',
			},
		} );
		expect( edges ).toEqual( [
			{ from: 'tee', to: 'a' },
			{ from: 'tee', to: 'b' },
			{ from: 'tee', to: 'c' },
		] );
	} );

	it( 'excludes scaffolding nodes (_command_interpreter, _router, _output, _repl)', () => {
		const { nodes } = parseMetadata( {
			_command_interpreter: { class: 'CommandInterpreter', counter: 1 },
			_router: { class: 'Router', counter: 1 },
			_output: { class: 'Partition', counter: 1 },
			_repl: { class: 'Partition', counter: 1 },
			'firehose:tee': {
				class: 'Tee',
				counter: 99,
				sink: '_command_interpreter',
				target: [],
				debug_state: 0,
				arguments: '',
			},
		} );
		expect( nodes.map( ( n ) => n.id ) ).toEqual( [ 'firehose:tee' ] );
	} );

	it( 'preserves debugState for downstream inspector use', () => {
		const { nodes } = parseMetadata( {
			alpha: {
				class: 'Echo',
				counter: 1,
				sink: '',
				target: '',
				debug_state: 1,
				arguments: '',
			},
			beta: {
				class: 'Echo',
				counter: 1,
				sink: '',
				target: '',
				debug_state: 0,
				arguments: '',
			},
		} );
		expect( nodes.find( ( n ) => n.id === 'alpha' ).debugState ).toBe( 1 );
		expect( nodes.find( ( n ) => n.id === 'beta' ).debugState ).toBe( 0 );
	} );

	it( 'exposes lgst_msg / bytes_read / bytes_written from the payload', () => {
		const { nodes } = parseMetadata( {
			alpha: {
				class: 'Echo',
				counter: 1,
				sink: '',
				target: '',
				debug_state: 0,
				arguments: '',
				lgst_msg: 1234,
				bytes_read: 5678,
				bytes_written: 9012,
			},
		} );
		const alpha = nodes.find( ( n ) => n.id === 'alpha' );
		expect( alpha.lgstMsg ).toBe( 1234 );
		expect( alpha.bytesRead ).toBe( 5678 );
		expect( alpha.bytesWritten ).toBe( 9012 );
	} );

	it( 'defaults new counters to 0 when payload omits them', () => {
		const { nodes } = parseMetadata( {
			alpha: {
				class: 'Echo',
				counter: 0,
				sink: '',
				target: '',
				debug_state: 0,
				arguments: '',
			},
		} );
		const alpha = nodes.find( ( n ) => n.id === 'alpha' );
		expect( alpha.lgstMsg ).toBe( 0 );
		expect( alpha.bytesRead ).toBe( 0 );
		expect( alpha.bytesWritten ).toBe( 0 );
	} );

	it( 'skips empty-string targets', () => {
		const { edges } = parseMetadata( {
			a: {
				class: 'Node',
				counter: 0,
				sink: '',
				target: '',
				debug_state: 0,
				arguments: '',
			},
		} );
		expect( edges ).toEqual( [] );
	} );
} );
