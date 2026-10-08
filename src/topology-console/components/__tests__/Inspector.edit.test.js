/**
 * Inspector — edit-mode (EditForm) paths. Covers identity rename,
 * routing target field (single + Tee multi-chip), ctor field input
 * variants, verb checkbox + arg inputs, and the delete-node button.
 */

import { fireEvent, screen } from '@testing-library/react';
import Inspector from '../Inspector';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';
import brokerSchemas from '../../../../tests/fixtures/broker-schemas.json';

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
	sseSession: null,
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

/**
 * The values a combobox input offers through its `<datalist>`.
 *
 * @param {HTMLInputElement} input The `<input list>`.
 * @return {string[]} The suggested values, in order.
 */
function suggestionsOf( input ) {
	const list = document.getElementById( input.getAttribute( 'list' ) );
	return [ ...list.querySelectorAll( 'option' ) ].map( ( o ) => o.value );
}

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

	it( "shows a borrowed node's Routing section, editable like a declared node's", () => {
		const props = {
			...baseProps,
			selectedId: 'firehose:consumer',
			parsed: {
				nodes: [
					{
						id: 'firehose:consumer',
						class: 'Consumer',
						origin: [ 'request-builder' ],
						via: [ 'performance', 'request-builder' ],
						ctorArgs: [],
						verbInvocations: [],
					},
					{ id: 'request-builder', class: 'Tee', ctorArgs: [] },
				],
				edges: [ { from: 'firehose:consumer', to: 'request-builder' } ],
			},
			catalog: [
				{
					shell_name: 'Consumer',
					arguments: [],
					commands: [],
					has_target: true,
				},
				{ shell_name: 'Tee', arguments: [], commands: [] },
			],
		};
		const { getByText } = renderWithCatalog( <Inspector { ...props } />, {
			classes: props.catalog,
			formatters: props.formatters,
			vaults: props.vaults,
			composeTargets: props.composeTargets,
			classCatalog: props.classCatalog,
		} );

		// The lines THIS document aims at the borrowed node are its own to edit.
		expect( getByText( 'Routing' ) ).not.toBeNull();
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
							{ verb: 'void_warranty', args: [], seeded: true },
							{
								verb: 'with_index',
								args: [ 'quokka-idx' ],
								seeded: true,
							},
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
		// A verb the include never invoked is listed unticked — and ticking it
		// is how this document adds its OWN `cmd <node>:config` line.
		expect(
			document.getElementById( 'topology-verb-allow_large_writes' )
				.checked
		).toBe( false );
		// A verb's arg value is shown read-only.
		expect( getByDisplayValue( 'quokka-idx' ).disabled ).toBe( true );
	} );

	it( 'lets the document edit its OWN verbs on a borrowed node', () => {
		// stock hub-control.tsl is exactly this: `include settings-sync` plus
		// `cmd settings-sync:config add_setting ...` lines aimed at it. The
		// include's half stays read-only; the file's half is the file's.
		const onUpdateVerbs = jest.fn();
		const props = {
			...baseProps,
			selectedId: 'settings-sync',
			onUpdateVerbs,
			parsed: {
				nodes: [
					{
						id: 'settings-sync',
						class: 'Settings_Sync',
						origin: [ 'settings-sync' ],
						via: [ 'settings-sync' ],
						ctorArgs: [ '300' ],
						verbInvocations: [
							{
								verb: 'add_setting',
								args: [
									'from_the_include',
									'settings',
									'remote',
								],
								seeded: true,
							},
							{
								verb: 'add_setting',
								args: [
									'from_the_file',
									'performance',
									'remote',
								],
							},
						],
					},
				],
				edges: [],
			},
			catalog: [
				{
					shell_name: 'Settings_Sync',
					arguments: [ { name: 'interval' } ],
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
		const { getByDisplayValue } = renderWithCatalog(
			<Inspector { ...props } />,
			{
				classes: props.catalog,
				formatters: props.formatters,
				vaults: props.vaults,
				composeTargets: props.composeTargets,
				classCatalog: props.classCatalog,
			}
		);

		// The include's row is not ours to edit.
		expect( getByDisplayValue( 'from_the_include' ).disabled ).toBe( true );
		// The file's own row is.
		const mine = getByDisplayValue( 'from_the_file' );
		expect( mine.disabled ).toBeFalsy();
		fireEvent.change( mine, { target: { value: 'edited' } } );
		expect( onUpdateVerbs ).toHaveBeenCalled();
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
								seeded: true,
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
								seeded: true,
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
							{
								verb: 'add_target',
								args: [ 'alpha-sink' ],
								seeded: true,
							},
							{
								verb: 'add_target',
								args: [ 'beta-sink' ],
								seeded: true,
							},
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

	// An action RUNS something on a live node — `Table flush` deletes every row,
	// `Request_Builder purge` drops every in-flight request — so it is not
	// configuration, and a draft has no live node to run it on.
	it( 'hides verbs flagged action in node_schema from the edit Verbs list', () => {
		const { getByText, queryByText } = renderWithCatalog(
			<Inspector { ...baseProps } />,
			{
				classes: [
					{
						shell_name: 'Echo',
						arguments: [],
						commands: [
							{ name: 'visible_verb', args: [] },
							{ name: 'purge', args: [], action: true },
						],
					},
				],
			}
		);
		expect( getByText( 'visible_verb' ) ).not.toBeNull();
		expect( queryByText( 'purge' ) ).toBeNull();
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

	it( 'NameField: keeps the refused name with its refusal, to edit', () => {
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
		expect( input.value ).toBe( 'raced' );
		expect( container.textContent ).toMatch( /Rename refused/ );
		fireEvent.keyDown( input, { key: 'Escape' } );
		expect( input.value ).toBe( 'echo' );
	} );

	it( 'NameField: Escape restores the name and dispatches no rename', () => {
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
		input.focus();
		fireEvent.change( input, { target: { value: 'wip' } } );
		fireEvent.keyDown( input, { key: 'Escape' } );
		expect( onRenameNode ).not.toHaveBeenCalled();
		expect( input.value ).toBe( 'echo' );
		fireEvent.blur( input );
		expect( onRenameNode ).not.toHaveBeenCalled();
	} );

	it( 'NameField: Enter renames the node', () => {
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
		input.focus();
		fireEvent.change( input, { target: { value: 'beta' } } );
		const notPrevented = fireEvent.keyDown( input, { key: 'Enter' } );
		expect( notPrevented ).toBe( false );
		expect( onRenameNode ).toHaveBeenCalledTimes( 1 );
		expect( onRenameNode ).toHaveBeenCalledWith( 'echo', 'beta' );
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
			fireEvent.click( getByText( /^\+ add_setting$/ ) );
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

	describe( 'a variadic trailing constructor argument', () => {
		const vaultGroupArgs = [
			'Remote_Source',
			'spoke',
			'<config:offsets_dir>/<topology>.{id}',
			'<config:deadletter_dir>/<topology>.{id}',
			'firehose.p{partition}:remote-job-rewrite',
			'sources/php:php-errors:partition',
		];
		const tail = vaultGroupArgs.slice( 2 ).join( ' ' );
		const groupCatalog = brokerSchemas
			.filter( ( c ) => 'Vault_Group' === c.shell_name )
			.map( ( c ) => ( { ...c, commands: [] } ) );
		const groupProps = ( ctorArgs, onUpdateArgs ) => ( {
			...baseProps,
			selectedId: 'spokes',
			parsed: {
				nodes: [ { id: 'spokes', class: 'Vault_Group', ctorArgs } ],
				edges: [],
			},
			catalog: groupCatalog,
			onUpdateArgs,
		} );
		const vaults = [
			{ id: 'tw0', url: '', group: 'spoke' },
			{ id: 'cr0', url: '', group: 'crawler' },
		];

		it( 'keeps the group alone and shows the tail as child_args', () => {
			const { container } = renderWithCatalog(
				<Inspector { ...groupProps( vaultGroupArgs ) } />,
				{ classes: groupCatalog, vaults }
			);
			expect(
				container.querySelector( '#topology-ctor-group' ).value
			).toBe( 'spoke' );
			expect(
				[
					...container.querySelectorAll(
						'#topology-ctor-group option'
					),
				].map( ( o ) => o.value )
			).toEqual( [ '', 'crawler', 'spoke' ] );
			expect(
				container.querySelector( '#topology-ctor-child_args' ).value
			).toBe( tail );
		} );

		it( 'writes an edited child_args back as one tail string', () => {
			const onUpdateArgs = jest.fn();
			const { container } = renderWithCatalog(
				<Inspector { ...groupProps( vaultGroupArgs, onUpdateArgs ) } />,
				{ classes: groupCatalog, vaults }
			);
			fireEvent.change(
				container.querySelector( '#topology-ctor-child_args' ),
				{ target: { value: `${ tail } extra-heron` } }
			);
			expect( onUpdateArgs ).toHaveBeenCalledWith( 'spokes', [
				'Remote_Source',
				'spoke',
				`${ tail } extra-heron`,
			] );
		} );

		it( 'hands the tail back whole when the group is edited', () => {
			const onUpdateArgs = jest.fn();
			const { container } = renderWithCatalog(
				<Inspector { ...groupProps( vaultGroupArgs, onUpdateArgs ) } />,
				{ classes: groupCatalog, vaults }
			);
			fireEvent.change(
				container.querySelector( '#topology-ctor-group' ),
				{
					target: { value: 'crawler' },
				}
			);
			expect( onUpdateArgs ).toHaveBeenCalledWith( 'spokes', [
				'Remote_Source',
				'crawler',
				tail,
			] );
		} );

		it( 'shows a quoted tail word with its quotes', () => {
			const { container } = renderWithCatalog(
				<Inspector
					{ ...groupProps( [
						'Remote_Source',
						'spoke',
						'reed/{id}',
						'"pond heron"',
					] ) }
				/>,
				{ classes: groupCatalog, vaults }
			);
			expect(
				container.querySelector( '#topology-ctor-child_args' ).value
			).toBe( 'reed/{id} "pond heron"' );
		} );
	} );

	it( 'a written Remote_Source shows deadletter_root alone and pairs apart', () => {
		const sourceCatalog = brokerSchemas
			.filter( ( c ) => 'Remote_Source' === c.shell_name )
			.map( ( c ) => ( { ...c, commands: [] } ) );
		const { container } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="src"
				catalog={ sourceCatalog }
				parsed={ {
					nodes: [
						{
							id: 'src',
							class: 'Remote_Source',
							ctorArgs: [
								'tw0',
								'/ibis/offsets',
								'/ibis/dead',
								'egret.p0:heron',
								'crane:stork',
							],
						},
					],
					edges: [],
				} }
			/>,
			{ classes: sourceCatalog }
		);
		expect(
			container.querySelector( '#topology-ctor-deadletter_root' ).value
		).toBe( '/ibis/dead' );
		expect( container.querySelector( '#topology-ctor-pairs' ).value ).toBe(
			'egret.p0:heron crane:stork'
		);
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

	it( 'CtorField node_name: a text input suggesting the other draft nodes', () => {
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
		const input = container.querySelector( '#topology-ctor-route' );
		expect( input.tagName ).toBe( 'INPUT' );
		// The current node 'echo' is never its own suggestion.
		expect( suggestionsOf( input ) ).toEqual( [ 'sink' ] );
		fireEvent.change( input, { target: { value: 'sink' } } );
		expect( onUpdateArgs ).toHaveBeenLastCalledWith( 'echo', [ 'sink' ] );
	} );

	it( 'CtorField node_name: accepts a remote path and refuses a space', () => {
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
		const input = container.querySelector( '#topology-ctor-route' );
		fireEvent.change( input, {
			target: { value: ' _shell/_http/performance ' },
		} );
		expect( onUpdateArgs ).toHaveBeenLastCalledWith( 'echo', [
			'_shell/_http/performance',
		] );
		onUpdateArgs.mockClear();
		fireEvent.change( input, { target: { value: 'two words' } } );
		expect( onUpdateArgs ).not.toHaveBeenCalled();
		expect( container.textContent ).toMatch( /cannot hold a space/ );
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

	/**
	 * Renders the edit-mode Inspector on `echo` with one physical edge.
	 *
	 * @param {Object} props Extra Inspector props.
	 * @param {Array}  edges Draft edges.
	 * @return {Object} The render result.
	 */
	function renderSingle(
		props = {},
		edges = [ { from: 'echo', to: 'sink' } ]
	) {
		return renderWithCatalog(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{ id: 'echo', class: 'Echo' },
						{ id: 'sink', class: 'Echo' },
						{ id: 'spare', class: 'Echo' },
					],
					edges,
				} }
				{ ...props }
			/>,
			{ classes: baseProps.catalog }
		);
	}

	it( 'SingleTargetField: Enter on a typed remote path connects to it', () => {
		const onConnect = jest.fn();
		const { container } = renderSingle( { onConnect } );
		const input = container.querySelector( '#topology-target-input-echo' );
		expect( input.value ).toBe( 'sink' );
		fireEvent.change( input, {
			target: { value: '  _shell/_http/performance ' },
		} );
		expect( onConnect ).not.toHaveBeenCalled();
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConnect ).toHaveBeenCalledWith(
			'echo',
			'_shell/_http/performance'
		);
	} );

	it( 'SingleTargetField: suggests the other nodes and connects a pick at once', () => {
		const onConnect = jest.fn();
		const { container } = renderSingle( { onConnect } );
		const input = container.querySelector( '#topology-target-input-echo' );
		expect( suggestionsOf( input ) ).toEqual( [ 'sink', 'spare' ] );
		fireEvent.input( input, {
			target: { value: 'spare' },
			inputType: 'insertReplacementText',
		} );
		expect( onConnect ).toHaveBeenCalledWith( 'echo', 'spare' );
		fireEvent.blur( input );
		expect( onConnect ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'SingleTargetField: an unchanged value dispatches nothing', () => {
		const onConnect = jest.fn();
		const onRemoveEdge = jest.fn();
		const { container } = renderSingle( { onConnect, onRemoveEdge } );
		const input = container.querySelector( '#topology-target-input-echo' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		fireEvent.blur( input );
		expect( onConnect ).not.toHaveBeenCalled();
		expect( onRemoveEdge ).not.toHaveBeenCalled();
	} );

	it( 'SingleTargetField: clearing the input removes the physical edge', () => {
		const onRemoveEdge = jest.fn();
		const { container } = renderSingle( { onRemoveEdge } );
		const input = container.querySelector( '#topology-target-input-echo' );
		fireEvent.change( input, { target: { value: '' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'echo', 'sink' );
	} );

	it( 'SingleTargetField: Escape restores the current target', () => {
		const onConnect = jest.fn();
		const { container } = renderSingle( { onConnect } );
		const input = container.querySelector( '#topology-target-input-echo' );
		fireEvent.change( input, { target: { value: 'half/typed' } } );
		fireEvent.keyDown( input, { key: 'Escape' } );
		expect( input.value ).toBe( 'sink' );
		fireEvent.blur( input );
		expect( onConnect ).not.toHaveBeenCalled();
	} );

	it( 'SingleTargetField: refuses a value holding a space, with a hint', () => {
		const onConnect = jest.fn();
		const { container } = renderSingle( { onConnect } );
		const input = container.querySelector( '#topology-target-input-echo' );
		fireEvent.change( input, { target: { value: '_shell/_http perf' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		fireEvent.blur( input );
		expect( onConnect ).not.toHaveBeenCalled();
		expect( input.value ).toBe( '_shell/_http perf' );
		expect( container.textContent ).toMatch( /cannot hold a space/ );
	} );

	it( 'SingleTargetField: does not offer a config-only edge as its removable connection', () => {
		const onRemoveEdge = jest.fn();
		const { container } = renderSingle( { onRemoveEdge }, [
			{ from: 'echo', to: 'sink', roles: [ 'config' ] },
		] );
		const input = container.querySelector( '#topology-target-input-echo' );
		expect( input.value ).toBe( '' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onRemoveEdge ).not.toHaveBeenCalled();
	} );

	it( 'SingleTargetField: shows a current target the draft does not hold', () => {
		const { container } = renderSingle( {}, [
			{ from: 'echo', to: '_shell/_http/performance' },
		] );
		expect(
			container.querySelector( '#topology-target-input-echo' ).value
		).toBe( '_shell/_http/performance' );
	} );

	it( 'Tee TargetsField: renders chips per wired target + an add-target input', () => {
		const onConnect = jest.fn();
		const { container, getByPlaceholderText } = renderWithCatalog(
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
		const input = getByPlaceholderText( '+ add target…' );
		// 'a' is already wired, so only 'b' is suggested.
		expect( suggestionsOf( input ) ).toEqual( [ 'b' ] );
		fireEvent.change( input, { target: { value: 'b' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConnect ).toHaveBeenCalledWith( 'tee_a', 'b' );
	} );

	it( 'Tee TargetsField: Enter adds a typed remote path and clears the input', () => {
		const onConnect = jest.fn();
		const { getByPlaceholderText } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ { id: 'tee_a', class: 'Tee', target: [] } ],
					edges: [],
				} }
				onConnect={ onConnect }
			/>,
			{ classes: [ { shell_name: 'Tee', arguments: [], commands: [] } ] }
		);
		const input = getByPlaceholderText( '+ add target…' );
		fireEvent.change( input, {
			target: { value: '_shell/_http/performance' },
		} );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConnect ).toHaveBeenCalledWith(
			'tee_a',
			'_shell/_http/performance'
		);
		expect( input.value ).toBe( '' );
	} );

	it( 'Tee TargetsField: a blurred half-typed path wires nothing; Enter wires it', () => {
		const onConnect = jest.fn();
		const { getByPlaceholderText } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ { id: 'tee_a', class: 'Tee', target: [] } ],
					edges: [],
				} }
				onConnect={ onConnect }
			/>,
			{ classes: [ { shell_name: 'Tee', arguments: [], commands: [] } ] }
		);
		const input = getByPlaceholderText( '+ add target…' );
		fireEvent.change( input, { target: { value: 'egret:par' } } );
		fireEvent.blur( input );
		expect( onConnect ).not.toHaveBeenCalled();
		expect( input.value ).toBe( 'egret:par' );
		fireEvent.change( input, { target: { value: 'egret:partition' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConnect ).toHaveBeenCalledWith( 'tee_a', 'egret:partition' );
	} );

	it( 'Tee TargetsField: refuses a path holding a space', () => {
		const onConnect = jest.fn();
		const { container, getByPlaceholderText } = renderWithCatalog(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ { id: 'tee_a', class: 'Tee', target: [] } ],
					edges: [],
				} }
				onConnect={ onConnect }
			/>,
			{ classes: [ { shell_name: 'Tee', arguments: [], commands: [] } ] }
		);
		const input = getByPlaceholderText( '+ add target…' );
		fireEvent.change( input, { target: { value: 'two words' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConnect ).not.toHaveBeenCalled();
		expect( container.textContent ).toMatch( /cannot hold a space/ );
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
		const { container, getByPlaceholderText } = renderWithCatalog(
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
		const input = getByPlaceholderText( '+ add target…' );
		fireEvent.change( input, { target: { value: 'b' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
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
