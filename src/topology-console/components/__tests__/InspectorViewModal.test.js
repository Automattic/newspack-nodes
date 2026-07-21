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
