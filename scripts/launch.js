const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const CHROME_PATHS = {
  win32: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  linux: "/usr/bin/google-chrome",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};

const CHROME_PATH = CHROME_PATHS[process.platform] || "google-chrome";
const BASE_URL = "http://localhost:5173";

const dir = process.argv[2];
const params = new URLSearchParams();
if (dir) params.set("dir", dir);
const nonceFile = path.join(__dirname, "..", ".dev-nonce");
try { params.set("nonce", fs.readFileSync(nonceFile, "utf-8").trim()); } catch {}
const qs = params.toString();
const url = qs ? `${BASE_URL}/?${qs}` : `${BASE_URL}/`;

execFile(CHROME_PATH, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref();
