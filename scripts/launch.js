const { execFile } = require("child_process");

const CHROME_PATH = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const BASE_URL = "http://localhost:5173";

const dir = process.argv[2];
const url = dir ? `${BASE_URL}/?dir=${encodeURIComponent(dir)}` : `${BASE_URL}/`;

execFile(CHROME_PATH, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref();
