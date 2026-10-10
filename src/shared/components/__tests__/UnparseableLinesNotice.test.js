/**
 * UnparseableLinesNotice tests — the shared warning a reader shows when a log
 * line it read would not parse and was skipped.
 */

import { render, act } from '@testing-library/react';
import UnparseableLinesNotice from '../UnparseableLinesNotice';
import { Core } from '../../../runtime/core';
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

	it( 'reads the count the page link keeps for its subscription’s stamp', () => {
		publishSkippedLines( 'probe.p4', 23 );
		publishSkippedLines( 'other.p1', 5 );
		const { container } = render(
			<UnparseableLinesNotice subscribe={ [ 'probe.p4' ] } />
		);
		expect( container.textContent ).toBe(
			'23 lines would not parse and were skipped.'
		);
	} );

	it( 'sums every stamp a glob subscription carries', () => {
		publishSkippedLines( 'errors.p1', 4 );
		publishSkippedLines( 'errors.p7', 9 );
		publishSkippedLines( 'completed.p1', 50 );
		const { container } = render(
			<UnparseableLinesNotice
				subscribe={ [ 'errors.*' ] }
				source="Errors"
			/>
		);
		expect( container.textContent ).toBe(
			'Errors: 13 lines would not parse and were skipped.'
		);
	} );

	it( 'follows the page link as its count climbs', () => {
		publishSkippedLines( 'probe.p4', 0 );
		const { container } = render(
			<UnparseableLinesNotice
				subscribe={ [ 'probe.p4' ] }
				source="Tail 9"
			/>
		);
		expect( container.childNodes.length ).toBe( 0 );
		act( () => publishSkippedLines( 'probe.p4', 41 ) );
		expect( container.textContent ).toBe(
			'Tail 9: 41 lines would not parse and were skipped.'
		);
	} );

	it( 'reads its own subscription’s count, not a neighbour’s', () => {
		const { stream } = mountExospine();
		stream.setField( 'unparseableByStamp', {
			'probe.p4': 0,
			'tail.p6': 58,
		} );
		const { container } = render(
			<>
				<UnparseableLinesNotice subscribe={ [ 'probe.p4' ] } />
				<UnparseableLinesNotice subscribe={ [ 'tail.p6' ] } />
			</>
		);
		expect( container.textContent ).toBe(
			'58 lines would not parse and were skipped.'
		);
	} );

	it( 'reads the link, not a count passed beside a subscription', () => {
		publishSkippedLines( 'probe.p4', 2 );
		const { container } = render(
			<UnparseableLinesNotice subscribe={ [ 'probe.p4' ] } count={ 90 } />
		);
		expect( container.textContent ).toBe(
			'2 lines would not parse and were skipped.'
		);
	} );

	it( 'renders nothing for stamps the page link has not counted', () => {
		mountExospine();
		publishSkippedLines( 'elsewhere.p2', 9 );
		const { container } = render(
			<UnparseableLinesNotice subscribe={ [ 'nowhere.p5' ] } />
		);
		expect( container.childNodes.length ).toBe( 0 );
	} );
} );
