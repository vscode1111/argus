import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { showWindowsToast } from '../src/frontend/utils/win32Toast';

// Real-OS test for the in-process koffi -> WinRT toast. The toast only runs in
// the extension host (Node), so it can't be driven through the browser; instead
// we call showWindowsToast() directly and assert the full FFI/COM chain succeeds
// against the actual OS. Windows-only.
test.describe('win32 toast (real OS)', () => {
  test('fires a real Windows toast via koffi WinRT (cold + warm)', () => {
    test.skip(process.platform !== 'win32', 'Windows-only OS toast');
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    // Cold call: DLL load + AUMID registration + WinRT activation + COM vtable
    // dispatch + Show() must all succeed. Any failure returns false (and logs).
    const cold = showWindowsToast('Argus e2e', 'scub-toast-cold', log);
    expect(cold, logs.join('\n')).toBe(true);

    // Warm call: reuses the loaded DLLs / registered AUMID / RoInitialize.
    const warm = showWindowsToast('Argus e2e', 'scub-toast-warm', log);
    expect(warm, logs.join('\n')).toBe(true);
  });

  test('escapes XML-special characters without failing', () => {
    test.skip(process.platform !== 'win32', 'Windows-only OS toast');
    // Title/body with <, >, &, quotes must not break the toast XML.
    const ok = showWindowsToast('Argus <e2e> & "co"', "scub-toast <b> & 'q'");
    expect(ok).toBe(true);
  });

  test('registers the Argus AppUserModelId in HKCU', () => {
    test.skip(process.platform !== 'win32', 'Windows-only OS toast');
    showWindowsToast('Argus e2e', 'scub-toast-reg');
    // execFile (not a shell) so the registry path/flags are passed verbatim.
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Classes\\AppUserModelId\\Argus.Chat', '/v', 'DisplayName'],
      { encoding: 'utf8' }
    );
    expect(out).toContain('Argus');
  });
});
