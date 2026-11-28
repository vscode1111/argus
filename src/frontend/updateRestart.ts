import * as fs from 'fs';
import * as path from 'path';

/**
 * Decides whether this VS Code window should restart its extension host to pick up a
 * newer installed Argus.
 *
 * Installing a VSIX does not replace the code an open window is already running: the
 * window keeps the old extension host (Extensions view: "Restart Required") until its
 * extensions restart. The daemon is replaced separately (target-first handover), so a
 * daemon newer than this window's own build is the signal that an update happened.
 *
 * Pure apart from reading the extensions folder, so it runs under plain `node --test`
 * without VS Code. No `vscode` import here on purpose.
 */

/** Numeric dot-segment compare: negative when a < b. "0.0.9" < "0.0.10". */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const an = Number(as[i] ?? 0);
    const bn = Number(bs[i] ?? 0);
    if (an !== bn) return an - bn;
  }
  return 0;
}

export interface UpdateCheck {
  /** `publisher.name`, e.g. `local.argus`. */
  extensionId: string;
  /** Version this extension host is running. */
  ownVersion: string;
  /** Folder this extension host loaded the extension from. */
  extensionPath: string;
  /** Version the registered daemon reports, if any. */
  daemonVersion: string | undefined;
  /** True for an Extension Development Host or test run, which loads the repo, not an install. */
  development: boolean;
  /** Target this window already tried to restart into (loop guard), if any. */
  attemptedTarget?: string;
}

export type UpdateDecision =
  | { restart: true; target: string; installedPath: string }
  | { restart: false; reason: string };

/**
 * Restart only when all of these hold, each one guarding a real failure:
 * - not a development host: it runs the repo build, a restart would load the same code;
 * - the daemon is newer than this window: otherwise there is nothing to pick up;
 * - this window runs from an installed `<id>-<version>` folder, and a sibling folder for
 *   the daemon's version exists with that version in its manifest: a daemon started from
 *   the repo's `out/` or another machine's install would otherwise trigger a restart that
 *   loads the same old version again, forever;
 * - this window has not already tried this target: if VS Code still loads the old build
 *   after a restart, retrying would loop.
 */
export function decideUpdateRestart(check: UpdateCheck): UpdateDecision {
  if (check.development) return { restart: false, reason: 'development host' };
  const target = check.daemonVersion;
  if (!target) return { restart: false, reason: 'no daemon version' };
  if (compareVersions(target, check.ownVersion) <= 0) return { restart: false, reason: 'daemon is not newer' };
  if (check.attemptedTarget === target) return { restart: false, reason: `already restarted for ${target}` };

  const ownFolder = path.basename(check.extensionPath).toLowerCase();
  const prefix = check.extensionId.toLowerCase() + '-';
  if (ownFolder !== prefix + check.ownVersion.toLowerCase()) {
    return { restart: false, reason: 'not running from an installed extension folder' };
  }
  const installedPath = path.join(path.dirname(check.extensionPath), prefix + target);
  let installedVersion: unknown;
  try {
    installedVersion = JSON.parse(fs.readFileSync(path.join(installedPath, 'package.json'), 'utf8')).version;
  } catch {
    return { restart: false, reason: `${target} is not installed` };
  }
  if (installedVersion !== target) return { restart: false, reason: `installed folder for ${target} reports ${String(installedVersion)}` };
  return { restart: true, target, installedPath };
}
