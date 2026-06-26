import { spawn } from 'child_process';
import type { WebSocket } from 'ws';
import { resolveClaudeBin, IS_WIN, killProc, URL_PATTERNS } from './cli';

export interface LoginHandler {
  start: (workspaceDir: string) => void;
  submitCode: (code: string) => void;
  kill: () => void;
}

export function createLoginHandler(ws: WebSocket, sendLog: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void): LoginHandler {
  let proc: ReturnType<typeof spawn> | undefined;
  let submitCode: ((code: string) => void) | undefined;
  let closed = false;
  let exitCode: number | null = null;

  function start(workspaceDir: string) {
    if (proc) killProc(proc);
    sendLog('info', 'Starting claude login');
    const loginBin = resolveClaudeBin();
    const loginCmd = IS_WIN && /\s/.test(loginBin) ? `"${loginBin}"` : loginBin;
    const lp = spawn(loginCmd, ['auth', 'login'], { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });
    proc = lp;
    let output = '';
    let resolved = false;
    closed = false;
    exitCode = null;

    const checkForUrl = (data: string) => {
      output += data;
      sendLog('debug', `login output: ${data.trim()}`);
      for (const pattern of URL_PATTERNS) {
        const m = output.match(pattern);
        if (m && !resolved) {
          resolved = true;
          submitCode = (code: string) => { lp.stdin.write(code + '\n'); };
          sendLog('info', `Login URL: ${m[1]}`);
          ws.send(JSON.stringify({ type: 'loginUrl', url: m[1] }));
          return;
        }
      }
    };

    lp.stdout.on('data', (chunk: Buffer) => checkForUrl(chunk.toString()));
    lp.stderr.on('data', (chunk: Buffer) => checkForUrl(chunk.toString()));
    lp.on('close', (code) => {
      closed = true;
      exitCode = code;
      proc = undefined;
      if (!resolved) {
        ws.send(JSON.stringify({ type: 'loginResult', success: false, message: output.trim() || `claude login exited with code ${code}` }));
      }
    });
    lp.on('error', (err) => {
      closed = true;
      proc = undefined;
      ws.send(JSON.stringify({ type: 'loginResult', success: false, message: err.message }));
    });
  }

  function handleSubmitCode(code: string) {
    if (!submitCode) {
      ws.send(JSON.stringify({ type: 'loginResult', success: false, message: 'No login process active' }));
    } else if (closed) {
      sendLog('warn', `Login process already exited (code ${exitCode}) before code was submitted`);
      submitCode = undefined;
      ws.send(JSON.stringify({ type: 'loginResult', success: false, message: 'Login process exited before code was submitted. Try again.' }));
    } else {
      submitCode(code);
      submitCode = undefined;
      proc?.on('close', (c) => {
        proc = undefined;
        ws.send(JSON.stringify({ type: 'loginResult', success: c === 0, message: c === 0 ? undefined : 'Authentication failed. Check the code and try again.' }));
      });
    }
  }

  function kill() {
    if (proc) killProc(proc);
  }

  return { start, submitCode: handleSubmitCode, kill };
}
