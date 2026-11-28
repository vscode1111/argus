import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { isIP } from 'net';
import * as path from 'path';
import { readConfig } from './config';
import { providerVpnSetting, type ProviderVpnCheck, type ProviderVpnMode, type ProviderVpnProfile, type VpnProvider } from '../shared/providerVpn';

// The expected exit address comes from the environment, never from this file: the
// repository is public, and a hardcoded address names a server in the owner's VPN chain.
// Without one, the route check fails closed (no exit can match an empty list).
export function exitIpsFrom(value: string | undefined): string[] {
  return String(value ?? '').split(',').map((s) => s.trim()).filter((ip) => isIP(ip) === 4);
}
const PROFILE_ID = /^[a-z][a-z0-9-]{0,39}$/;

interface RouteProfile extends ProviderVpnProfile {
  launcher?: string;
  proxy?: string;
  exitIps: string[];
}

function routeProfiles(env: NodeJS.ProcessEnv): Map<string, RouteProfile> {
  if (env.ARGUS_VPN_PROFILES === undefined) {
    return new Map([['dedicated', {
      id: 'dedicated', label: 'Dedicated exit only', launcher: env.ARGUS_DEDICATED_LAUNCHER,
      proxy: env.ARGUS_DEDICATED_PROXY, exitIps: exitIpsFrom(env.ARGUS_DEDICATED_EXIT_IPS),
    }]]);
  }
  const profiles = new Map<string, RouteProfile>();
  try {
    const entries: unknown = JSON.parse(env.ARGUS_VPN_PROFILES);
    if (!Array.isArray(entries)) return profiles;
    for (const entry of entries) {
      const { id, label, launcher, proxy, exitIps } = entry ?? {};
      if (typeof id !== 'string' || !PROFILE_ID.test(id) || id === 'normal' || id === 'unavailable' ||
          profiles.has(id) || typeof label !== 'string' || !label.trim() || label.length > 80 ||
          typeof launcher !== 'string' || !path.isAbsolute(launcher) ||
          typeof proxy !== 'string' || !proxyEndpoint(proxy) ||
          !Array.isArray(exitIps) || !exitIps.length || !exitIps.every(ip => typeof ip === 'string' && isIP(ip) === 4)) {
        return new Map();
      }
      profiles.set(id, { id, label: label.trim(), launcher, proxy, exitIps });
    }
  } catch {
    return new Map();
  }
  return profiles;
}

export function listProviderVpnProfiles(): ProviderVpnProfile[] {
  return Array.from(routeProfiles(process.env).values(), ({ id, label }) => ({ id, label }));
}

export function isProviderVpnMode(mode: unknown): mode is ProviderVpnMode {
  return mode === 'normal' || (typeof mode === 'string' && routeProfiles(process.env).has(mode));
}

function requireProfile(mode: ProviderVpnMode, env: NodeJS.ProcessEnv): RouteProfile {
  const profile = routeProfiles(env).get(mode);
  if (!profile) throw new Error('The selected protected route is unavailable on this server.');
  return profile;
}

function proxyEndpoint(value: string | undefined): string | undefined {
  try {
    const proxy = new URL(value || '');
    if (proxy.protocol === 'http:' && isIP(proxy.hostname) === 4 && proxy.port &&
        !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash) return proxy.origin;
  } catch { /* Missing or invalid proxy. */ }
}

export function vpnMode(provider: VpnProvider): ProviderVpnMode {
  const mode = readConfig(true)[providerVpnSetting[provider]];
  return typeof mode === 'string' ? mode : 'unavailable';
}

export function providerCommand(provider: VpnProvider, mode: ProviderVpnMode, binary: string, args: string[], shell = false) {
  if (mode === 'normal') {
    return { binary: shell && /\s/.test(binary) ? `"${binary}"` : binary, args, shell };
  }
  const { launcher, label } = requireProfile(mode, process.env);
  if (!launcher || !path.isAbsolute(launcher) || !existsSync(launcher)
    || (process.platform === 'win32' && path.extname(launcher).toLowerCase() !== '.exe')) {
    throw new Error(`${label}: the system network isolation launcher is unavailable.`);
  }
  return { binary: launcher, args: ['run', provider, '--', binary, ...args], shell: false };
}

