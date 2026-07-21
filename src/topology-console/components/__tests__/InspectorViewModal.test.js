/**
 * InspectorViewModal tests — the ONE wide modal opened from the Inspector's
 * no-node strip. It hosts two views: Runtime (self-mounting grids poller) and
 * Timeline (a parsed view over the SAME `_output` transcript the console holds).
 * ESC / backdrop / close all dismiss, matching the other topology modals.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { DumperNode } from '../../../runtime/dumper-node';
import names from '../../../runtime/reserved-node-names.json';
import { MetadataNode } from '../../../runtime/metadata-node';
import InspectorViewModal from '../InspectorViewModal';

beforeEach( () => Core.reset() );

// Seed the `_output` Dumper with a transcript the modal reads via useNodeState.
function seedTranscript( entries ) {
	const dumper = new DumperNode();
	dumper.name = names.OUTPUT;
	act( () => dumper.restore( entries ) );
	return dumper;
}

test( 'renders nothing for an unknown / null view', () => {
	const { container } = render(
		<InspectorViewModal view={ null } onDismiss={ () => {} } />
	);
	expect( container.querySelector( '.topology-modal' ) ).toBeNull();
	expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
} );

test( 'the Runtime view mounts the runtime_stats poller inside a wide modal', () => {
	render( <InspectorViewModal view="runtime" onDismiss={ () => {} } /> );
	const modal = document.body.querySelector( '.topology-modal' );
	expect( modal ).toBeTruthy();
	expect( modal.classList.contains( 'topology-modal--large' ) ).toBe( true );
	expect(
		document.body.querySelector( '[data-testid="runtime-view"]' )
	).toBeTruthy();
	const poller = Core.node( 'runtime:poller' );
	expect( poller.verb ).toBe( 'runtime_stats' );
	expect( poller.target ).toBe( '_cwd' );
} );

test( 'the Stats view mounts the runtime_stats poller inside a wide modal', () => {
	render( <InspectorViewModal view="stats" onDismiss={ () => {} } /> );
	const modal = document.body.querySelector( '.topology-modal' );
	expect( modal ).toBeTruthy();
	expect( modal.classList.contains( 'topology-modal--large' ) ).toBe( true );
	expect(
		document.body.querySelector( '[data-testid="stats-view"]' )
	).toBeTruthy();
	const poller = Core.node( 'stats:poller' );
	expect( poller.verb ).toBe( 'runtime_stats' );
	expect( poller.target ).toBe( '_cwd' );
} );

test( 'the Timeline view parses the console `_output` transcript into rows', () => {
	seedTranscript( [
		{
			key: 't1',
			ts: 1_777_000_000,
			kind: 'recv',
			text: 'request-builder: DEBUG: rotate seg=42',
		},
	] );
	render( <InspectorViewModal view="timeline" onDismiss={ () => {} } /> );
	const rows = document.body.querySelectorAll( '.timeline-view__row' );
	expect( rows ).toHaveLength( 1 );
	expect(
		rows[ 0 ].querySelector( '.timeline-view__node' ).textContent
	).toBe( 'request-builder' );
	expect(
		rows[ 0 ].querySelector( '.timeline-view__event' ).textContent
	).toBe( 'rotate' );
} );

function seedMetadata( nodes ) {
	let meta = Core.node( names.METADATA );
	if ( ! meta ) {
		meta = new MetadataNode();
		meta.name = names.METADATA;
	}
	act( () => meta.setState( 'metadata', { nodes, edges: [], pwd: '' } ) );
}

test( 'the Timeline view carries the all-nodes Trace toggle; Runtime does not', () => {
	seedMetadata( [ { id: 'alpha', debugState: 0 } ] );
	const onAction = jest.fn();
	const { getByText, queryByText, rerender } = render(
		<InspectorViewModal
			view="timeline"
			onDismiss={ () => {} }
			onAction={ onAction }
		/>
	);
	fireEvent.click( getByText( 'trace' ) );
	expect( getByText( 'stop trace' ) ).not.toBeNull();
	expect( onAction ).toHaveBeenCalledWith( 'trace', '*', 1 );
	rerender(
		<InspectorViewModal
			view="runtime"
			onDismiss={ () => {} }
			onAction={ onAction }
		/>
	);
	expect( queryByText( 'trace' ) ).toBeNull();
} );

test( 'the Trace override tolerates one stale poll and clears on agreement', () => {
	seedMetadata( [ { id: 'alpha', debugState: 0 } ] );
	const { getByText, queryByText } = render(
		<InspectorViewModal
			view="timeline"
			onDismiss={ () => {} }
			onAction={ () => {} }
		/>
	);
	fireEvent.click( getByText( 'trace' ) );
	// A stale in-flight poll still reporting untraced does not revert it.
	seedMetadata( [ { id: 'alpha', debugState: 0 } ] );
	expect( getByText( 'stop trace' ) ).not.toBeNull();
	// An agreeing poll clears the override to matching server truth.
	seedMetadata( [ { id: 'alpha', debugState: 4 } ] );
	expect( getByText( 'stop trace' ) ).not.toBeNull();
	expect( queryByText( 'trace' ) ).toBeNull();
} );

test( 'two disagreeing polls surrender the Trace override (verb failed)', () => {
	seedMetadata( [ { id: 'alpha', debugState: 0 } ] );
	const { getByText } = render(
		<InspectorViewModal
			view="timeline"
			onDismiss={ () => {} }
			onAction={ () => {} }
		/>
	);
	fireEvent.click( getByText( 'trace' ) );
	seedMetadata( [ { id: 'alpha', debugState: 0 } ] );
	seedMetadata( [ { id: 'bravo', debugState: 0 } ] );
	expect( getByText( 'trace' ) ).not.toBeNull();
} );

test( 'stop trace fires the all-nodes trace at level 0 when tracing', () => {
	seedMetadata( [ { id: 'alpha', debugState: 3 } ] );
	const onAction = jest.fn();
	const { getByText } = render(
		<InspectorViewModal
			view="timeline"
			onDismiss={ () => {} }
			onAction={ onAction }
		/>
	);
	fireEvent.click( getByText( 'stop trace' ) );
	expect( onAction ).toHaveBeenCalledWith( 'trace', '*', 0 );
	expect( getByText( 'trace' ) ).not.toBeNull();
} );

test( 'ESC dismisses the modal', () => {
	const onDismiss = jest.fn();
	render( <InspectorViewModal view="timeline" onDismiss={ onDismiss } /> );
	fireEvent.keyDown( document, { key: 'Escape' } );
	expect( onDismiss ).toHaveBeenCalledTimes( 1 );
} );

test( 'the close button dismisses the modal', () => {
	const onDismiss = jest.fn();
	render( <InspectorViewModal view="timeline" onDismiss={ onDismiss } /> );
	fireEvent.click( document.body.querySelector( '.topology-modal__close' ) );
	expect( onDismiss ).toHaveBeenCalledTimes( 1 );
} );

test( 'a backdrop click dismisses the modal', () => {
	const onDismiss = jest.fn();
	render( <InspectorViewModal view="timeline" onDismiss={ onDismiss } /> );
	const backdrop = document.body.querySelector( '.topology-modal-backdrop' );
	fireEvent.mouseDown( backdrop );
	expect( onDismiss ).toHaveBeenCalledTimes( 1 );
} );
