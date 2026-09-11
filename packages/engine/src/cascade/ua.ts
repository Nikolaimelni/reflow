/**
 * The slice of the browser default stylesheet that changes layout. Without it a `div` would
 * compute to `display: inline` and every fixture would disagree with Chromium on line one.
 *
 * `li` is `display: list-item` in a real browser. There are no markers here, and the box it
 * generates is a block, so block is what it gets.
 */
export const USER_AGENT_CSS = `
html, body, div, p, section, article, aside, header, footer, nav, main,
h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd, figure, figcaption,
blockquote, pre, form, fieldset, hr, table { display: block }

span, a, em, strong, b, i, u, s, small, code, kbd, samp, sub, sup,
label, abbr, cite, q, mark, time { display: inline }

body { margin: 8px }
p { margin: 1em 0 }
h1 { font-size: 2em; margin: 0.67em 0 }
h2 { font-size: 1.5em; margin: 0.83em 0 }
h3 { font-size: 1.17em; margin: 1em 0 }
h4 { margin: 1.33em 0 }
h5 { font-size: 0.83em; margin: 1.67em 0 }
h6 { font-size: 0.67em; margin: 2.33em 0 }
ul, ol { margin: 1em 0; padding-left: 40px }
dd { margin-left: 40px }
blockquote, figure { margin: 1em 40px }
pre { white-space: pre; margin: 1em 0; font-family: monospace }
code, kbd, samp { font-family: monospace }
h1, h2, h3, h4, h5, h6, strong, b { font-weight: bold }
em, i, cite, address, var { font-style: italic }
hr { margin: 0.5em auto; border-width: 1px; border-style: solid }
`;
