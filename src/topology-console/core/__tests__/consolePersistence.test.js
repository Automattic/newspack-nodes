import {
	loadTranscript,
	saveTranscript,
	loadHubTranscript,
	saveHubTranscript,
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

	it( 'round-trips the hub-console transcript under its OWN key, independent of the overlay transcript', () => {
		expect( loadHubTranscript() ).toEqual( [] ); // empty default
		saveHubTranscript( [ { kind: 'recv', text: 'worker line' } ] );
		saveTranscript( [ { kind: 'sent', text: 'overlay line' } ] );
		// Separate keys: the hub console (worker realm) must not share storage
		// with the local-only debug overlay, or one would clobber the other.
		expect( loadHubTranscript() ).toEqual( [
			{ kind: 'recv', text: 'worker line' },
		] );
		expect( loadTranscript() ).toEqual( [
			{ kind: 'sent', text: 'overlay line' },
		] );
	} );

	it( 'caps the hub transcript to the most-recent N like the overlay transcript', () => {
		const entries = Array.from(
			{ length: MAX_PERSISTED_TRANSCRIPT + 50 },
			( _, i ) => ( { kind: 'recv', text: `line ${ i }` } )
		);
		saveHubTranscript( entries );
		const loaded = loadHubTranscript();
		expect( loaded ).toHaveLength( MAX_PERSISTED_TRANSCRIPT );
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
