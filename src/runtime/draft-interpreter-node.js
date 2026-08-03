/**
 * DraftInterpreterNode — the console's edit buffer, as an interpreter.
 *
 * Edit mode and live mode send the SAME commands; the difference is which
 * interpreter they reach, which is a cwd. This is the edit-mode one. It differs
 * from the live interpreter in exactly three ways, each deliberate:
 *
 *   1. **`make_node` stubs.** A server topology names `Partition`, `Topic`,
 *      `Consumer`, `Job_Worker` — no JS implementation. A stub carries the
 *      declared class and arguments so every structural verb still applies.
 *   2. **`move_node` rewrites references.** Live it is `$node->name($new)` and
 *      nothing else, stranding every target that named the old node — faithful
 *      to Tachikoma, and indefensible in an editor.
 *   3. **Document verbs.** `var`, `include`, `remove_include` and `secure`
 *      belong to a FILE, not a graph, and touch no node table. `secure` is a
 *      one-way ratchet live, because that irreversibility is the security
 *      property; here it edits a line, both directions.
 *
 * Its nodes live in its own registry, so a draft `firehose` is not the live
 * one. The interpreter itself is registered normally — the Tachikoma Job shape,
 * where the job's node sits in the parent table and its contents do not.
 */

import { CommandInterpreterNode } from './command-interpreter-node';
import { NodeRegistry } from './node-registry';
import { StubNode } from './stub-node';
import { markLocal } from './command-auth';
import { parseStatements } from './shell-node';
import { newMessage, TYPE, VALUE, TM_COMMAND } from './message';

export class DraftInterpreterNode extends CommandInterpreterNode {
	constructor() {
		super();
		// Its CONTENTS live here; it lives where it is named.
		this.childRegistry = new NodeRegistry();
		this.frontmatter = {};
		this.includes = [];
		this.secureLevel = '';
		this.commands( {
			var: ( self, args ) => self._cmdVar( args ),
			include: ( self, args ) => self._cmdInclude( args ),
			remove_include: ( self, args ) => self._cmdRemoveInclude( args ),
			secure: ( self, args ) => self._cmdDraftSecure( args ),
		} );
	}

	/**
	 * Run one TSL statement, as the Shell would.
	 *
	 * @param {string} line A single statement.
	 */
	run( line ) {
		for ( const statement of parseStatements( line ) ) {
			const [ verb, ...values ] = statement.values;
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ VALUE ] = { name: verb, arguments: values };
			this.fill( markLocal( m ) );
		}
	}

	/**
	 * Replace the whole document. Loading is not a verb — see DraftContext.
	 *
	 * @param {string} tsl Topology source.
	 */
	load( tsl ) {
		this.frontmatter = {};
		this.includes = [];
		this.secureLevel = '';
		for ( const name of [ ...this.childRegistry.nodes.keys() ] ) {
			this.childRegistry.node( name )?.removeNode();
		}
		this.run( tsl );
	}

	// A class this runtime cannot build is a node to DESCRIBE, not an error.
	_cmdMakeNode( args ) {
		if ( args.length < 2 ) {
			return super._cmdMakeNode( args );
		}
		const [ type, name ] = args;
		if ( CommandInterpreterNode.resolveClass( type ) ) {
			return super._cmdMakeNode( args );
		}
		const node = new StubNode();
		node.registry = this.childRegistry;
		node.shellName = type;
		node.name = name;
		node.arguments = args.slice( 2 );
		node.sink = this;
		node.defaultSink = this;
		return 'ok';
	}

	// Unlike the live verb, references follow the rename.
	_cmdMove( args ) {
		const [ from, to ] = args;
		const result = super._cmdMove( args );
		if ( 'ok' !== result || ! from || ! to ) {
			return result;
		}
		for ( const [ , node ] of this.childRegistry.nodes ) {
			if ( Array.isArray( node.target ) ) {
				node.target = node.target.map( ( t ) =>
					t === from ? to : t
				);
			} else if ( node.target === from ) {
				node.target = to;
			}
		}
		return result;
	}

	_cmdVar( args ) {
		// `var name = value`; the tokenizer keeps `=` as its own token.
		const [ name, , ...rest ] = args;
		if ( ! name ) {
			return 'usage: var <name> = <value>';
		}
		this.frontmatter[ name ] = rest.join( ' ' );
		return 'ok';
	}

	_cmdInclude( args ) {
		const name = args[ 0 ] ?? '';
		if ( ! name ) {
			return 'usage: include <topology>';
		}
		if ( ! this.includes.includes( name ) ) {
			this.includes.push( name );
		}
		return 'ok';
	}

	_cmdRemoveInclude( args ) {
		const name = args[ 0 ] ?? '';
		this.includes = this.includes.filter( ( n ) => n !== name );
		return 'ok';
	}

	// Freely reversible here; the live ratchet is a security property.
	_cmdDraftSecure( args ) {
		this.secureLevel = args[ 0 ] ?? '';
		return 'ok';
	}

	/**
	 * The document as TSL — what `serializeTsl` used to build.
	 *
	 * Not `dump_config`, which groups statements per node. A topology file has
	 * a required order, and `secure` must come last or it disables `make_node`
	 * for everything after it.
	 *
	 * @return {string} TSL, or '' for an empty document.
	 */
	dumpDocument() {
		const lines = [];
		for ( const [ name, value ] of Object.entries( this.frontmatter ) ) {
			lines.push( `var ${ name } = ${ value }` );
		}
		for ( const name of this.includes ) {
			lines.push( `include ${ name }` );
		}
		const edges = [];
		for ( const [ name, node ] of this.childRegistry.nodes ) {
			lines.push( node.dumpConfig().split( '\n' )[ 0 ] );
			const targets = Array.isArray( node.target )
				? node.target
				: [ node.target ].filter( Boolean );
			for ( const t of targets ) {
				edges.push( `connect_node ${ name } ${ t }` );
			}
		}
		lines.push( ...edges );
		if ( this.secureLevel ) {
			lines.push(
				'insecure' === this.secureLevel
					? 'insecure'
					: `secure ${ this.secureLevel }`
			);
		}
		return lines.length ? lines.join( '\n' ) + '\n' : '';
	}
}
