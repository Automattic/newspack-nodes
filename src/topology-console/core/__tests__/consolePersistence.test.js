import {
	loadTranscript,
	saveTranscript,
	loadHistory,
	saveHistory,
	loadDebugLevel,
	saveDebugLevel,
	loadDebugState,
	saveDebugState,
	MAX_PERSISTED_TRANSCRIPT,
	MAX_PERSISTED_HISTORY,
} from '../consolePersistence';

beforeEach( () => window.localStorage.clear() );

describe( 'consolePersistence [87]', () => {
	it( 'round-trips the transcript, capping to the most-recent N', () => {
		expect( loadTranscript() ).toEqual( [] ); // empty default
		const entries = Array.from(
			{ length: MAX_PERSISTED_TRANSCRIPT + 50 },
			( _, i ) => ( {
				kind: 'sent',
				text: `line ${ i }`,
			} )
		);
		saveTranscript( entries );
		const loaded = loadTranscript();
		expect( loaded ).toHaveLength( MAX_PERSISTED_TRANSCRIPT );
		// Kept the tail (most recent), dropped the oldest.
		expect( loaded[ loaded.length - 1 ].text ).toBe(
			`line ${ MAX_PERSISTED_TRANSCRIPT + 49 }`
		);
	} );

	it( 'round-trips command history, capping to the most-recent N', () => {
		expect( loadHistory() ).toEqual( [] );
		const cmds = Array.from(
			{ length: MAX_PERSISTED_HISTORY + 10 },
			( _, i ) => `cmd ${ i }`
		);
		saveHistory( cmds );
		const loaded = loadHistory();
		expect( loaded ).toHaveLength( MAX_PERSISTED_HISTORY );
		expect( loaded[ loaded.length - 1 ] ).toBe(
			`cmd ${ MAX_PERSISTED_HISTORY + 9 }`
		);
	} );

	it( 'round-trips debug_level and debug_state as integers', () => {
		expect( loadDebugLevel() ).toBe( 0 ); // default
		expect( loadDebugState() ).toBe( 0 );
		saveDebugLevel( 2 );
		saveDebugState( 1 );
		expect( loadDebugLevel() ).toBe( 2 );
		expect( loadDebugState() ).toBe( 1 );
	} );

	it( 'returns safe defaults for corrupt / non-array stored values', () => {
		window.localStorage.setItem(
			'newspack-nodes:console:transcript',
			'{not json'
		);
		window.localStorage.setItem(
			'newspack-nodes:console:history',
			'"a string"'
		);
		window.localStorage.setItem(
			'newspack-nodes:console:debug-level',
			'NaN'
		);
		expect( loadTranscript() ).toEqual( [] );
		expect( loadHistory() ).toEqual( [] );
		expect( loadDebugLevel() ).toBe( 0 );
	} );
} );
