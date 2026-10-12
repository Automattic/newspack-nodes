/**
 * The one spelling of a subject riding on FROM and read back off a reply's
 * remaining TO, which every node that asks about a subject shares.
 */

import { replyAddress, replySubject } from '../reply-subject';
import { newMessage, TO } from '../message';

/**
 * A reply as the Router hands it on: its remaining TO.
 *
 * @param {string} to The remaining TO.
 * @return {Array} The message.
 */
const replyTo = ( to ) => {
	const m = newMessage();
	m[ TO ] = to;
	return m;
};

describe( 'reply subjects', () => {
	it( 'appends a subject to FROM as one escaped segment', () => {
		expect( replyAddress( 'vat:fetch', 'vat/2290 lid' ) ).toBe(
			'vat:fetch/vat%2F2290%20lid'
		);
	} );

	it( 'addresses the bare node when there is no subject', () => {
		expect( replyAddress( 'vat:fetch', null ) ).toBe( 'vat:fetch' );
	} );

	it( 'reads the subject back off the remaining TO', () => {
		expect( replySubject( replyTo( 'vat%2F2290%20lid' ) ) ).toBe(
			'vat/2290 lid'
		);
	} );

	it( 'reads no subject off an escape no reply address of ours carries', () => {
		expect( replySubject( replyTo( 'kea%zz7731' ) ) ).toBeNull();
	} );

	it( 'reads no subject off a reply addressed to the node itself', () => {
		expect( replySubject( replyTo( '' ) ) ).toBeNull();
	} );
} );
