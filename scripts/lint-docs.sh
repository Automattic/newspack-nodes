#!/usr/bin/env bash
# Doc-drift lint: cheap grep assertions keeping the prose in sync with the
# runtime. Cheap enough to run on EVERY push (docs-only included) from
# scripts/pre-push. What it checks:
#
#   1. No retired retention axis as a CONFIG TOKEN (<config:max_lifetime> /
#      <config:max_lifespan>) outside docs/upgrading.md, which documents the
#      rename. The live axes are segment_size / min_segments / num_segments /
#      min_lifetime / lifetime / max_segments. Scoped to the token form on
#      purpose: `max_lifespan` is also event-logger-nodes' live memcache-TTL
#      property, so matching the bare word libels ~15 correct lines there.
#   2. No newspack-ai-newsletter slug in docs/ or README.md — the real sibling
#      plugin is newspack-intelligence. (example-ai-newsletter is a different,
#      legitimate name and is intentionally NOT matched.)
#   3. No aggregator verb removed in 0.47.1 (status / health / servers) on the
#      Aggregator_CI_Node row in docs/API.md.
#   4. Retention arity proxy: every doc make_node line passing
#      <config:segment_size> also passes <config:min_segments> (the new tail
#      always pairs them; the old 3-arg form did not).
#   5. newspack_event_logger_nodes_rules_schema_version - deleted.
#   6. A consumer's substrate version floor matches what its loader enforces.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
report() { printf '\342\234\227 lint-docs: %s\n' "$1" >&2; fail=1; }

# 1. retired retention axis as a config token (upgrading.md documents the rename).
hits=$(grep -rnE '<config:(max_lifetime|max_lifespan)>' docs README.md AGENTS.md .claude/skills \
	--include='*.md' 2>/dev/null | grep -v '^docs/upgrading.md:' || true)
[ -n "$hits" ] && report "retired axis token — use <config:lifetime> / <config:num_segments> / <config:max_segments>:"$'\n'"$hits"

# 2. stale plugin slug (example-ai-newsletter is not matched by this pattern).
hits=$(grep -rn 'newspack-ai-newsletter' docs README.md --include='*.md' 2>/dev/null || true)
[ -n "$hits" ] && report "stale slug newspack-ai-newsletter — use newspack-intelligence:"$'\n'"$hits"

# 3. removed aggregator verbs on the Aggregator_CI_Node row.
# shellcheck disable=SC2016 # backticks are grep regex, not a subshell.
hits=$(grep -n 'Aggregator_CI_Node' docs/API.md 2>/dev/null | grep -E '`(status|health|servers)`' || true)
[ -n "$hits" ] && report "removed aggregator verb in API.md (0.47.1 dropped status/health/servers):"$'\n'"$hits"

# 4. retention arity: <config:segment_size> implies <config:min_segments>.
hits=$(grep -rn '<config:segment_size>' docs --include='*.md' 2>/dev/null \
	| grep -v '<config:min_segments>' || true)
[ -n "$hits" ] && report "retention arg list missing <config:min_segments> (stale arity):"$'\n'"$hits"

# 5.  newspack_event_logger_nodes_rules_schema_version wp option
hits=$(grep -rnE 'newspack_event_logger_nodes_rules_schema_version' docs README.md AGENTS.md .claude/skills \
	--include='*.md' 2>/dev/null | grep -v '^docs/upgrading.md:' || true)
[ -n "$hits" ] && report "retired option — newspack_event_logger_nodes_rules_schema_version:"$'\n'"$hits"

# 6. substrate version floor: the prose must name the value the loader enforces.
# A no-op in the substrate itself (nothing there calls version_at_least). Nothing
# scripts the floor — bump-version.sh repins release.yml, not this — so ELN's
# prose silently sat a whole major behind its own loader.
floor=$(grep -hoE "version_at_least\( *'[0-9]+\.[0-9]+\.[0-9]+'" ./*.php 2>/dev/null \
	| grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true)
if [ -n "$floor" ]; then
	hits=$(grep -rn 'version_at_least' README.md AGENTS.md docs .claude/skills \
		--include='*.md' 2>/dev/null | grep -v "$floor" || true)
	[ -n "$hits" ] && report "substrate floor in prose disagrees with the loader ($floor):"$'\n'"$hits"
fi

# 7. No per-rule diagnostic is on by default where a plugin declares rules:
# event-logger-nodes' Rule declares every flag false, so prose saying otherwise
# describes a default that no longer exists. A plugin without that class has
# nothing to match and passes.
if [ -f includes/class-rule.php ]; then
	hits=$(grep -rniE '(on by default|absent means on|default on\b)' README.md AGENTS.md docs .claude/skills includes/class-rule.php \
		--include='*.md' --include='*.php' --include='*.html' 2>/dev/null | grep -v '^docs/upgrading.md:' || true)
	[ -n "$hits" ] && report "a diagnostic described as on by default; Rule declares every one false:"$'\n'"$hits"
	hits=$(grep -rnE '^\| .(log_queries|log_http|log_plugin_loads|trace_hooks). \| .true.' docs --include='*.md' 2>/dev/null || true)
	[ -n "$hits" ] && report "a rule-field table gives a diagnostic a true default:"$'\n'"$hits"
fi

# 8. Every numbered decision in docs/architecture-decisions.md has its row in
# AGENTS.md's decision table; a plugin whose decisions are not numbered this
# way has nothing to match and passes.
if [ -f docs/architecture-decisions.md ] && [ -f AGENTS.md ]; then
	missing=$( { grep -oE '^## Decision [0-9]+:' docs/architecture-decisions.md || true; } | { grep -oE '[0-9]+' || true; } | while read -r n; do
		grep -qE "^\| $n \| " AGENTS.md || printf 'decision %s\n' "$n"
	done)
	[ -n "$missing" ] && report "decisions with no row in AGENTS.md's table:"$'\n'"$missing"
fi

# 9. Instrumentation's gate is started_instance(): has_instance() is the test
# API, and prose saying instrumentation or a callback asks it — by name after
# the verb, or as "this" beside it — names a gate the callbacks no longer ask.
# A plugin without the logger has nothing to match and passes.
if [ -f includes/class-log-manager.php ]; then
	hits=$(grep -rn 'has_instance' README.md AGENTS.md docs .claude/skills includes \
		--include='*.md' --include='*.php' 2>/dev/null | grep -iE '(instrumentation|callbacks?) asks? (this\b|[^.;]*has_instance)' || true)
	[ -n "$hits" ] && report "instrumentation described as asking has_instance(); it asks started_instance():"$'\n'"$hits"
fi

[ "$fail" -eq 0 ] && printf '\342\234\223 lint-docs: docs in sync with the runtime\n' >&2
exit "$fail"
