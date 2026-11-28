import { execSync } from 'child_process';
import { X509Certificate, createPrivateKey } from 'crypto';
import * as fs from 'fs';
import { CONFIG_PATH } from './config';

/**
 * Optional HTTPS listener for remote access.
 *
 * Plain HTTP is fine on loopback, but a remote client reached through a tunnel or a VPN
 * that terminates on a machine we do not fully control (a VPS) exposes the password, the
 * session token and every message on that hop. Serving TLS from Argus itself makes the
 * traffic end-to-end encrypted up to this process, whatever carries it in between.
 *
 * Settings live in the config file but deliberately NOT in DEFAULT_CONFIG: everything
 * there is writable over the WebSocket through `updateSettings`, and `tlsKeyCommand` is
 * a command this process executes. Reading the raw file keeps it editable by hand only.
 *
 *   tlsPort        port for the HTTPS listener; 0 or absent = off
 *   tlsCertFile    PEM certificate chain (public, may live anywhere)
 *   tlsKeyCommand  shell command whose stdout is the PEM private key
 *
 * The key is fetched by a command rather than read from a file so it can stay in a
 * secret store (a vault, a keychain) and only ever exist in this process's memory.
 */
export interface TlsSettings {
  port: number;
  cert: string;
  key: string;
}

interface RawTlsConfig {
  tlsPort?: unknown;
  tlsCertFile?: unknown;
  tlsKeyCommand?: unknown;
}

function readRawConfig(): RawTlsConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as RawTlsConfig; } catch { return {}; }
}

/**
 * Load the TLS material, or undefined when HTTPS is off or cannot be set up. Never
 * throws: a broken TLS setup must not stop the daemon serving HTTP to local panels.
 * Errors are logged without any key material.
 */
export function loadTlsSettings(log: (msg: string) => void = console.log): TlsSettings | undefined {
  const raw = readRawConfig();
  const port = Number(raw.tlsPort) || 0;
  if (!port) return undefined;
  const certFile = typeof raw.tlsCertFile === 'string' ? raw.tlsCertFile : '';
  const keyCommand = typeof raw.tlsKeyCommand === 'string' ? raw.tlsKeyCommand : '';
  if (!certFile || !keyCommand) {
    log(`[argus-tls] tlsPort ${port} is set but tlsCertFile or tlsKeyCommand is missing; HTTPS disabled`);
    return undefined;
  }
  let cert: string;
  try {
    cert = fs.readFileSync(certFile, 'utf8');
  } catch (err) {
    log(`[argus-tls] cannot read ${certFile}: ${(err as Error).message}; HTTPS disabled`);
    return undefined;
  }
  let key: string;
  try {
    key = execSync(keyCommand, { encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // The message carries the command's stderr, never its stdout (the key).
    const e = err as { status?: number; stderr?: string };
    log(`[argus-tls] tlsKeyCommand failed (exit ${e.status ?? '?'}): ${String(e.stderr ?? '').trim().slice(0, 300)}; HTTPS disabled`);
    return undefined;
  }
  try {
    const keyObject = createPrivateKey(key);
    const x509 = new X509Certificate(cert);
    if (!x509.checkPrivateKey(keyObject)) {
      log('[argus-tls] the key from tlsKeyCommand does not match tlsCertFile; HTTPS disabled');
      return undefined;
    }
    if (Date.parse(x509.validTo) < Date.now()) log(`[argus-tls] warning: certificate expired on ${x509.validTo}`);
  } catch (err) {
    log(`[argus-tls] invalid certificate or key: ${(err as Error).message}; HTTPS disabled`);
    return undefined;
  }
  return { port, cert, key };
}
