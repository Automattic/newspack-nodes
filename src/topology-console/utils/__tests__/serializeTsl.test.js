import { serializeTsl } from '../serializeTsl';

describe( 'serializeTsl', () => {
	it( 'returns empty string for an empty graph', () => {
		expect( serializeTsl( { nodes: [], edges: [] } ) ).toBe( '' );
	} );

	it( 'emits make_node for a bare node with no args', () => {
		const g = {
			nodes: [
				{
					id: 'echo',
					name: 'echo',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe( 'make_node Echo echo\n' );
	} );

	it( 'serializes ctor args positionally', () => {
		const g = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [ '/tmp/log', 0, 16777216 ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Partition p /tmp/log 0 16777216\n'
		);
	} );

	it( 'emits cmd lines for verb invocations', () => {
		const g = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [],
					verbInvocations: [
						{ verb: 'allow_large_writes', args: [] },
						{ verb: 'with_index', args: [ 'request-index' ] },
					],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Partition p\n' +
				'cmd p:config allow_large_writes\n' +
				'cmd p:config with_index request-index\n'
		);
	} );

	it( 'emits connect_node lines for edges', () => {
		const g = {
			nodes: [
				{
					id: 'a',
					name: 'a',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
				{
					id: 'b',
					name: 'b',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			],
			edges: [ { from: 'a', to: 'b' } ],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Echo a\nmake_node Echo b\nconnect_node a b\n'
		);
	} );

	it( 'single-quotes ctor args containing spaces', () => {
		const g = {
			nodes: [
				{
					id: 'h',
					name: 'h',
					class: 'Hook',
					ctorArgs: [ 'wp_loaded', 'this has spaces' ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			"make_node Hook h wp_loaded 'this has spaces'\n"
		);
	} );

	it( 'omits empty-string ctor arg trailing slots', () => {
		// Empty trailing slots are user-skipped optional args; the
		// serializer should not emit literal empty tokens (which the
		// shell tokenizer would treat as positional).
		const g = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [ '/tmp/log', 0, '', '', '' ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Partition p /tmp/log 0\n'
		);
	} );
} );
