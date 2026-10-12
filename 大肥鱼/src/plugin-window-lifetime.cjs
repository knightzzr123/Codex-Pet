// The native Codex window owns the pet after its plugin launches it. An MCP
// connection can be replaced when a chat changes; it is not the app lifetime.
function createWindowLifetime({ alive, now = Date.now, startupGraceMs = 30000 }) {
  const startedAt = now();
  let ownerPid = 0;
  return {
    observe(scope) { if (scope.targetExists && scope.codexPid) ownerPid = scope.codexPid; },
    shouldExit(hasSession) {
      if (ownerPid) return !alive(ownerPid);
      return !hasSession && now() - startedAt >= startupGraceMs;
    }
  };
}
module.exports = { createWindowLifetime };
