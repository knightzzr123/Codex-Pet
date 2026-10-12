const readline = require('node:readline');

function createScopeMonitor({ launch, onScope, onDiagnostic = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, setWatch = setInterval, clearWatch = clearInterval }) {
  let child, lines, restart, watch, stopped = true, failures = 0, lastOutput = 0, observed = false, samples = 0;
  function schedule(reason, detail) {
    if (stopped || restart) return;
    onDiagnostic({ event: 'scope-restart', reason, detail, pid: child?.pid });
    lines?.close(); lines = null;
    const previous = child; child = null; previous?.kill();
    const delay = Math.min(5000, 250 * 2 ** Math.min(failures++, 5));
    restart = setTimer(() => { restart = null; startChild(); }, delay);
  }
  function startChild() {
    if (stopped) return;
    lastOutput = now(); observed = false;
    let current;
    try { current = launch(); child = current; }
    catch (error) { schedule('launch-error', error.message); return; }
    onDiagnostic({ event: 'scope-start', pid: current.pid });
    lines = readline.createInterface({ input: current.stdout });
    let stderr = '';
    current.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    lines.on('line', line => {
      if (stopped || child !== current) return;
      let scope;
      try { scope = JSON.parse(line); } catch { return; }
      if (typeof scope.active !== 'boolean') return;
      lastOutput = now(); observed = true; failures = 0; samples++;
      onScope(scope);
    });
    current.on('error', error => { if (child === current) schedule('process-error', error.message); });
    current.on('exit', (code, signal) => { if (child === current) schedule('process-exit', { code, signal, stderr }); });
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false; startChild();
      watch = setWatch(() => {
        if (!stopped && child && now() - lastOutput > (observed ? 5000 : 30000)) schedule('heartbeat-timeout');
      }, 1000);
    },
    stop() {
      stopped = true; clearTimer(restart); clearWatch(watch);
      restart = null; lines?.close(); lines = null;
      const previous = child; child = null; previous?.kill();
    },
    get pid() { return child?.pid; },
    get samples() { return samples; }
  };
}
module.exports = { createScopeMonitor };
