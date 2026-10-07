let claudeLaunches = 0;
let codexLaunches = 0;

export function noteCliLaunch(provider: 'claude' | 'codex'): void {
  if (provider === 'claude') claudeLaunches++;
  else codexLaunches++;
}

export function getCliLaunchCount(): number { return claudeLaunches + codexLaunches; }

export function resetCliLaunchCount(): void { claudeLaunches = 0; codexLaunches = 0; }
