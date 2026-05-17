import { Node } from './node';

export class Callback extends Node {
	constructor( fn ) {
		super();
		this._fn = fn;
	}

	fill( message ) {
		this.counter += 1;
		this._fn( message );
	}
}
