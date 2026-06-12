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

	it( 'empty when no metadata and no Core nodes', () => {
		// Bare exospine: _router/_command_interpreter are SCAFFOLDING-hidden, so
		// coreToGraph() is empty and no metadata is published.
		const { teardown } = mountExospine();
		const { result } = renderHook( () =>
			useGraphSource( { active: true } )
		);
		expect( result.current.hasNodes ).toBe( false );
		// coreToGraph still stamps the local reply pivot into pwd even with no
		// visible nodes (the in-browser tail target is always the bare `_output`).
		expect( result.current.graph ).toEqual( {
			nodes: [],
			edges: [],
			pwd: '_output',
		} );
		teardown();
	} );

	it( 'falls back to coreToGraph when NO metadata is published but Core holds nodes', () => {
		// Before the first dump_metadata poll publishes, the source reads the
		// in-process graph straight off Core via coreToGraph().
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result } = renderHook( () => useGraphSource() );
		expect( result.current.hasNodes ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'a'
		);
		teardown();
	} );

	it( 'published metadata-with-nodes takes precedence over the coreToGraph fallback', () => {
		// Core holds a live node `a` (coreToGraph would show it). Once _metadata
		// publishes a graph with ≥1 node, the metadata source wins.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
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
		// The console (worker/local scope) reads ONLY the published metadata
		// graph — coreToGraph there would surface the browser-side reserved
		// scaffolding (_output/_metadata/_completion) the worker graph never
		// includes. With coreFallback off and no metadata, the source is empty.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
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
		a.setName( 'a' );
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
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
		// An empty metadata graph (nodes:[]) is treated as "not yet populated":
		// the source falls back to coreToGraph() rather than blanking the canvas.
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
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
} );
