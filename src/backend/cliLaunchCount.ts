let claudeLaunches = 0;
let codexLaunches = 0;

export function noteCliLaunch(provider: 'claude' | 'codex'): void {
  if (provider === 'claude') claudeLaunches++;
  else codexLaunches++;
}

export function getCliLaunchCount(): number { return claudeLaunches + codexLaunches; }

// The machine-wide stop button only terminates Claude processes. Keep the Codex
// launches in the total when that button resets its historical Claude count.
export function resetClaudeLaunchCount(): void { claudeLaunches = 0; }
