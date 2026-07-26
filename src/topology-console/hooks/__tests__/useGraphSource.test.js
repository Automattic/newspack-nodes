import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { mountExospine } from '../../../runtime/exospine';
import { Node } from '../../../runtime/node';
import names from '../../../runtime/reserved-node-names.json';
import { useGraphSource } from '../useGraphSource';

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
		).toEqual( [ '_heartbeat', '_http', '_shell' ] );
		// The backbone's two permanent edges: the heartbeat's poke, and
		// _http's target for unaddressed reply-leg output.
		expect( result.current.graph.edges ).toEqual( [
			{ from: '_http', to: '_output' },
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
			metadata.setState( 'metadata', {
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
			metadata.setState( 'metadata', {
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
			metadata.setState( 'metadata', { nodes: [], edges: [] } );
		} );
		expect( result.current.hasNodes ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			names.METADATA
		);
		teardown();
	} );

	it( 'hasNodes stays false for a metadata graph of only backbone + _repl', () => {
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
			metadata.setState( 'metadata', {
				nodes: [
					{ id: '_shell' },
					{ id: '_http' },
					{ id: '_heartbeat' },
					{ id: '_repl' },
				],
				edges: [],
			} );
		} );
		expect( result.current.hasNodes ).toBe( false );
		teardown();
	} );
} );
