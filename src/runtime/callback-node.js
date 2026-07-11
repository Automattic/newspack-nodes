import { Node } from './node';

export class CallbackNode extends Node {
	constructor( fn ) {
		super();
		this._fn = fn;
	}

	fill( message ) {
		this.counter++;
		this._fn( message );
	}
}
