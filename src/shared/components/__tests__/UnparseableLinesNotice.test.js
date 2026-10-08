/**
 * UnparseableLinesNotice tests — the shared warning a reader shows when a log
 * line it read would not parse and was skipped.
 */

import { render, act } from '@testing-library/react';
import UnparseableLinesNotice from '../UnparseableLinesNotice';
import { Core } from '../../../runtime/core';
import { Node } from '../../../runtime/node';
import { mountExospine } from '../../../runtime/exospine';
import { publishSkippedLines } from '../../test-utils/skippedLines';

beforeEach( () => Core.reset() );

describe( 'UnparseableLinesNotice', () => {
	it( 'says how many lines were skipped, in the canonical warning banner', () => {
		const { container } = render( <UnparseableLinesNotice count={ 37 } /> );
		const notice = container.querySelector( '.newspack-nodes-banner' );
		expect( notice ).not.toBeNull();
		expect( notice.classList.contains( 'is-warning' ) ).toBe( true );
		expect( notice.getAttribute( 'role' ) ).toBe( 'status' );
		expect( notice.textContent ).toBe(
			'37 lines would not parse and were skipped.'
		);
	} );

	it( 'speaks of one line in the singular', () => {
		const { container } = render( <UnparseableLinesNotice count={ 1 } /> );
		expect( container.textContent ).toBe(
			'1 line would not parse and was skipped.'
		);
	} );

	it( 'names the source whose lines it counted', () => {
		const { container } = render(
			<UnparseableLinesNotice count={ 12 } source="Probe tail 8814" />
		);
		expect( container.textContent ).toBe(
			'Probe tail 8814: 12 lines would not parse and were skipped.'
		);
	} );

	it( 'names the source in the singular too', () => {
		const { container } = render(
			<UnparseableLinesNotice count={ 1 } source="Probe tail 8814" />
		);
		expect( container.textContent ).toBe(
			'Probe tail 8814: 1 line would not parse and was skipped.'
		);
	} );

	it.each( [ 0, undefined ] )( 'renders nothing for %p', ( count ) => {
		const { container } = render(
			<UnparseableLinesNotice count={ count } />
		);
		expect( container.childNodes.length ).toBe( 0 );
	} );

	it( 'reads the count the named stream node publishes', () => {
		publishSkippedLines( 'probe-4471:stream', 23 );
		const { container } = render(
			<UnparseableLinesNotice node="probe-4471:stream" />
		);
		expect( container.textContent ).toBe(
			'23 lines would not parse and were skipped.'
		);
	} );

	it( 'follows the stream node as its count climbs', () => {
		publishSkippedLines( 'probe-4471:stream', 0 );
		const { container } = render(
			<UnparseableLinesNotice node="probe-4471:stream" source="Tail 9" />
		);
		expect( container.childNodes.length ).toBe( 0 );
		act( () => publishSkippedLines( 'probe-4471:stream', 41 ) );
		expect( container.textContent ).toBe(
			'Tail 9: 41 lines would not parse and were skipped.'
		);
	} );

	it( 'reads its own graph’s share off the page link, not a neighbour’s', () => {
		const { stream } = mountExospine();
		stream.setField( 'unparseableByTarget', {
			'probe-4471:stream': 0,
			'tail-6602:stream': 58,
		} );
		const { container } = render(
			<>
				<UnparseableLinesNotice node="probe-4471:stream" />
				<UnparseableLinesNotice node="tail-6602:stream" />
			</>
		);
		expect( container.textContent ).toBe(
			'58 lines would not parse and were skipped.'
		);
	} );

	it( 'ignores a count published on the stream node itself', () => {
		const tee = new Node();
		tee.name = 'probe-4471:stream';
		tee.registrations.UNPARSEABLE_LINES = {};
		tee.setState( 'UNPARSEABLE_LINES', 19 );
		const { container } = render(
			<UnparseableLinesNotice node="probe-4471:stream" />
		);
		expect( container.childNodes.length ).toBe( 0 );
	} );

	it( 'renders nothing for a node no graph holds yet', () => {
		const { container } = render(
			<UnparseableLinesNotice node="nowhere-5530:stream" />
		);
		expect( container.childNodes.length ).toBe( 0 );
	} );
} );
