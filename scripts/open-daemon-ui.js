const { execFile } = require("child_process");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Context-menu launcher for the daemon-served browser UI. Unlike launch.js (which
// targets the Vite dev server on 5173), this opens the always-on daemon's own page
// at http://localhost:<port>/. The nonce is NOT put in the URL - browser.html
// fetches it at runtime over /nonce. Flow: ensure the daemon is up (idempotent),
// wait for the port to accept connections, then open Chrome in app mode.

const CHROME_PATHS = {
  win32: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  linux: "/usr/bin/google-chrome",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};
const CHROME_PATH = CHROME_PATHS[process.platform] || "google-chrome";

// Resolve the daemon port + liveness from the discovery file, falling back to the
// fixed default (mirrors DEFAULT_DAEMON_PORT in src/backend/daemonInfo.ts).
const DAEMON_FILE = path.join(os.homedir(), ".claude", "argus-daemon.json");
let port = parseInt(process.env.ARGUS_DAEMON_PORT || "3017", 10);
let alive = false;
try {
  const info = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf-8"));
  if (info && typeof info.port === "number") port = info.port;
  if (info && typeof info.pid === "number") {
    try { process.kill(info.pid, 0); alive = true; }
    catch (e) { alive = e.code === "EPERM"; }
  }
} catch {}

function waitForPort(p, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const sock = net.connect(p, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function buildUrl() {
  // The selected target is a file (the `*` verb). Open its parent folder as the
  // workspace and pass the file along; tolerate a folder too, just in case.
  const target = process.argv[2];
  const params = new URLSearchParams();
  if (target) {
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch {}
    if (isDir) {
      params.set("dir", target);
    } else {
      params.set("dir", path.dirname(target));
      params.set("file", target);
    }
  }
  const qs = params.toString();
  return `http://localhost:${port}/` + (qs ? `?${qs}` : "");
}

(async () => {
  if (!alive) {
    // Idempotent: the daemon's own single-instance guard ignores a duplicate launch.
    const daemonVbs = path.join(__dirname, "daemon.vbs");
    try { execFile("wscript.exe", [daemonVbs], { detached: true, stdio: "ignore" }).unref(); } catch {}
  }
  // The HTML page itself won't load until the server is listening, so wait before
  // opening Chrome (the WS reconnect only helps after the page has loaded).
  await waitForPort(port, 15000);
  execFile(CHROME_PATH, [`--app=${buildUrl()}`], { detached: true, stdio: "ignore" }).unref();
})();
