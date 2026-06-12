import { parseMetadata } from '../metadata-node';

describe( 'parseMetadata', () => {
	it( 'returns empty graph for malformed input', () => {
		expect( parseMetadata( null ) ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
		} );
		expect( parseMetadata( '' ) ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
		} );
		expect( parseMetadata( 'not-json' ) ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
		} );
	} );

	it( 'extracts the reply pivot from the _header section and excludes it from nodes', () => {
		const { nodes, pwd } = parseMetadata( {
			_header: { pwd: '_repl/_output/_sse:346/_output' },
			alpha: { class: 'Echo', counter: 1, target: '' },
		} );
		expect( pwd ).toBe( '_repl/_output/_sse:346/_output' );
		expect( nodes.map( ( n ) => n.id ) ).toEqual( [ 'alpha' ] );
	} );

	it( 'canonicalizes the pwd reply-node segment to _output (the tail target)', () => {
		// The dump_metadata POLL is sent FROM the `_metadata` node, so the header
		// pwd arrives ending in `_metadata`. But a Tee tail target (from a shell
		// `connect_node`) ends in `_output`. Canonicalize the final segment to
		// `_output` so the toggle's exact match against the tail target holds.
		expect(
			parseMetadata( {
				_header: { pwd: '_repl/_output/_sse:346/_metadata' },
			} ).pwd
		).toBe( '_repl/_output/_sse:346/_output' );
	} );

	it( 'leaves a bare (slash-less) pwd untouched — the in-browser _output case', () => {
		expect( parseMetadata( { _header: { pwd: '_output' } } ).pwd ).toBe(
			'_output'
		);
	} );

	it( 'defaults pwd to empty string when no _header is present', () => {
		expect(
			parseMetadata( { a: { class: 'Echo', counter: 0 } } ).pwd
		).toBe( '' );
	} );

	it( 'parses a metadata OBJECT (the post-fix contract: object-in, no JSON string)', () => {
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
				accepts_fill: true,
				has_target: true,
				targets: [ 'beta' ],
			},
		] );
		expect( edges ).toEqual( [ { from: 'alpha', to: 'beta' } ] );
	} );

	it( "preserves each node's FULL target list even though edges collapse to the head", () => {
		// The canvas edge collapses `_repl/_output/_sse:123/_output` to its head
		// `_repl`, but the Inspector's Connect/Disconnect toggle must still tell
		// WHICH session's reply pivot is wired — so the node keeps the full paths.
		const { nodes, edges } = parseMetadata( {
			tee: {
				class: 'Tee',
				counter: 10,
				target: [ 'request-builder', '_repl/_output/_sse:123/_output' ],
			},
		} );
		expect( edges ).toEqual( [
			{ from: 'tee', to: 'request-builder' },
			{ from: 'tee', to: '_repl' },
		] );
		expect( nodes[ 0 ].targets ).toEqual( [
			'request-builder',
			'_repl/_output/_sse:123/_output',
		] );
	} );

	it( 'normalizes a string target and a missing target to a targets array', () => {
		const { nodes } = parseMetadata( {
			one: { class: 'Echo', counter: 1, target: 'beta' },
			two: { class: 'Echo', counter: 1 },
		} );
		expect( nodes[ 0 ].targets ).toEqual( [ 'beta' ] );
		expect( nodes[ 1 ].targets ).toEqual( [] );
	} );

	it( 'draws an edge to the head node of a path target (router peels the head)', () => {
		// `_heartbeat` targets the PATH `_sse/workers`; the router peels `_sse`
		// and delivers there, so the canvas edge connects to `_sse`, not the
		// non-existent `_sse/workers`.
		const { edges } = parseMetadata( {
			_heartbeat: {
				class: 'Heartbeat',
				counter: 1,
				target: '_sse/workers',
			},
		} );
		expect( edges ).toEqual( [ { from: '_heartbeat', to: '_sse' } ] );
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

	it( 'hides ONLY the backbone (_command_interpreter, _router); shows everything else incl. _output/_repl', () => {
		const { nodes } = parseMetadata( {
			_command_interpreter: { class: 'CommandInterpreter', counter: 1 },
			_router: { class: 'Router', counter: 1 },
			_output: {
				class: 'Dumper',
				counter: 1,
				sink: '_command_interpreter',
			},
			_repl: {
				class: 'CommandInterpreter',
				counter: 1,
				sink: '_router',
			},
			'firehose:tee': {
				class: 'Tee',
				counter: 99,
				sink: '_command_interpreter',
				target: [],
				debug_state: 0,
				arguments: '',
			},
		} );
		// The backbone is plumbing; the canvas shows the rest of the graph,
		// including the transcript sink (_output) and a mounted _repl.
		expect( nodes.map( ( n ) => n.id ) ).toEqual( [
			'_output',
			'_repl',
			'firehose:tee',
		] );
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
