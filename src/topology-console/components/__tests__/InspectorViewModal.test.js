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
import { FROM, TO, VALUE } from '../../../runtime/message';
import InspectorViewModal from '../InspectorViewModal';

beforeEach( () => {
	Core.reset();
	// The scope a worker would answer from, here a sink that answers nothing.
	Core.registerNode( names.CWD, { name: names.CWD, fill: () => {} } );
} );

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

test( 'the Runtime view mounts its list_timers poller inside a wide modal', () => {
	render( <InspectorViewModal view="runtime" onDismiss={ () => {} } /> );
	const modal = document.body.querySelector( '.topology-modal' );
	expect( modal ).toBeTruthy();
	expect( modal.classList.contains( 'topology-modal--large' ) ).toBe( true );
	expect(
		document.body.querySelector( '[data-testid="runtime-view"]' )
	).toBeTruthy();
	const poller = Core.node( 'timers:fetch' );
	expect( poller.verb ).toBe( 'list_timers' );
	expect( poller.target ).toBe( '_cwd' );
} );

test( 'the Profiler view mounts its list_profiles poller inside a wide modal', () => {
	render( <InspectorViewModal view="stats" onDismiss={ () => {} } /> );
	const modal = document.body.querySelector( '.topology-modal' );
	expect( modal ).toBeTruthy();
	expect( modal.classList.contains( 'topology-modal--large' ) ).toBe( true );
	expect(
		document.body.querySelector( '[data-testid="profiler-view"]' )
	).toBeTruthy();
	const poller = Core.node( 'profiler:fetch' );
	expect( poller.verb ).toBe( 'list_profiles' );
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
	act( () => meta.setField( 'metadata', { nodes, edges: [], pwd: '' } ) );
}

// The interpreter's fills, captured; it answers nothing.
function captureInterpreter() {
	const sent = [];
	Core.registerNode( names.COMMAND_INTERPRETER, {
		name: names.COMMAND_INTERPRETER,
		fill: ( m ) => sent.push( m ),
	} );
	return sent;
}

test( 'the Timeline view carries the all-nodes Trace toggle; Runtime does not', () => {
	seedMetadata( [ { id: 'alpha', debugState: 0 } ] );
	const sent = captureInterpreter();
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
	expect(
		sent.map( ( m ) => [ m[ VALUE ].name, m[ VALUE ].arguments ] )
	).toEqual( [ [ 'trace', [ '*', '1' ] ] ] );
	expect( onAction ).not.toHaveBeenCalled();
	// The Runtime view's poller builds on the real interpreter.
	Core.unregisterNode( names.COMMAND_INTERPRETER );
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
	const sent = captureInterpreter();
	const { getByText } = render(
		<InspectorViewModal view="timeline" onDismiss={ () => {} } />
	);
	fireEvent.click( getByText( 'stop trace' ) );
	expect( sent.map( ( m ) => m[ VALUE ].arguments ) ).toEqual( [
		[ '*', '0' ],
	] );
	expect( getByText( 'trace' ) ).not.toBeNull();
} );

describe( 'the Timeline trace button is UI-bound', () => {
	const click = ( debugUi ) => {
		const output = new DumperNode();
		output.name = names.OUTPUT;
		output.setDebugUi( debugUi );
		seedMetadata( [ { id: 'kiwi-7731', debugState: 0 } ] );
		const sent = captureInterpreter();
		const { getByText } = render(
			<InspectorViewModal view="timeline" onDismiss={ () => {} } />
		);
		fireEvent.click( getByText( 'trace' ) );
		const texts = ( output.transcript ?? [] ).map( ( e ) => e.text );
		return { sent, texts };
	};

	test( 'its reply returns through bare _ui to the viewed scope', () => {
		const [ trace ] = click( false ).sent;
		expect( trace[ FROM ] ).toBe( names.UI );
		expect( trace[ TO ] ).toBe( names.CWD );
	} );

	test( 'it echoes nothing while debug_ui is off', () => {
		expect( click( false ).texts ).toEqual( [] );
	} );

	test( 'it echoes the command while debug_ui is on', () => {
		expect( click( true ).texts ).toContain(
			`command_node ${ names.CWD } trace * 1`
		);
	} );
} );

test( 'the Triage view renders the node DLQ table inside a wide modal', () => {
	const onAction = jest.fn();
	render(
		<InspectorViewModal
			view="triage"
			node={ { id: 'firehose-consumer' } }
			onDismiss={ () => {} }
			onAction={ onAction }
		/>
	);
	const modal = document.body.querySelector( '.topology-modal' );
	expect( modal.classList.contains( 'topology-modal--large' ) ).toBe( true );
	expect(
		document.body.querySelector( '[data-testid="triage-view"]' )
	).toBeTruthy();
	// It fetches the DLQ page for the passed-through node on mount.
	expect( onAction ).toHaveBeenCalledWith(
		'invoke',
		'firehose-consumer',
		expect.objectContaining( { verb: 'dl_list' } )
	);
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

test.each( [ 'runtime', 'stats', 'timeline', 'triage' ] )(
	'the %s view takes the shared 80%% height cap',
	( view ) => {
		render(
			<InspectorViewModal
				view={ view }
				node={ { id: 'n' } }
				onDismiss={ () => {} }
			/>
		);
		const modal = document.body.querySelector( '.topology-modal' );
		expect( modal.classList.contains( 'topology-modal--inspview' ) ).toBe(
			true
		);
	}
);
