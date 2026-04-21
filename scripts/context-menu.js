const { execSync } = require("child_process");
const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require("fs");
const { join, resolve } = require("path");
const os = require("os");

const LABEL = "Open Argus";
const ICON_PATH = join(__dirname, "..", "media", "argus-icon.ico");
const LAUNCH_VBS = join(__dirname, "launch.vbs");
const LAUNCH_JS = join(__dirname, "launch.js");
const IS_WINDOWS = process.platform === "win32";

function regEscape(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildRegFile() {
  const icon = regEscape(resolve(ICON_PATH));
  const vbsPath = resolve(LAUNCH_VBS);
  const cmd = regEscape(`wscript.exe "${vbsPath}" "%V"`);
  const bases = [
    String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ZZArgusWebApp`,
    String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\ZZArgusWebApp`,
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

function buildDesktopEntry() {
  const launchJs = resolve(LAUNCH_JS);
  return [
    "[Desktop Entry]",
    `Name=${LABEL}`,
    "Type=Application",
    `Exec=node "${launchJs}" %f`,
    "MimeType=inode/directory;",
  ].join("\n");
}

function installWindows() {
  const tmp = join(os.tmpdir(), "argus-ctx.reg");
  writeFileSync(tmp, buildRegFile(), "utf-8");
  try {
    execSync(`reg import "${tmp}"`, { stdio: "inherit" });
    console.log("Context menu installed.");
  } finally {
    unlinkSync(tmp);
  }
}

function installLinux() {
  const appsDir = join(os.homedir(), ".local", "share", "applications");
  if (!existsSync(appsDir)) mkdirSync(appsDir, { recursive: true });
  const desktopFile = join(appsDir, "argus-open.desktop");
  writeFileSync(desktopFile, buildDesktopEntry(), "utf-8");
  execSync(`chmod +x "${desktopFile}"`);
  console.log(`Context menu installed: ${desktopFile}`);
}

function uninstallWindows() {
  const keys = [
    String.raw`HKCU\Software\Classes\Directory\shell\ZZArgusWebApp`,
    String.raw`HKCU\Software\Classes\Directory\Background\shell\ZZArgusWebApp`,
  ];
  for (const key of keys) {
    try {
      execSync(`reg delete "${key}" /f`, { stdio: "inherit" });
    } catch {}
  }
  console.log("Context menu removed.");
}

function uninstallLinux() {
  const desktopFile = join(os.homedir(), ".local", "share", "applications", "argus-open.desktop");
  try {
    unlinkSync(desktopFile);
    console.log("Context menu removed.");
  } catch {
    console.log("Context menu entry not found.");
  }
}

const arg = process.argv[2];
if (arg === "--uninstall") {
  IS_WINDOWS ? uninstallWindows() : uninstallLinux();
} else {
  IS_WINDOWS ? installWindows() : installLinux();
}
