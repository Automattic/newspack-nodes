/**
 * Commit-message rules for `scripts/commit-msg`, the conventional-commit hook
 * `core.hooksPath` reaches on every commit.
 *
 * The shared preset is taken whole, with no local overrides, so the type and
 * scope vocabulary stays identical across every sibling plugin that vendors
 * that hook.
 */
module.exports = { extends: [ '@commitlint/config-conventional' ] };
