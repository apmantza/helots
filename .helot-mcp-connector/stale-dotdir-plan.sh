# Stale dotdir cleanup plan
# Detected stale dirs: .helot-debug, .helot-state-test, .agents
# Active (skipped): .helots (referenced in mcp-server.ts), .claude (Claude Code settings)

# .helot-debug — debug artifacts from Mar 2, no source references
mkdir bin/archive/stale-dirs/helot-debug
mv .helot-debug/context.json bin/archive/stale-dirs/helot-debug/
mv .helot-debug/trace.json bin/archive/stale-dirs/helot-debug/
rmdir .helot-debug

# .helot-state-test — test artifacts from Mar 2, no source references
mkdir bin/archive/stale-dirs/helot-state-test
mv .helot-state-test/context.json bin/archive/stale-dirs/helot-state-test/
mv .helot-state-test/trace.json bin/archive/stale-dirs/helot-state-test/
rmdir .helot-state-test

# .agents — old workflow definition from Mar 2, no source references
mkdir bin/archive/stale-dirs/agents/workflows
mv .agents/workflows/helots.md bin/archive/stale-dirs/agents/workflows/
rmdir .agents/workflows
rmdir .agents
