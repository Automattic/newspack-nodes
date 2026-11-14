/* eslint-env jest */
/**
 * useSubjectAnswers — each subject's last answer, filed by the reply that
 * named it, as a screen of rows shows it: a row keeps its own answer while a
 * sibling is answered.
 */

import { act, renderHook } from '@testing-library/react';
import { useSubjectAnswers } from '../useSubjectAnswers';

it( 'files each answer under the subject it names', () => {
	const { result } = renderHook( () => useSubjectAnswers() );
	act( () =>
		result.current.file( 'kea-7892', { verb: 'test', error: null } )
	);
	act( () =>
		result.current.file( 'kaka-7892', {
			verb: 'delete',
			error: 'refused 7892',
		} )
	);
	expect( result.current.answerFor( 'kea-7892' ) ).toEqual( {
		verb: 'test',
		error: null,
	} );
	expect( result.current.answerFor( 'kaka-7892' ) ).toEqual( {
		verb: 'delete',
		error: 'refused 7892',
	} );
} );

it( 'answers null for a subject no reply has named', () => {
	const { result } = renderHook( () => useSubjectAnswers() );
	expect( result.current.answerFor( 'weka-7892' ) ).toBeNull();
} );

it( 'replaces a subject’s answer with its next', () => {
	const { result } = renderHook( () => useSubjectAnswers() );
	act( () =>
		result.current.file( 'kea-7892', { verb: 'test', error: 'a' } )
	);
	act( () =>
		result.current.file( 'kea-7892', { verb: 'test', error: null } )
	);
	expect( result.current.answerFor( 'kea-7892' ).error ).toBeNull();
} );

it( 'answers null for a subject named after an Object member', () => {
	const { result } = renderHook( () => useSubjectAnswers() );
	expect( result.current.answerFor( 'constructor' ) ).toBeNull();
	expect( result.current.answerFor( 'toString' ) ).toBeNull();
} );
