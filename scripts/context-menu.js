const { execSync } = require("child_process");
const { writeFileSync, unlinkSync } = require("fs");
const { join } = require("path");
const os = require("os");

const LABEL = "Open Argus";
const ICON_PATH = join(__dirname, "..", "media", "argus-icon.ico");
const LAUNCH_SCRIPT = join(__dirname, "launch.js");

function regEscape(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildRegFile() {
  const icon = regEscape(require("path").resolve(ICON_PATH));
  const nodePath = process.execPath;
  const cmd = regEscape(`"${nodePath}" "${require("path").resolve(LAUNCH_SCRIPT)}" "%V"`);
  const bases = [
    String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ArgusWebApp`,
    String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\ArgusWebApp`,
  ];
  let lines = ["Windows Registry Editor Version 5.00", ""];
  for (const base of bases) {
    lines.push(`[${base}]`);
    lines.push(`@="${LABEL}"`);
    lines.push(`"Icon"="${icon}"`);
    lines.push("");
    lines.push(`[${base}\\command]`);
    lines.push(`@="${cmd}"`);
    lines.push("");
  }
  return lines.join("\r\n");
}

function install() {
  const tmp = join(os.tmpdir(), "argus-ctx.reg");
  writeFileSync(tmp, buildRegFile(), "utf-8");
  try {
    execSync(`reg import "${tmp}"`, { stdio: "inherit" });
    console.log("Context menu installed.");
  } finally {
    unlinkSync(tmp);
  }
}

function uninstall() {
  const keys = [
    String.raw`HKCU\Software\Classes\Directory\shell\ArgusWebApp`,
    String.raw`HKCU\Software\Classes\Directory\Background\shell\ArgusWebApp`,
  ];
  for (const key of keys) {
    try {
      execSync(`reg delete "${key}" /f`, { stdio: "inherit" });
    } catch {}
  }
  console.log("Context menu removed.");
}

const arg = process.argv[2];
if (arg === "--uninstall") {
  uninstall();
} else {
  install();
}