export function providerNetworkEnvironment(mode: ProviderVpnMode, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (mode === 'normal') return env;
  const { proxy, label } = requireProfile(mode, env);
  const endpoint = proxyEndpoint(proxy);
  if (!endpoint) {
    throw new Error(`${label}: a dedicated HTTP proxy address and port are required.`);
  }
  const protectedEnv = { ...env };
  for (const key of Object.keys(protectedEnv)) {
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) delete protectedEnv[key];
  }
  return { ...protectedEnv, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: 'localhost,127.0.0.1,::1' };
}

export function vpnHttpGet(provider: VpnProvider, mode: ProviderVpnMode, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const curl = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl';
    const command = providerCommand(provider, mode, curl,
      ['-q', '--silent', '--max-time', '10', '--max-filesize', '2097152', '--config', '-', '--write-out', '\n%{http_code}', url]);
    const env = providerNetworkEnvironment(mode, process.env);
    const proc = spawn(command.binary, command.args, { windowsHide: true, shell: command.shell, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Route request timed out'));
    }, 12_000);
    const chunks: Buffer[] = [];
    let bytes = 0;
    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 2_097_160) chunks.push(chunk);
      else {
        proc.kill();
        reject(new Error('Route response exceeded the size limit'));
      }
    });
    proc.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('Could not start the route request'));
    });
    proc.once('close', code => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString('utf8');
      const status = /\n([1-5]\d\d)$/.exec(output);
      if (code === 0 && status) resolve({ status: Number(status[1]), body: output.slice(0, status.index) });
      else reject(new Error('Route request failed'));
    });
    proc.stdin.on('error', () => {});
    // Keep credentials out of the command line and process diagnostics.
    proc.stdin.end(Object.entries(headers).map(([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}\n`).join(''));
  });
}

const pendingChecks = new Map<string, Promise<ProviderVpnCheck>>();

export function checkProviderVpn(provider: VpnProvider): Promise<ProviderVpnCheck> {
  const mode = vpnMode(provider);
  const key = provider + ':' + mode;
  const existing = pendingChecks.get(key);
  if (existing) return existing;
  const check = probeProviderVpn(provider, mode).finally(() => pendingChecks.delete(key));
  pendingChecks.set(key, check);
  return check;
}

async function probeProviderVpn(provider: VpnProvider, mode: ProviderVpnMode): Promise<ProviderVpnCheck> {
  const api = provider === 'claude' ? 'https://api.anthropic.com/v1/models' : 'https://chatgpt.com/backend-api/codex/responses';
  const [exit, reachability] = await Promise.allSettled([
    vpnHttpGet(provider, mode, 'https://api.ipify.org/'),
    vpnHttpGet(provider, mode, api),
  ]);
  const result: ProviderVpnCheck = { provider, mode, checkedAt: new Date().toISOString() };
  const ip = exit.status === 'fulfilled' && exit.value.status === 200 ? exit.value.body.trim() : '';
  if (isIP(ip)) {
    result.exitIp = ip;
    const profile = routeProfiles(process.env).get(mode);
    if (profile && !profile.exitIps.length) result.error = `No expected exit IP is configured for ${profile.label}.`;
    else if (profile && !profile.exitIps.includes(ip)) result.error = `Unexpected exit IP for ${profile.label}.`;
  } else {
    result.error = exit.status === 'rejected' ? String((exit.reason as Error).message) : 'Exit IP probe failed.';
  }
  if (reachability.status === 'fulfilled') result.apiStatus = reachability.value.status;
  else result.apiError = 'Provider API probe failed.';
  return result;
}
