// Inlined into <head> BEFORE the external stylesheet so the document canvas
// is theme-colored from the very first paint — including the window between
// HTML parse and CSS arrival, overscroll, and any moment where the React tree
// is unmounted. Values are literal (not var()) because the variables live in
// the external stylesheet; keep them in sync with --arena-terminal-bg in
// styles/variables.scss (dark #0a1716 at :root, light #f1f7f6 at
// :root[data-theme='light']).
export const criticalThemeCss = [
  "html{background-color:#0a1716;color-scheme:dark}",
  "html[data-theme='light']{background-color:#f1f7f6;color-scheme:light}",
].join('\n');
