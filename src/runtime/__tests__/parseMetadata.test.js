import { parseMetadata } from '../metadata-node';

describe( 'parseMetadata', () => {
	it( 'returns empty graph for malformed input', () => {
		expect( parseMetadata( null ) ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
			profiling: false,
		} );
		expect( parseMetadata( '' ) ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
			profiling: false,
		} );
		expect( parseMetadata( 'not-json' ) ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
			profiling: false,
		} );
	} );

	it( 'extracts the reply path from the _header section and excludes it from nodes', () => {
		const { nodes, pwd } = parseMetadata( {
			_header: { pwd: '_repl/_output/_sse:346/_output' },
			alpha: { class: 'Echo', counter: 1, target: '' },
		} );
		expect( pwd ).toBe( '_repl/_output/_sse:346/_output' );
		expect( nodes.map( ( n ) => n.id ) ).toEqual( [ 'alpha' ] );
	} );

	it( 'surfaces _header.profiling as the parsed `profiling` flag (Profiling-toggle truth)', () => {
		expect(
			parseMetadata( { _header: { pwd: '_output', profiling: true } } )
				.profiling
		).toBe( true );
		// Absent / false reads as false — the strip toggle stays off.
		expect(
			parseMetadata( { _header: { pwd: '_output' } } ).profiling
		).toBe( false );
	} );

	it( 'canonicalizes the pwd reply-node segment to _output (the tail target)', () => {
		// Canonicalize the final pwd segment to _output so the toggle matches.
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
				arguments: [],
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
				arguments: [],
				lgstMsg: 0,
				bytesRead: 0,
				bytesWritten: 0,
				accepts_fill: true,
				has_target: true,
				has_config: false,
				targets: [ 'beta' ],
				target: 'beta',
			},
		] );
		expect( edges ).toEqual( [ { from: 'alpha', to: 'beta' } ] );
	} );

	it( "preserves each node's FULL target list even though edges collapse to the head", () => {
		// Edges collapse to the head; nodes keep the full target paths.
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
		// Router peels the head → edge connects to _sse, not _sse/workers.
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
				arguments: [],
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
				arguments: [],
			},
		} );
		// Backbone is plumbing; canvas shows the rest (_output + _repl).
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
				arguments: [],
			},
			beta: {
				class: 'Echo',
				counter: 1,
				sink: '',
				target: '',
				debug_state: 0,
				arguments: [],
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
				arguments: [],
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

	it( "threads a consumer's frames + cursor (dump_metadata) onto the node", () => {
		const { nodes } = parseMetadata( {
			'firehose-consumer': {
				class: 'Consumer',
				counter: 5,
				target: '',
				frames: [
					{ id: 0, size: 120 },
					{ id: 1, size: 40 },
				],
				cursor: { segment: 1, offset: 12 },
			},
		} );
		const c = nodes.find( ( n ) => n.id === 'firehose-consumer' );
		expect( c.frames ).toEqual( [
			{ id: 0, size: 120 },
			{ id: 1, size: 40 },
		] );
		expect( c.cursor ).toEqual( { segment: 1, offset: 12 } );
	} );

	it( 'omits frames + cursor entirely for a non-consumer node (no extra keys)', () => {
		const { nodes } = parseMetadata( {
			alpha: { class: 'Echo', counter: 1, target: 'beta' },
		} );
		const alpha = nodes[ 0 ];
		expect( alpha ).not.toHaveProperty( 'frames' );
		expect( alpha ).not.toHaveProperty( 'cursor' );
	} );

	it( "threads a consumer's deadletter_segments count onto the node", () => {
		// Distinct-from-default: 7, not the 0 the Triage badge falls back to.
		const { nodes } = parseMetadata( {
			'firehose-consumer': {
				class: 'Consumer',
				counter: 5,
				target: '',
				frames: [ { id: 0, size: 120 } ],
				cursor: { segment: 1, offset: 12 },
				deadletter_segments: 7,
			},
		} );
		const c = nodes.find( ( n ) => n.id === 'firehose-consumer' );
		expect( c.deadletter_segments ).toBe( 7 );
	} );

	it( 'omits deadletter_segments for a node whose payload lacks it', () => {
		const { nodes } = parseMetadata( {
			alpha: { class: 'Echo', counter: 1, target: 'beta' },
		} );
		expect( nodes[ 0 ] ).not.toHaveProperty( 'deadletter_segments' );
	} );

	it( "threads a consumer's polling signal onto the node when present", () => {
		const { nodes } = parseMetadata( {
			'firehose-consumer': {
				class: 'Consumer',
				counter: 5,
				target: '',
				frames: [ { id: 0, size: 120 } ],
				cursor: { segment: 1, offset: 12 },
				polling: 'PAUSED',
			},
		} );
		const c = nodes.find( ( n ) => n.id === 'firehose-consumer' );
		expect( c.polling ).toBe( 'PAUSED' );
	} );

	it( 'omits polling for a node whose payload lacks it (no extra key)', () => {
		const { nodes } = parseMetadata( {
			alpha: { class: 'Echo', counter: 1, target: 'beta' },
		} );
		const alpha = nodes[ 0 ];
		expect( alpha ).not.toHaveProperty( 'polling' );
	} );

	it( "threads a consumer's at_frame + on_frame position onto the node when present", () => {
		const { nodes } = parseMetadata( {
			'firehose-consumer': {
				class: 'Consumer',
				counter: 5,
				target: '',
				frames: [ { id: 9, size: 120 } ],
				cursor: { segment: 1, offset: 12 },
				polling: 'PAUSED',
				at_frame: 9,
				on_frame: false,
			},
		} );
		const c = nodes.find( ( n ) => n.id === 'firehose-consumer' );
		expect( c.at_frame ).toBe( 9 );
		expect( c.on_frame ).toBe( false );
	} );

	it( 'threads at_frame=null (no frames yet) through without dropping the key', () => {
		const { nodes } = parseMetadata( {
			'firehose-consumer': {
				class: 'Consumer',
				counter: 5,
				target: '',
				frames: [],
				cursor: { segment: 0, offset: 0 },
				polling: 'ACTIVE',
				at_frame: null,
				on_frame: false,
			},
		} );
		const c = nodes.find( ( n ) => n.id === 'firehose-consumer' );
		expect( c ).toHaveProperty( 'at_frame', null );
		expect( c.on_frame ).toBe( false );
	} );

	it( 'omits at_frame + on_frame for a node whose payload lacks them (no extra keys)', () => {
		const { nodes } = parseMetadata( {
			alpha: { class: 'Echo', counter: 1, target: 'beta' },
		} );
		const alpha = nodes[ 0 ];
		expect( alpha ).not.toHaveProperty( 'at_frame' );
		expect( alpha ).not.toHaveProperty( 'on_frame' );
	} );

	it( 'defaults new counters to 0 when payload omits them', () => {
		const { nodes } = parseMetadata( {
			alpha: {
				class: 'Echo',
				counter: 0,
				sink: '',
				target: '',
				debug_state: 0,
				arguments: [],
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
				arguments: [],
			},
		} );
		expect( edges ).toEqual( [] );
	} );

	it( 'builds a dashed registration edge from emitter to node-name listener', () => {
		const { edges } = parseMetadata( {
			emitter: {
				class: 'Echo',
				target: '',
				registrations: { EVT: [ 'listener' ] },
			},
			listener: { class: 'Echo', target: '' },
		} );
		expect( edges ).toContainEqual( {
			from: 'emitter',
			to: 'listener',
			registration: true,
			event: 'EVT',
		} );
	} );

	it( 'omits registration edges whose emitter is hidden scaffolding (_router)', () => {
		const { edges } = parseMetadata( {
			_router: {
				class: 'Router',
				target: '',
				registrations: { TIMER: [ 'tick' ] },
			},
			tick: { class: 'Timer', target: '' },
		} );
		expect( edges.some( ( e ) => e.registration ) ).toBe( false );
	} );
} );
