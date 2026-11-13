/* eslint-env jest */
/**
 * A page's layout is edited on the page it lays out, opened by a link naming
 * the page and, for a page that takes one, the subject it was opened from;
 * anything else names no edit. The consumer hands in its own map of pages.
 */

import { editSearch, editTarget, leaveEdit } from '../editMode';

/** A board on its own tab, a digest with no subject, a profile with no tab. */
const PAGES = {
	board: { view: 'boards', subject: 'board' },
	digest: { view: 'digests', subject: null },
	profile: { view: null, subject: 'profile' },
};

afterEach( () => {
	window.history.replaceState( {}, '', '/' );
} );

describe( 'editTarget', () => {
	it( 'reads the page and the subject the link names', () => {
		expect( editTarget( '?edit=board&board=k7', PAGES ) ).toEqual( {
			page: 'board',
			board_key: 'k7',
		} );
		expect( editTarget( '?tide=high&edit=digest', PAGES ) ).toEqual( {
			page: 'digest',
		} );
	} );

	it( 'names no edit for a page the map does not hold, or none', () => {
		expect( editTarget( '?edit=ledger&board=k7', PAGES ) ).toBeNull();
		expect( editTarget( '?view=boards', PAGES ) ).toBeNull();
		expect( editTarget( '', PAGES ) ).toBeNull();
	} );

	it( 'leaves out a subject the page does not take, or a blank one', () => {
		expect( editTarget( '?edit=digest&board=k7', PAGES ) ).toEqual( {
			page: 'digest',
		} );
		expect( editTarget( '?edit=board&board=', PAGES ) ).toEqual( {
			page: 'board',
		} );
	} );
} );

describe( 'editSearch', () => {
	it( 'sets the view, the edit and the subject, every other param kept', () => {
		const search = editSearch(
			'?view=home&profile=p9&tide=high',
			{ page: 'board', board_key: 'k7' },
			PAGES
		);

		expect( search ).toBe( '?view=boards&tide=high&edit=board&board=k7' );
		expect( editTarget( search, PAGES ) ).toEqual( {
			page: 'board',
			board_key: 'k7',
		} );
	} );

	it( 'keeps the view a page with no tab of its own stands over', () => {
		expect(
			editSearch(
				'?view=boards&board=k7',
				{ page: 'profile', profile_key: 'heron' },
				PAGES
			)
		).toBe( '?view=boards&edit=profile&profile=heron' );
	} );
} );

describe( 'leaveEdit', () => {
	it( 'drops the edit and every subject, and keeps every other param', () => {
		window.history.replaceState(
			{},
			'',
			'/wp-admin/admin.php?view=boards&edit=board&board=k7&profile=p9&tide=high'
		);

		leaveEdit( PAGES );

		expect( window.location.search ).toBe( '?view=boards&tide=high' );
	} );
} );
