/* @jest-environment node */
/* eslint-env jest */
/**
 * **Edit layout** is a menu entry that loads the page naming the edit, every
 * param the page holds kept. It runs where `window` is a plain object,
 * because jsdom's `location` can be neither replaced nor spied on.
 */

import { editLayoutControl } from '../editMode';

const PAGES = { board: { view: 'boards', subject: 'board' } };

afterEach( () => {
	delete global.window;
} );

it( 'is titled Edit layout and loads the edit when chosen', () => {
	const assign = jest.fn();
	global.window = { location: { search: '?tide=high', assign } };

	const entry = editLayoutControl(
		{ page: 'board', board_key: 'k7' },
		PAGES
	);
	entry.onClick();

	expect( entry.title ).toBe( 'Edit layout' );
	expect( assign ).toHaveBeenCalledWith(
		'?tide=high&view=boards&edit=board&board=k7'
	);
} );
