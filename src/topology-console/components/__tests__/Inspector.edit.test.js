/**
 * Inspector — edit-mode (EditForm) paths. Covers identity rename,
 * routing target field (single + Tee multi-chip), ctor field input
 * variants, verb checkbox + arg inputs, and the delete-node button.
 */

import { fireEvent, screen } from '@testing-library/react';
import Inspector from '../Inspector';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';

const baseProps = {
	selectedId: 'echo',
	parsed: {
		nodes: [
			{ id: 'echo', class: 'Echo' },
			{ id: 'sink', class: 'Echo' },
		],
		edges: [],
	},
	streamStatus: 'open',
	rateInfo: null,
	onAction: () => {},
	onSelect: () => {},
	onHover: () => {},
	nodeIds: new Set(),
	ssePid: null,
	editMode: true,
	catalog: [
		{
			shell_name: 'Echo',
			arguments: [],
			commands: [],
		},
	],
	formatters: [],
};

describe( 'Inspector (edit mode)', () => {
	it( 'renders EDIT badge in the type row', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		expect( container.textContent ).toMatch( /EDIT/ );
	} );

	it( 'shows Delete node button and wires onRemoveNode', () => {
		const onRemoveNode = jest.fn();
		const { getByText } = renderWithCatalog(
			<Inspector { ...baseProps } onRemoveNode={ onRemoveNode } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		fireEvent.click( getByText( 'Delete node' ) );
		expect( onRemoveNode ).toHaveBeenCalledWith( 'echo' );
	} );

	it( "shows a borrowed node's configured verbs read-only", () => {
		const borrowedProps = {
			...baseProps,
			selectedId: 'errors:partition',
			parsed: {
				nodes: [
					{
						id: 'errors:partition',
						class: 'Partition',
						origin: [ 'request-builder' ],
						via: [ 'request-builder' ],
						ctorArgs: [],
						verbInvocations: [
							{ verb: 'void_warranty', args: [] },
							{ verb: 'with_index', args: [ 'quokka-idx' ] },
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Partition',
					arguments: [],
					commands: [
						{ name: 'allow_large_writes', args: [] },
						{ name: 'void_warranty', args: [] },
						{ name: 'with_index', args: [ { name: 'index' } ] },
					],
				},
			],
		};
		const { getByLabelText, getByDisplayValue } = renderWithCatalog(
			<Inspector { ...borrowedProps } />,
			{
				classes: borrowedProps.catalog,
				formatters: borrowedProps.formatters,
				vaults: borrowedProps.vaults,
				composeTargets: borrowedProps.composeTargets,
				classCatalog: borrowedProps.classCatalog,
			}
		);

		// Ticked verb: checked, but immutable here (borrowed).
		const ticked = getByLabelText( 'void_warranty' );
		expect( ticked.checked ).toBe( true );
		expect( ticked.disabled ).toBe( true );
		// Un-ticked verb still listed so you can see what's off.
		expect( getByLabelText( 'allow_large_writes' ).checked ).toBe( false );
		// A verb's arg value is shown read-only.
		expect( getByDisplayValue( 'quokka-idx' ).disabled ).toBe( true );
	} );

	it( 'shows a quoted borrowed verb arg as its VALUE, quotes stripped', () => {
		// The stored token is the raw TSL span; quotes are tokenizer syntax
		// and must not leak into the form field.
		const borrowedProps = {
			...baseProps,
			selectedId: 'digest',
			parsed: {
				nodes: [
					{
						id: 'digest',
						class: 'Digest_Builder',
						origin: [ 'newspack-intelligence-digest' ],
						via: [ 'newspack-intelligence-digest' ],
						ctorArgs: [],
						verbInvocations: [
							{
								verb: 'add_profile',
								args: [ '"Engineers build tools."' ],
							},
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Digest_Builder',
					arguments: [],
					commands: [
						{
							name: 'add_profile',
							multiple: true,
							args: [ { name: 'text' } ],
						},
					],
				},
			],
		};
		const { getByDisplayValue } = renderWithCatalog(
			<Inspector { ...borrowedProps } />,
			{
				classes: borrowedProps.catalog,
				formatters: borrowedProps.formatters,
				vaults: borrowedProps.vaults,
				composeTargets: borrowedProps.composeTargets,
				classCatalog: borrowedProps.classCatalog,
			}
		);
		expect( getByDisplayValue( 'Engineers build tools.' ).disabled ).toBe(
			true
		);
	} );

	it( 'absorbs a multi-token borrowed verb arg into its single declared slot', () => {
		// An unquoted `add_profile Do not produce tables.` parses to 4 tokens;
		// a one-arg verb must display the whole line, not just `Do`.
		const borrowedProps = {
			...baseProps,
			selectedId: 'digest',
			parsed: {
				nodes: [
					{
						id: 'digest',
						class: 'Digest_Builder',
						origin: [ 'newspack-intelligence-digest' ],
						via: [ 'newspack-intelligence-digest' ],
						ctorArgs: [],
						verbInvocations: [
							{
								verb: 'add_profile',
								args: [ 'Do', 'not', 'produce', 'tables.' ],
							},
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Digest_Builder',
					arguments: [],
					commands: [
						{
							name: 'add_profile',
							multiple: true,
							args: [ { name: 'text' } ],
						},
					],
				},
			],
		};
		const { getByDisplayValue } = renderWithCatalog(
			<Inspector { ...borrowedProps } />,
			{
				classes: borrowedProps.catalog,
				formatters: borrowedProps.formatters,
				vaults: borrowedProps.vaults,
				composeTargets: borrowedProps.composeTargets,
				classCatalog: borrowedProps.classCatalog,
			}
		);
		expect( getByDisplayValue( 'Do not produce tables.' ).disabled ).toBe(
			true
		);
	} );

	it( 'shows every invocation of a borrowed multiple-verb read-only', () => {
		const borrowedProps = {
			...baseProps,
			selectedId: 'fanout:tap',
			parsed: {
				nodes: [
					{
						id: 'fanout:tap',
						class: 'Tap',
						origin: [ 'request-builder' ],
						via: [ 'request-builder' ],
						ctorArgs: [],
						verbInvocations: [
							{ verb: 'add_target', args: [ 'alpha-sink' ] },
							{ verb: 'add_target', args: [ 'beta-sink' ] },
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Tap',
					arguments: [],
					commands: [
						{
							name: 'add_target',
							multiple: true,
							args: [ { name: 'target' } ],
						},
					],
				},
			],
		};
		const { getByDisplayValue } = renderWithCatalog(
			<Inspector { ...borrowedProps } />,
			{
				classes: borrowedProps.catalog,
				formatters: borrowedProps.formatters,
				vaults: borrowedProps.vaults,
				composeTargets: borrowedProps.composeTargets,
				classCatalog: borrowedProps.classCatalog,
			}
		);

		// Both invocations visible, not just the first.
		expect( getByDisplayValue( 'alpha-sink' ).disabled ).toBe( true );
		expect( getByDisplayValue( 'beta-sink' ).disabled ).toBe( true );
	} );

	it( 'hides verbs flagged hidden in node_schema from the edit Verbs list', () => {
		const { getByText, queryByText } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: [
					{
						shell_name: 'Echo',
						arguments: [],
						commands: [
							{ name: 'visible_verb', args: [] },
							{ name: 'seek_frame', args: [], hidden: true },
						],
					},
				],
			}
		);
		expect( getByText( 'visible_verb' ) ).not.toBeNull();
		expect( queryByText( 'seek_frame' ) ).toBeNull();
	} );

	it( 'surfaces a verb description as a tooltip in the edit Verbs list', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: [
					{
						shell_name: 'Echo',
						arguments: [],
						commands: [
							{
								name: 'assume_clean_shutdown',
								args: [],
								description: 'Commit past on a clean stop.',
							},
						],
					},
				],
			}
		);
		const tip = container.querySelector(
			'[title="Commit past on a clean stop."]'
		);
		expect( tip ).not.toBeNull();
		expect( tip.textContent ).toContain( 'assume_clean_shutdown' );
	} );

	it( 'NameField: commits rename on blur with a valid new name', () => {
		const onRenameNode = jest.fn().mockReturnValue( true );
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onRenameNode={ onRenameNode } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		fireEvent.change( input, { target: { value: 'alpha' } } );
		fireEvent.blur( input );
		expect( onRenameNode ).toHaveBeenCalledWith( 'echo', 'alpha' );
	} );

	it( 'NameField: surfaces validation error inline when name is empty', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		fireEvent.change( input, { target: { value: '' } } );
		fireEvent.blur( input );
		const hint = container.querySelector( '.topology-edit-row__hint' );
		expect( hint.textContent ).toMatch( /Name cannot be empty/ );
	} );

	it( 'NameField: surfaces validation error when name collides with another node', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		fireEvent.change( input, { target: { value: 'sink' } } );
		fireEvent.blur( input );
		expect( container.textContent ).toMatch( /already in use/ );
	} );

	it( 'NameField: rejects names with disallowed characters', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		fireEvent.change( input, { target: { value: 'bad/name' } } );
		fireEvent.blur( input );
		expect( container.textContent ).toMatch( /Letters, digits, dot, dash/ );
	} );

	it( 'NameField: snaps back when the caller refuses a rename', () => {
		const onRenameNode = jest.fn().mockReturnValue( false );
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onRenameNode={ onRenameNode } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		fireEvent.change( input, { target: { value: 'raced' } } );
		fireEvent.blur( input );
		expect( input.value ).toBe( 'echo' );
		expect( container.textContent ).toMatch( /Rename refused/ );
	} );

	it( 'NameField: Escape reverts the input to the original id', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		fireEvent.change( input, { target: { value: 'wip' } } );
		fireEvent.keyDown( input, { key: 'Escape' } );
		expect( input.value ).toBe( 'echo' );
	} );

	it( 'NameField: Enter preventDefaults and tries to blur', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const input = container.querySelector( '#topology-name-field' );
		input.focus();
		fireEvent.change( input, { target: { value: 'beta' } } );
		const event = fireEvent.keyDown( input, { key: 'Enter' } );
		// Verify the keyDown handler ran without throwing.
		expect( event ).toBe( false );
	} );

	describe( 'multiple verb (1 vs N invocations)', () => {
		const multiProps = {
			...baseProps,
			selectedId: 'ss',
			parsed: {
				nodes: [
					{
						id: 'ss',
						class: 'Settings_Sync',
						verbInvocations: [
							{
								verb: 'add_setting',
								args: [ 'a', 'settings', 'x' ],
							},
							{
								verb: 'add_setting',
								args: [ 'b', 'settings', 'y' ],
							},
							{
								verb: 'add_setting',
								args: [ 'c', 'settings', 'z' ],
							},
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Settings_Sync',
					arguments: [],
					commands: [
						{
							name: 'add_setting',
							multiple: true,
							args: [
								{ name: 'local_option' },
								{ name: 'to' },
								{ name: 'remote_option' },
							],
						},
					],
				},
			],
		};

		it( 'renders one editable row per invocation, not just the first', () => {
			const { container } = renderWithCatalog(
				<Inspector { ...multiProps } />,
				{
					classes: multiProps.catalog,
					formatters: multiProps.formatters,
					vaults: multiProps.vaults,
					composeTargets: multiProps.composeTargets,
					classCatalog: multiProps.classCatalog,
				}
			);
			const argBlocks = container.querySelectorAll(
				'.topology-edit-verb__args'
			);
			expect( argBlocks.length ).toBe( 3 );
		} );

		it( 'editing one arg of an over-long invocation keeps the other declared args', () => {
			// 4 tokens vs a 3-arg schema; editing `to` must keep other args.
			const onUpdateVerbs = jest.fn();
			const overlongProps = {
				...multiProps,
				parsed: {
					nodes: [
						{
							id: 'ss',
							class: 'Settings_Sync',
							verbInvocations: [
								{
									verb: 'add_setting',
									args: [ 'a', 'settings', 'x', 'extra' ],
								},
							],
						},
					],
					edges: [],
				},
			};
			const { container } = renderWithCatalog(
				<Inspector
					{ ...overlongProps }
					onUpdateVerbs={ onUpdateVerbs }
				/>,
				{
					classes: overlongProps.catalog,
					formatters: overlongProps.formatters,
					vaults: overlongProps.vaults,
					composeTargets: overlongProps.composeTargets,
					classCatalog: overlongProps.classCatalog,
				}
			);
			fireEvent.change( container.querySelector( '#topology-ctor-to' ), {
				target: { value: 'S' },
			} );
			expect( onUpdateVerbs ).toHaveBeenCalledWith( 'ss', [
				{ verb: 'add_setting', args: [ 'a', 'S', 'x extra' ] },
			] );
		} );

		it( 'Add appends a fresh invocation; remove drops the chosen one', () => {
			const onUpdateVerbs = jest.fn();
			const { getByText, container } = renderWithCatalog(
				<Inspector { ...multiProps } onUpdateVerbs={ onUpdateVerbs } />,
				{
					classes: multiProps.catalog,
					formatters: multiProps.formatters,
					vaults: multiProps.vaults,
					composeTargets: multiProps.composeTargets,
					classCatalog: multiProps.classCatalog,
				}
			);
			fireEvent.click( getByText( /Add add_setting/ ) );
			expect( onUpdateVerbs ).toHaveBeenCalledWith(
				'ss',
				expect.arrayContaining( [
					expect.objectContaining( {
						verb: 'add_setting',
						args: [ '', '', '' ],
					} ),
				] )
			);
			onUpdateVerbs.mockClear();
			const removes = container.querySelectorAll(
				'.topology-edit-verb__remove'
			);
			expect( removes.length ).toBe( 3 );
			fireEvent.click( removes[ 1 ] );
			expect( onUpdateVerbs ).toHaveBeenCalledWith( 'ss', [
				{ verb: 'add_setting', args: [ 'a', 'settings', 'x' ] },
				{ verb: 'add_setting', args: [ 'c', 'settings', 'z' ] },
			] );
		} );
	} );

	describe( 'free-text verb arg (spaces) absorbs trailing tokens', () => {
		// A free-text arg shows the WHOLE line, not just the first token.
		const freeTextProps = {
			...baseProps,
			selectedId: 'summarizer',
			parsed: {
				nodes: [
					{
						id: 'summarizer',
						class: 'Summarizer',
						verbInvocations: [
							{
								verb: 'add_profile',
								args: [ 'Engineers', 'building', 'tools' ],
							},
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Summarizer',
					arguments: [],
					commands: [
						{
							name: 'add_profile',
							multiple: true,
							args: [ { name: 'text', type: 'string' } ],
						},
					],
				},
			],
		};

		it( 'shows the full multi-token value in the input, not just the first token', () => {
			const { container } = renderWithCatalog(
				<Inspector { ...freeTextProps } />,
				{
					classes: freeTextProps.catalog,
					formatters: freeTextProps.formatters,
					vaults: freeTextProps.vaults,
					composeTargets: freeTextProps.composeTargets,
					classCatalog: freeTextProps.classCatalog,
				}
			);
			const input = container.querySelector( '#topology-ctor-text' );
			expect( input.value ).toBe( 'Engineers building tools' );
		} );

		it( 'editing collapses the tail so onUpdateVerbs gets a single-slot args array', () => {
			const onUpdateVerbs = jest.fn();
			const { container } = renderWithCatalog(
				<Inspector
					{ ...freeTextProps }
					onUpdateVerbs={ onUpdateVerbs }
				/>,
				{
					classes: freeTextProps.catalog,
					formatters: freeTextProps.formatters,
					vaults: freeTextProps.vaults,
					composeTargets: freeTextProps.composeTargets,
					classCatalog: freeTextProps.classCatalog,
				}
			);
			fireEvent.change(
				container.querySelector( '#topology-ctor-text' ),
				{ target: { value: 'Engineers building great tools' } }
			);
			expect( onUpdateVerbs ).toHaveBeenCalledWith( 'summarizer', [
				{
					verb: 'add_profile',
					args: [ 'Engineers building great tools' ],
				},
			] );
		} );
	} );

	describe( 'reserved anchor (_repl)', () => {
		const reservedProps = {
			...baseProps,
			selectedId: '_repl',
			parsed: {
				nodes: [
					{
						id: '_repl',
						class: 'Partition',
						reserved: true,
					},
					{ id: 'echo', class: 'Echo' },
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Partition',
					arguments: [
						{ name: 'base_dir', required: true },
						{ name: 'partition', required: true },
					],
					commands: [ { name: 'allow_large_writes', args: [] } ],
				},
				{ shell_name: 'Echo', arguments: [], commands: [] },
			],
		};

		it( 'hides the Delete node button for a reserved node', () => {
			const { queryByText } = renderWithCatalog(
				<Inspector { ...reservedProps } onRemoveNode={ jest.fn() } />
			);
			expect( queryByText( 'Delete node' ) ).toBeNull();
		} );

		it( 'hides the rename input for a reserved node', () => {
			const { container } = renderWithCatalog(
				<Inspector { ...reservedProps } onRenameNode={ jest.fn() } />
			);
			expect(
				container.querySelector( '#topology-name-field' )
			).toBeNull();
		} );

		it( 'still renders the reserved node title', () => {
			const { container } = renderWithCatalog(
				<Inspector { ...reservedProps } />,
				{
					classes: reservedProps.catalog,
					formatters: reservedProps.formatters,
					vaults: reservedProps.vaults,
					composeTargets: reservedProps.composeTargets,
					classCatalog: reservedProps.classCatalog,
				}
			);
			expect( container.textContent ).toMatch( /_repl/ );
		} );

		it( 'hides Routing, Constructor, and Verbs sections (no settings on a reserved node)', () => {
			// Reserved-node settings are fixed, not round-trippable via TSL.
			const { container, queryByText } = renderWithCatalog(
				<Inspector { ...reservedProps } />,
				{
					classes: reservedProps.catalog,
					formatters: reservedProps.formatters,
					vaults: reservedProps.vaults,
					composeTargets: reservedProps.composeTargets,
					classCatalog: reservedProps.classCatalog,
				}
			);
			expect( queryByText( 'Routing' ) ).toBeNull();
			expect( queryByText( 'Constructor' ) ).toBeNull();
			expect( queryByText( 'Verbs' ) ).toBeNull();
			// And the Partition's catalog fields must not slip through.
			expect( container.textContent ).not.toMatch( /base_dir/ );
			expect( container.textContent ).not.toMatch( /segment_size/ );
			expect( container.textContent ).not.toMatch( /allow_large_writes/ );
		} );
	} );

	it( 'hides the Routing section when the catalog schema says has_target is false', () => {
		const { queryByText } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{ classes: [ { shell_name: 'Echo', has_target: false } ] }
		);
		expect( queryByText( 'Routing' ) ).toBeNull();
	} );

	it( 'shows the Routing section when has_target defaults to true', () => {
		const { queryByText } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		expect( queryByText( 'Routing' ) ).not.toBeNull();
	} );

	it( 'Empty Constructor section: surfaces a placeholder', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		expect( container.textContent ).toMatch( /No constructor arguments/ );
	} );

	it( 'CtorField: renders ctor inputs from the schema and wires onUpdateArgs', () => {
		const onUpdateArgs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'name', type: 'string', required: true } ],
				commands: [],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onUpdateArgs={ onUpdateArgs } />,
			{ classes: catalog }
		);
		const input = container.querySelector( '#topology-ctor-name' );
		fireEvent.change( input, { target: { value: 'hello' } } );
		expect( onUpdateArgs ).toHaveBeenCalledWith( 'echo', [ 'hello' ] );
	} );

	it( 'CtorField: clears value via the × button', () => {
		const onUpdateArgs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'name', type: 'string' } ],
				commands: [],
			},
		];
		const parsed = {
			nodes: [
				{
					id: 'echo',
					class: 'Echo',
					ctorArgs: [ 'preset' ],
				},
			],
			edges: [],
		};
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ parsed }
				onUpdateArgs={ onUpdateArgs }
			/>,
			{ classes: catalog }
		);
		const clear = container.querySelector( '.topology-edit-row__reset' );
		fireEvent.click( clear );
		expect( onUpdateArgs ).toHaveBeenCalledWith( 'echo', [ '' ] );
	} );

	it( 'CtorField formatter_name: select renders registered formatters', () => {
		const onUpdateArgs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'format', type: 'formatter_name' } ],
				commands: [],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onUpdateArgs={ onUpdateArgs } />,
			{ classes: catalog, formatters: [ 'Plain', 'JSON' ] }
		);
		const select = container.querySelector( '#topology-ctor-format' );
		expect( select.tagName ).toBe( 'SELECT' );
		expect( select.options.length ).toBe( 3 ); // (pick…) + Plain + JSON
		fireEvent.change( select, { target: { value: 'JSON' } } );
		expect( onUpdateArgs ).toHaveBeenCalledWith( 'echo', [ 'JSON' ] );
	} );

	it( 'CtorField formatter_name: falls back to text input when no formatters', () => {
		const onUpdateArgs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'format', type: 'formatter_name' } ],
				commands: [],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onUpdateArgs={ onUpdateArgs } />,
			{ classes: catalog, formatters: [] }
		);
		const input = container.querySelector( '#topology-ctor-format' );
		expect( input.tagName ).toBe( 'INPUT' );
		fireEvent.change( input, { target: { value: 'Plain' } } );
		expect( onUpdateArgs ).toHaveBeenCalledWith( 'echo', [ 'Plain' ] );
	} );

	it( 'CtorField node_name: renders a select listing other draft nodes', () => {
		const onUpdateArgs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'route', type: 'node_name' } ],
				commands: [],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onUpdateArgs={ onUpdateArgs } />,
			{ classes: catalog }
		);
		const select = container.querySelector( '#topology-ctor-route' );
		expect( select.tagName ).toBe( 'SELECT' );
		// (pick a node) + sink (excludes the current node 'echo').
		expect( select.options.length ).toBe( 2 );
		fireEvent.change( select, { target: { value: 'sink' } } );
		expect( onUpdateArgs ).toHaveBeenCalledWith( 'echo', [ 'sink' ] );
	} );

	it( 'CtorField vault_id: threads the vaults prop through to render a select', () => {
		const onUpdateArgs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'vault_id', type: 'vault_id' } ],
				commands: [],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onUpdateArgs={ onUpdateArgs } />,
			{ classes: catalog, vaults: [ { id: 'austin', url: '' } ] }
		);
		const select = container.querySelector( '#topology-ctor-vault_id' );
		expect( select.tagName ).toBe( 'SELECT' );
		fireEvent.change( select, { target: { value: 'austin' } } );
		expect( onUpdateArgs ).toHaveBeenCalledWith( 'echo', [ 'austin' ] );
	} );

	it( 'CtorField bool defaults render as editable true/false strings', () => {
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [ { name: 'enabled', type: 'bool', default: true } ],
				commands: [],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{ classes: catalog }
		);
		expect(
			container.querySelector( '#topology-ctor-enabled' ).value
		).toBe( 'true' );
	} );

	it( 'Empty Verbs section: surfaces a placeholder', () => {
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		expect( container.textContent ).toMatch( /No verbs registered/ );
	} );

	it( 'VerbRow: toggling on appends a new invocation', () => {
		const onUpdateVerbs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [],
				commands: [ { name: 'reset', args: [] } ],
			},
		];
		const { container } = renderWithCatalog(
			<Inspector { ...baseProps } onUpdateVerbs={ onUpdateVerbs } />,
			{ classes: catalog }
		);
		const checkbox = container.querySelector( '#topology-verb-reset' );
		fireEvent.click( checkbox );
		expect( onUpdateVerbs ).toHaveBeenCalledWith( 'echo', [
			{ verb: 'reset', args: [] },
		] );
	} );

	it( 'VerbRow: toggling off removes the invocation', () => {
		const onUpdateVerbs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [],
				commands: [ { name: 'reset', args: [] } ],
			},
		];
		const parsed = {
			nodes: [
				{
					id: 'echo',
					class: 'Echo',
					verbInvocations: [ { verb: 'reset', args: [] } ],
				},
			],
			edges: [],
		};
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ parsed }
				onUpdateVerbs={ onUpdateVerbs }
			/>,
			{ classes: catalog }
		);
		fireEvent.click( container.querySelector( '#topology-verb-reset' ) );
		expect( onUpdateVerbs ).toHaveBeenCalledWith( 'echo', [] );
	} );

	it( 'VerbRow: changing an enabled verb arg rewrites that invocation args array', () => {
		const onUpdateVerbs = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				arguments: [],
				commands: [
					{
						name: 'set_target',
						args: [ { name: 'target', type: 'string' } ],
					},
				],
			},
		];
		const parsed = {
			nodes: [
				{
					id: 'echo',
					class: 'Echo',
					verbInvocations: [
						{ verb: 'set_target', args: [ 'old' ] },
					],
				},
			],
			edges: [],
		};
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ parsed }
				onUpdateVerbs={ onUpdateVerbs }
			/>,
			{ classes: catalog }
		);
		fireEvent.change( container.querySelector( '#topology-ctor-target' ), {
			target: { value: 'new' },
		} );
		expect( onUpdateVerbs ).toHaveBeenCalledWith( 'echo', [
			{ verb: 'set_target', args: [ 'new' ] },
		] );
	} );

	it( 'SingleTargetField: select onChange fires onConnect when picking a new target', () => {
		const onConnect = jest.fn();
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{ id: 'echo', class: 'Echo' },
						{ id: 'sink', class: 'Echo' },
					],
					edges: [],
				} }
				onConnect={ onConnect }
			/>,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const select = container.querySelector( '#topology-target-input-echo' );
		fireEvent.change( select, { target: { value: 'sink' } } );
		expect( onConnect ).toHaveBeenCalledWith( 'echo', 'sink' );
	} );

	it( 'SingleTargetField: select onChange to empty fires onRemoveEdge for the physical edge', () => {
		const onRemoveEdge = jest.fn();
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{ id: 'echo', class: 'Echo' },
						{ id: 'sink', class: 'Echo' },
					],
					edges: [ { from: 'echo', to: 'sink' } ],
				} }
				onRemoveEdge={ onRemoveEdge }
			/>,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const select = container.querySelector( '#topology-target-input-echo' );
		fireEvent.change( select, { target: { value: '' } } );
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'echo', 'sink' );
	} );

	it( 'SingleTargetField: does not offer a config-only edge as its removable connection', () => {
		const onRemoveEdge = jest.fn();
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{ id: 'echo', class: 'Echo' },
						{ id: 'ibex-config', class: 'Echo' },
					],
					edges: [
						{
							from: 'echo',
							to: 'ibex-config',
							roles: [ 'config' ],
						},
					],
				} }
				onRemoveEdge={ onRemoveEdge }
			/>,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const select = container.querySelector( '#topology-target-input-echo' );
		expect( select.value ).toBe( '' );
		fireEvent.change( select, { target: { value: '' } } );
		expect( onRemoveEdge ).not.toHaveBeenCalled();
	} );

	it( 'SingleTargetField: includes a current target missing from the draft node list', () => {
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [ { from: 'echo', to: 'external' } ],
				} }
			/>,
			{
				classes: baseProps.catalog,
				formatters: baseProps.formatters,
				vaults: baseProps.vaults,
				composeTargets: baseProps.composeTargets,
				classCatalog: baseProps.classCatalog,
			}
		);
		const values = [
			...container.querySelector( '#topology-target-input-echo' ).options,
		].map( ( option ) => option.value );
		expect( values ).toContain( 'external' );
	} );

	it( 'Tee TargetsField: renders chips per wired target + an add-target select', () => {
		const onConnect = jest.fn();
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [
						{ id: 'tee_a', class: 'Tee', target: [ 'a' ] },
						{ id: 'a', class: 'Echo' },
						{ id: 'b', class: 'Echo' },
					],
					edges: [ { from: 'tee_a', to: 'a' } ],
				} }
				onConnect={ onConnect }
			/>,
			{ classes: [ { shell_name: 'Tee', arguments: [], commands: [] } ] }
		);
		expect(
			container.querySelectorAll( '.topology-edit-chip' )
		).toHaveLength( 1 );
		const select = container.querySelector( '.topology-edit-add-chip' );
		// Adds 'b' (a is already wired).
		fireEvent.change( select, { target: { value: 'b' } } );
		expect( onConnect ).toHaveBeenCalledWith( 'tee_a', 'b' );
	} );

	it( 'Tee TargetsField: clears a wired target via chip × button', () => {
		const onRemoveEdge = jest.fn();
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [
						{ id: 'tee_a', class: 'Tee', target: [ 'a' ] },
						{ id: 'a', class: 'Echo' },
					],
					edges: [ { from: 'tee_a', to: 'a' } ],
				} }
				onRemoveEdge={ onRemoveEdge }
			/>,
			{ classes: [ { shell_name: 'Tee', arguments: [], commands: [] } ] }
		);
		const clear = container.querySelector( '.topology-edit-chip__clear' );
		fireEvent.click( clear );
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'tee_a', 'a' );
	} );

	it( 'TargetsField: a Tee SUBCLASS renders the multi-chip field driven by the catalog fans_out flag (edit-mode string target)', () => {
		// Edit-mode target is a STRING; multi-chip editor keys off fans_out.
		const onConnect = jest.fn();
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tap_a"
				parsed={ {
					nodes: [
						{ id: 'tap_a', class: 'Tap', target: 'a' },
						{ id: 'a', class: 'Echo' },
						{ id: 'b', class: 'Echo' },
					],
					edges: [ { from: 'tap_a', to: 'a' } ],
				} }
				onConnect={ onConnect }
			/>,
			{
				classes: [
					{
						shell_name: 'Tap',
						fans_out: true,
						arguments: [],
						commands: [],
					},
				],
			}
		);
		expect(
			container.querySelectorAll( '.topology-edit-chip' )
		).toHaveLength( 1 );
		const select = container.querySelector( '.topology-edit-add-chip' );
		fireEvent.change( select, { target: { value: 'b' } } );
		expect( onConnect ).toHaveBeenCalledWith( 'tap_a', 'b' );
	} );

	it( 'renders a borrowed node read-only, with its breadcrumb and no delete', () => {
		const node = {
			id: 'shared-tee',
			name: 'shared-tee',
			class: 'Tee',
			ctorArgs: [],
			verbInvocations: [],
			origin: [ 'performance' ],
			via: [ 'performance', 'request-builder' ],
		};
		renderWithCatalog(
			<Inspector
				selectedId="shared-tee"
				parsed={ { nodes: [ node ], edges: [] } }
				editMode
				onRemoveNode={ jest.fn() }
			/>,
			{ classes: [] }
		);
		expect(
			screen.getByText( /via performance → request-builder/ )
		).not.toBeNull();
		expect(
			screen.queryByRole( 'button', { name: /delete/i } )
		).toBeNull();
	} );

	it( 'Tee TargetsField: shows an empty hint when there are no available targets', () => {
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ { id: 'tee_a', class: 'Tee', target: [] } ],
					edges: [],
				} }
			/>,
			{ classes: [ { shell_name: 'Tee', arguments: [], commands: [] } ] }
		);
		expect( container.textContent ).toMatch( /No other nodes to wire/ );
	} );

	// The include tree is FILE-scoped ("the authoritative include structure for
	// the file being edited"); a node selection is a different scope.
	it( 'leaves the file-scoped include tree out of a node-selected panel', () => {
		renderWithCatalog(
			<Inspector
				{ ...baseProps }
				tree={ { performance: { echo: {} } } }
				includes={ [ 'performance' ] }
				onRemoveInclude={ () => {} }
			/>
		);

		expect( screen.queryByText( 'Includes' ) ).toBeNull();
	} );
} );
