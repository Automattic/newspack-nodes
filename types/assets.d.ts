/**
 * Asset imports the bundler resolves and the type-checker cannot.
 *
 * esbuild turns a `.scss` side-effect import into a stylesheet; to tsc it is a
 * module with no declaration. Declaring them here keeps `checkJs` honest about
 * the JavaScript without teaching it the asset pipeline.
 */
declare module '*.scss';
declare module '*.sass';
declare module '*.css';
