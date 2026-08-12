import { resolveSkin, formatSkinList, makeSkinHost } from '../skinCommands';

const SKINS = [
	{ slug: 'newspack', label: 'Newspack' },
	{ slug: 'newspack-brand', label: 'Newspack Brand' },
	{ slug: 'current', label: 'Drafting Plotter' },
	{ slug: 'crt', label: 'CRT Phosphor Terminal' },
	{ slug: 'blueprint', label: 'Cyanotype Blueprint' },
];

describe( 'resolveSkin', () => {
	it( 'matches an exact slug case-insensitively', () => {
		expect( resolveSkin( 'CRT', SKINS ) ).toBe( 'crt' );
		expect( resolveSkin( 'newspack', SKINS ) ).toBe( 'newspack' );
	} );

	it( 'prefers the exact slug over a longer slug that shares a prefix', () => {
		// "Newspack" must land on `newspack`, not `newspack-brand`.
		expect( resolveSkin( 'Newspack', SKINS ) ).toBe( 'newspack' );
	} );

	it( 'matches a full label case-insensitively', () => {
		expect( resolveSkin( 'Newspack Brand', SKINS ) ).toBe(
			'newspack-brand'
		);
	} );

	it( 'matches a label by prefix (the spaced form the user types)', () => {
		// `set_skin CRT Phosphor` → label "CRT Phosphor Terminal".
		expect( resolveSkin( 'CRT Phosphor', SKINS ) ).toBe( 'crt' );
	} );

	it( 'matches a slug by prefix when no label matches', () => {
		expect( resolveSkin( 'blue', SKINS ) ).toBe( 'blueprint' );
	} );

	it( 'returns null for an unknown name', () => {
		expect( resolveSkin( 'nonsense', SKINS ) ).toBe( null );
	} );

	it( 'returns null for empty/blank/nullish input', () => {
		[ '', '   ', undefined, null ].forEach( ( n ) =>
			expect( resolveSkin( n, SKINS ) ).toBe( null )
		);
	} );
} );

describe( 'formatSkinList', () => {
	it( 'emits one `slug — Label` line per skin', () => {
		const lines = formatSkinList( SKINS, 'newspack' );
		expect( lines ).toHaveLength( SKINS.length );
		expect( lines[ 3 ] ).toContain( 'crt' );
		expect( lines[ 3 ] ).toContain( 'CRT Phosphor Terminal' );
	} );

	it( 'marks the current skin and only the current skin', () => {
		const lines = formatSkinList( SKINS, 'crt' );
		const marked = lines.filter( ( l ) => l.trim().startsWith( '*' ) );
		expect( marked ).toHaveLength( 1 );
		expect( marked[ 0 ] ).toContain( 'crt' );
	} );
} );

describe( 'makeSkinHost', () => {
	function harness() {
		const printed = [];
		const applied = [];
		const host = makeSkinHost( {
			skins: SKINS,
			currentSkin: () => 'blueprint',
			applySkin: ( slug ) => applied.push( slug ),
			print: ( text ) => printed.push( text ),
		} );
		return { host, printed, applied };
	}

	it( 'setSkin resolves the typed name, applies the slug and reports the label', () => {
		const { host, printed, applied } = harness();
		host.setSkin( 'CRT Phosphor' );
		expect( applied ).toEqual( [ 'crt' ] );
		expect( printed.join( '' ) ).toBe( 'skin: CRT Phosphor Terminal\n' );
	} );

	it( 'setSkin refuses an unknown name without applying anything', () => {
		const { host, printed, applied } = harness();
		host.setSkin( 'vellum' );
		expect( applied ).toEqual( [] );
		expect( printed.join( '' ) ).toBe(
			"set_skin: unknown skin 'vellum' (try list_skins)\n"
		);
	} );

	it( 'listSkins prints the registry, marking the active slug', () => {
		const { host, printed } = harness();
		host.listSkins();
		expect( printed.join( '' ) ).toContain(
			'* blueprint — Cyanotype Blueprint\n'
		);
		expect( printed.join( '' ) ).toContain(
			'  crt — CRT Phosphor Terminal\n'
		);
	} );
} );
