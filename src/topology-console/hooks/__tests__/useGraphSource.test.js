import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { mountExospine } from '../../../runtime/exospine';
import { Node } from '../../../runtime/node';
import names from '../../../runtime/reserved-node-names.json';
import { ShellNode } from '../../../runtime/shell-node';
import { useDebugRepl } from '../../../debug-overlay/useDebugRepl';
import { coreToGraph } from '../../utils/coreToGraph';
import { useGraphSource } from '../useGraphSource';
import { useCanvasLayout } from '../useCanvasLayout';

describe( 'useGraphSource', () => {
	beforeEach( () => {
		Core.reset();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'empty (besides the visible backbone fixtures) when no metadata and no soft nodes', () => {
		// hasNodes excludes the always-present backbone fixtures → empty graph.
		const { teardown } = mountExospine();
		const { result } = renderHook( () =>
			useGraphSource( { active: true } )
		);
		expect( result.current.hasNodes ).toBe( false );
		// Backbone fixtures only; coreToGraph stamps local reply pwd (_output).
		expect(
			result.current.graph.nodes.map( ( n ) => n.id ).sort()
		).toEqual( [
			'_heartbeat',
			'_http',
			'_null',
			'_shell',
			'_stream',
			'_ui',
		] );
		// The backbone's two permanent edges: the heartbeat's poke, and
		// _http's target for unaddressed reply-leg output.
		expect( result.current.graph.edges ).toEqual( [
			{ from: '_http', to: '_null' },
			{ from: '_heartbeat', to: '_http' },
		] );
		expect( result.current.graph.pwd ).toBe( '_output' );
		teardown();
	} );

	it( 'falls back to coreToGraph when NO metadata is published but Core holds nodes', () => {
		// Pre-dump_metadata: source reads Core via coreToGraph().
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const { result } = renderHook( () => useGraphSource() );
		expect( result.current.hasNodes ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'a'
		);
		teardown();
	} );

	it( 'published metadata-with-nodes takes precedence over the coreToGraph fallback', () => {
		// Core holds `a`, but once _metadata publishes ≥1 node metadata wins.
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
		const { result } = renderHook( () => useGraphSource() );
		act( () => {
			metadata.setField( 'metadata', {
				nodes: [ { id: 'fromMeta' } ],
				edges: [],
			} );
		} );
		expect( result.current.hasNodes ).toBe( true );
		const ids = result.current.graph.nodes.map( ( n ) => n.id );
		expect( ids ).toContain( 'fromMeta' );
		expect( ids ).not.toContain( 'a' );
		teardown();
	} );

	it( 'coreFallback:false reports an empty graph until metadata publishes, even with Core nodes', () => {
		// Console reads ONLY metadata; coreToGraph leaks browser scaffolding.
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const { result } = renderHook( () =>
			useGraphSource( { coreFallback: false } )
		);
		expect( result.current.hasNodes ).toBe( false );
		expect( result.current.graph ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '',
		} );
		teardown();
	} );

	it( 'coreFallback:false still adopts the published metadata graph', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
		const { result } = renderHook( () =>
			useGraphSource( { coreFallback: false } )
		);
		act( () => {
			metadata.setField( 'metadata', {
				nodes: [ { id: 'fromMeta' } ],
				edges: [],
			} );
		} );
		expect( result.current.hasNodes ).toBe( true );
		const ids = result.current.graph.nodes.map( ( n ) => n.id );
		expect( ids ).toContain( 'fromMeta' );
		expect( ids ).not.toContain( 'a' );
		teardown();
	} );

	it( 'an empty metadata graph (no nodes) falls back to coreToGraph', () => {
		// Empty metadata (nodes:[]) = "not populated" → coreToGraph, not blank.
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
		const { result } = renderHook( () => useGraphSource() );
		act( () => {
			metadata.setField( 'metadata', { nodes: [], edges: [] } );
		} );
		expect( result.current.hasNodes ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			names.METADATA
		);
		teardown();
	} );

	it( 'hasNodes stays false for a metadata graph of only backbone + the worker IPC pair', () => {
		// The console mounts `_repl` (the worker's input Partition) before the
		// first dump_metadata reply lands. If that counts as "the graph", the
		// canvas lays out the scaffolding alone and every real node arriving on
		// the next poll gets placeBelow-tucked into a column — the staged paint.
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
		const { result } = renderHook( () =>
			useGraphSource( { coreFallback: false } )
		);
		act( () => {
			metadata.setField( 'metadata', {
				nodes: [
					{ id: '_shell' },
					{ id: '_http' },
					{ id: '_heartbeat' },
					{ id: '_repl' },
					{ id: '_repl:input' },
				],
				edges: [],
			} );
		} );
		expect( result.current.hasNodes ).toBe( false );
		teardown();
	} );

	/**
	 * Open the overlay on a page whose graph has not mounted: its `_metadata`
	 * poll publishes nothing but the exospine and the overlay's own REPL.
	 *
	 * @return {Object} The hook result, its rerender, `publish()` and teardown.
	 */
	const openOverlayFirst = () => {
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const hook = renderHook( () => {
			useDebugRepl( true, shell );
			const { graph, hasNodes } = useGraphSource();
			return {
				hasNodes,
				layout: useCanvasLayout( {
					storageKey: null,
					graph,
					ready: hasNodes,
				} ),
			};
		} );
		const publish = () =>
			act( () => {
				Core.node( names.METADATA ).setField(
					'metadata',
					coreToGraph()
				);
			} );
		publish();
		act( () => jest.advanceTimersByTime( 1000 ) );
		return { ...hook, publish, teardown };
	};

	/**
	 * Mount the page's graph: a three-card chain.
	 *
	 * @return {Array<Node>} The chain, head first.
	 */
	const mountChain = () => {
		const chain = [ 'page:timer', 'page:tee', 'page:fetch' ].map(
			( id ) => {
				const n = new Node();
				n.name = id;
				return n;
			}
		);
		chain[ 0 ].target = 'page:tee';
		chain[ 1 ].target = 'page:fetch';
		return chain;
	};

	it( "draws the overlay's own scaffolding on a page with no graph", () => {
		const { result, teardown } = openOverlayFirst();
		expect( result.current.hasNodes ).toBe( true );
		expect(
			[ '_output', '_completion', '_metadata', '_cwd', '_stdout' ].filter(
				( id ) => ! result.current.layout.positions[ id ]
			)
		).toEqual( [] );
		teardown();
	} );

	it( 'lays a page graph out in full when it mounts after the overlay opened', () => {
		const { result, rerender, publish, teardown } = openOverlayFirst();
		const chain = mountChain();
		publish();
		rerender();
		act( () => jest.advanceTimersByTime( 1000 ) );
		const at = result.current.layout.positions;
		// Laid out, not tucked: the chain runs across three columns.
		expect( new Set( chain.map( ( n ) => at[ n.name ]?.x ) ).size ).toBe(
			3
		);
		teardown();
	} );

	it( 'only places the page graph when the operator moved a card first', () => {
		const { result, rerender, publish, teardown } = openOverlayFirst();
		const moved = { x: 1234, y: 567 };
		act( () => result.current.layout.onPositionChange( '_cwd', moved ) );
		const before = { ...result.current.layout.positions };
		const chain = mountChain();
		publish();
		rerender();
		act( () => jest.advanceTimersByTime( 1000 ) );
		const at = result.current.layout.positions;
		for ( const id of Object.keys( before ) ) {
			expect( [ id, at[ id ] ] ).toEqual( [ id, before[ id ] ] );
		}
		// Tucked below, one column, as a hand-moved layout keeps.
		expect( new Set( chain.map( ( n ) => at[ n.name ]?.x ) ).size ).toBe(
			1
		);
		teardown();
	} );
} );
