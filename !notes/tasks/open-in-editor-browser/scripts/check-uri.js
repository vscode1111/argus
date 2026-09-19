function vscodeFileUri(p, line) {
  const normalized = p.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encoded = encodeURI(withSlash);
  return line ? `vscode://file${encoded}:${line}:1` : `vscode://file${encoded}`;
}

console.log(vscodeFileUri('D:\\_Projects\\scub111g\\argus\\CLAUDE.md', 5));
console.log(vscodeFileUri('d:\\_Projects\\scub111g\\estate-agent\\properties\\квартира-снегири-сиреневый-79\\2026-09-17-листинг.md'));
console.log(vscodeFileUri('/home/user/my project/file.md', 12));
