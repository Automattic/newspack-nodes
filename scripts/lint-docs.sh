#!/usr/bin/env bash
# Doc-drift lint: cheap grep assertions keeping the prose in sync with the
# runtime. Cheap enough to run on EVERY push (docs-only included) from
# scripts/pre-push. What it checks:
#
#   1. No retired retention axis name (max_lifetime / max_lifespan) outside
#      CHANGELOG.md + docs/upgrading.md, which document the rename. The live
#      axes are segment_size / min_segments / num_segments / min_lifetime /
#      lifetime / max_segments.
#   2. No newspack-ai-newsletter slug in docs/ or README.md — the real sibling
#      plugin is newspack-intelligence. (example-ai-newsletter is a different,
#      legitimate name and is intentionally NOT matched.)
#   3. No aggregator verb removed in 0.47.1 (status / health / servers) on the
#      Aggregator_CI_Node row in docs/API.md.
#   4. Retention arity proxy: every doc make_node line passing
#      <config:segment_size> also passes <config:min_segments> (the new tail
#      always pairs them; the old 3-arg form did not).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
report() { printf '\342\234\227 lint-docs: %s\n' "$1" >&2; fail=1; }

# 1. retired retention axis names (upgrading.md documents the rename).
hits=$(grep -rnE 'max_lifetime|max_lifespan' docs README.md AGENTS.md .claude/skills \
	--include='*.md' 2>/dev/null | grep -v '^docs/upgrading.md:' || true)
[ -n "$hits" ] && report "retired axis name — use lifetime / num_segments / max_segments:"$'\n'"$hits"

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

[ "$fail" -eq 0 ] && printf '\342\234\223 lint-docs: docs in sync with the runtime\n' >&2
exit "$fail"
