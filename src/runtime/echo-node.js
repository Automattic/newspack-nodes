import { Node } from './node';
import { TYPE, FROM, TO, TM_ERROR } from './message';

/**
 * Echo — bounce every message back along the FROM path. Tachikoma's classic
 * test/diagnostic node: `connect_node foo _output` then `send foo hi` puts
 * `hi` in the transcript via foo → echo → bounced → _output.
 *
 * The drop rule (preserve at all costs): a TM_ERROR with empty FROM has no
 * return path. Bouncing would either NOT_AVAILABLE the empty TO or, worse,
 * route it onward into the graph as a phantom error. Drop instead.
 */
export class EchoNode extends Node {
	static nodeSchema() {
		return {
			category: 'Routing',
			description: 'Bounces messages back to their FROM path.',
			arguments: [],
			commands: [],
		};
	}

	fill( message ) {
		this.counter += 1;
		if ( message[ TYPE ] & TM_ERROR && '' === message[ FROM ] ) {
			return;
		}
		message[ TO ] = message[ FROM ];
		if ( this.sink ) {
			this.sink.fill( message );
		}
	}
}
