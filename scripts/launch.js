const { execFile } = require("child_process");

const CHROME_PATHS = {
  win32: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  linux: "/usr/bin/google-chrome",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};

const CHROME_PATH = CHROME_PATHS[process.platform] || "google-chrome";
const BASE_URL = "http://localhost:5173";

const dir = process.argv[2];
const url = dir ? `${BASE_URL}/?dir=${encodeURIComponent(dir)}` : `${BASE_URL}/`;

execFile(CHROME_PATH, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref();
