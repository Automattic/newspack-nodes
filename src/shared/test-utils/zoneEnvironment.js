const { TestEnvironment } = require( 'jest-environment-jsdom' );

/**
 * A jsdom test environment whose local clock reads in the zone its test
 * file's `@timezone` docblock pragma names, restoring the worker's own zone
 * at teardown.
 *
 * The zone has to be set here, outside the sandbox: a test file's
 * `process.env` is a copy, so assigning `TZ` there never reaches the process
 * whose zone V8 reads. A jest worker runs one file at a time, so the zone
 * holds for exactly the file that asked for it.
 *
 * A file asks for it with two docblock tags: `@jest-environment` naming
 * this file by its path from the root, and `@timezone` naming the IANA zone.
 */
class ZoneEnvironment extends TestEnvironment {
	/**
	 * Read the zone the test file names, refusing a file naming none.
	 *
	 * @param {Object} config  Jest's global and project config.
	 * @param {Object} context The test file's path and docblock pragmas.
	 */
	constructor( config, context ) {
		super( config, context );
		const zone = context.docblockPragmas.timezone;
		if ( 'string' !== typeof zone || '' === zone ) {
			throw new Error(
				`${ context.testPath } names no single @timezone pragma`
			);
		}
		this.zone = zone;
	}

	/** Set the worker's zone to the file's, keeping the worker's own. */
	async setup() {
		await super.setup();
		this.workerZone = process.env.TZ;
		process.env.TZ = this.zone;
	}

	/** Give the worker back the zone it had before the file ran. */
	async teardown() {
		if ( undefined === this.workerZone ) {
			delete process.env.TZ;
		} else {
			process.env.TZ = this.workerZone;
		}
		await super.teardown();
	}
}

module.exports = ZoneEnvironment;
