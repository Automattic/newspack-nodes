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
} from '../consolePersistence';
import { TRANSCRIPT_MAX } from '../../../runtime/dumper-node';

// The transcript cap IS the Dumper's, so a restored transcript agrees with it.
const MAX_PERSISTED_TRANSCRIPT = TRANSCRIPT_MAX;
const MAX_PERSISTED_HISTORY = 100;

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
		// Separate keys so the hub console and debug overlay don't clobber.
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

/**
 * Vault CRUD is dispatched through the `_shell` Tap so it is observable via
 * `connect _shell` — and anything typed into the REPL is echoed verbatim as a
 * `sent` entry. Either way the transcript carried `--auth_password=hunter2`
 * into localStorage with no expiry. The server deliberately never returns that
 * password (Vault_CI_Node::public_shape strips it), so the browser was storing
 * in cleartext exactly what the API refuses to hand back.
 */
describe( 'transcript redaction', () => {
	beforeEach( () => window.localStorage.clear() );

	const stored = () =>
		window.localStorage.getItem( 'newspack-nodes:console:transcript' ) ??
		'';

	it( 'redacts a secret argument token in an echoed line', () => {
		saveTranscript( [
			{
				kind: 'sent',
				text: 'add prod --url=https://x --auth_password=hunter2',
			},
		] );

		expect( stored() ).not.toContain( 'hunter2' );
		expect( stored() ).toContain( 'auth_password' );
	} );

	it( 'redacts a secret inside a rendered command payload', () => {
		saveTranscript( [
			{
				kind: 'out',
				text: '{"name":"add","arguments":["prod","--auth_password=hunter2"]}',
			},
		] );

		expect( stored() ).not.toContain( 'hunter2' );
	} );

	it( 'leaves an ordinary line alone', () => {
		saveTranscript( [ { kind: 'sent', text: 'ls firehose.p0' } ] );

		expect( stored() ).toContain( 'ls firehose.p0' );
	} );

	/**
	 * A passphrase is the realistic case, and `Node::serialize_args()` quotes
	 * the WHOLE token once it holds whitespace — `'--auth_password=a b c'`.
	 * The value matcher stopped at the first space, so everything past it
	 * survived beside the redaction marker.
	 */
	it( 'redacts a passphrase in a serialize_args-quoted token', () => {
		saveTranscript( [
			{
				kind: 'sent',
				text: "vault:add prod '--auth_password=correct horse battery'",
			},
		] );

		expect( stored() ).not.toContain( 'horse' );
		expect( stored() ).not.toContain( 'battery' );
		expect( stored() ).toContain( 'auth_password' );
	} );

	it( 'redacts a passphrase in a double-quoted value', () => {
		saveTranscript( [
			{
				kind: 'sent',
				text: 'vault:add prod --auth_password="hunter two"',
			},
		] );

		expect( stored() ).not.toContain( 'hunter two' );
		expect( stored() ).toContain( 'auth_password' );
	} );

	it( 'redacts a passphrase in a single-quoted value', () => {
		saveTranscript( [
			{
				kind: 'sent',
				text: "vault:add prod --auth_password='hunter two'",
			},
		] );

		expect( stored() ).not.toContain( 'hunter' );
		expect( stored() ).not.toContain( 'two' );
	} );

	it( 'redacts a value carrying an escaped quote', () => {
		saveTranscript( [
			{
				kind: 'sent',
				text: "vault:add prod '--auth_password=oh\\'no yes'",
			},
		] );

		expect( stored() ).not.toContain( 'yes' );
	} );

	/**
	 * The bare-token pass ran last and unguarded, so it re-ate the quoted
	 * redaction the first pass had just produced and swallowed the closing
	 * quote. Only an exact-output assertion sees it; `not.toContain` cannot.
	 */
	it( 'leaves the quoting balanced when the whole token was quoted', () => {
		saveTranscript( [
			{
				kind: 'sent',
				text: "vault:add prod '--auth_password=correct horse battery'",
			},
		] );

		expect( JSON.parse( stored() )[ 0 ].text ).toBe(
			"vault:add prod '--auth_password=<redacted>'"
		);
	} );

	it( 'leaves the quoting balanced when only the value was quoted', () => {
		saveTranscript( [
			{ kind: 'sent', text: 'vault:add prod --auth_password="a b"' },
		] );

		expect( JSON.parse( stored() )[ 0 ].text ).toBe(
			'vault:add prod --auth_password="<redacted>"'
		);
	} );
} );

/**
 * History is written from the same keystroke as the transcript echo, and
 * ReplFooter hands it the verbatim typed line — so the passphrase masked under
 * `:transcript` sat in cleartext under `:history`, with no expiry.
 */
describe( 'history redaction', () => {
	beforeEach( () => window.localStorage.clear() );

	const storedHistory = () =>
		window.localStorage.getItem( 'newspack-nodes:console:history' ) ?? '';

	it( 'masks a secret argument token before persisting the typed line', () => {
		saveHistory( [ 'vault:add prod --auth_password=swordfish9000' ] );

		expect( storedHistory() ).not.toContain( 'swordfish9000' );
		expect( storedHistory() ).toContain( 'auth_password' );
		expect( loadHistory() ).toEqual( [
			'vault:add prod --auth_password=<redacted>',
		] );
	} );

	it( 'masks a quoted passphrase and leaves the line replayable', () => {
		saveHistory( [ "vault:add prod '--auth_password=gilded rutabaga'" ] );

		expect( storedHistory() ).not.toContain( 'rutabaga' );
		expect( loadHistory() ).toEqual( [
			"vault:add prod '--auth_password=<redacted>'",
		] );
	} );

	it( 'leaves an ordinary command line alone', () => {
		saveHistory( [ 'ls firehose.p0' ] );

		expect( loadHistory() ).toEqual( [ 'ls firehose.p0' ] );
	} );
} );
