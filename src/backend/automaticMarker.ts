// The 🤖 marker on an automatically generated request. It goes at the start of the
// text, or right after a leading `/skill` or `$skill` command, so the command still
// parses. Live and Session History user bubbles render violet when it is present.
const MARKED_RE = /^🤖(?:\s|$)|^[/$][^\s]+\s+🤖(?:\s|$)/u;

export function hasAutomaticMarker(text: string): boolean {
  return MARKED_RE.test(text);
}

// Adds the marker unless it is already there, so a sender that marked its own text
// (the orchestrate skill's control.js does) never gets a second one.
export function withAutomaticMarker(text: string): string {
  const body = text.trimStart();
  if (hasAutomaticMarker(body)) return body;
  const command = body.match(/^([/$][^\s]+)(\s+|$)/u);
  return command
    ? `${command[1]} 🤖 ${body.slice(command[0].length)}`.trimEnd()
    : `🤖 ${body}`;
}
