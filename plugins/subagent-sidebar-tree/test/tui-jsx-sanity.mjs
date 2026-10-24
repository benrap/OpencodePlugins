// Best-effort TSX structural sanity check (no local TS/JSX toolchain available).
// 1) Balances (), [], {} outside of strings/comments/template literals.
// 2) Scans JSX tags (whitelisted element names) with a brace/quote-aware scanner,
//    so `=>` in attributes and generics like Record<...> are not misparsed.
import { readFileSync } from "node:fs"

const path = process.argv[2]
const src = readFileSync(path, "utf8")

// --- strip strings, template literals and comments (keeps newlines) ---
function sanitize(input) {
  const out = []
  let i = 0
  let mode = "code"
  let tplDepth = 0
  while (i < input.length) {
    const c = input[i]
    const n = input[i + 1]
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; out.push(" ", " "); i += 2; continue }
      if (c === "/" && n === "*") { mode = "block"; out.push(" ", " "); i += 2; continue }
      if (c === "'") { mode = "sq"; out.push(" "); i += 1; continue }
      if (c === '"') { mode = "dq"; out.push(" "); i += 1; continue }
      if (c === "`") { mode = "tpl"; tplDepth = 0; out.push(" "); i += 1; continue }
      out.push(c); i += 1; continue
    }
    if (mode === "line") { out.push(c === "\n" ? "\n" : " "); if (c === "\n") mode = "code"; i += 1; continue }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; out.push(" ", " "); i += 2; continue }
      out.push(c === "\n" ? "\n" : " "); i += 1; continue
    }
    if (mode === "sq" || mode === "dq") {
      if (c === "\\") { out.push(" ", " "); i += 2; continue }
      if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"')) { mode = "code"; out.push(" ") } else { out.push(c === "\n" ? "\n" : " ") }
      i += 1; continue
    }
    // tpl
    if (c === "\\") { out.push(" ", " "); i += 2; continue }
    if (c === "`" && tplDepth === 0) { mode = "code"; out.push(" "); i += 1; continue }
    if (c === "$" && n === "{") { tplDepth += 1; out.push(" ", " "); i += 2; continue }
    if (c === "}" && tplDepth > 0) { tplDepth -= 1; out.push(" ", " "); i += 1; continue }
    out.push(c === "\n" ? "\n" : " "); i += 1; continue
  }
  return out.join("")
}

const clean = sanitize(src)

// --- 1) bracket balance ---
const pairs = { ")": "(", "]": "[", "}": "{" }
const opens = new Set(["(", "[", "{"])
const stack = []
const lines = clean.split("\n")
let bracketError = null
for (let ln = 0; ln < lines.length && !bracketError; ln += 1) {
  for (const ch of lines[ln]) {
    if (opens.has(ch)) stack.push({ ch, ln: ln + 1 })
    else if (pairs[ch]) {
      const top = stack.pop()
      if (!top || top.ch !== pairs[ch]) {
        bracketError = `line ${ln + 1}: unexpected '${ch}'${top ? ` (opened '${top.ch}' at line ${top.ln})` : ""}`
        break
      }
    }
  }
}
if (!bracketError && stack.length) {
  const top = stack[stack.length - 1]
  bracketError = `unclosed '${top.ch}' opened at line ${top.ln}`
}

// --- 2) brace/quote-aware JSX tag scanner ---
const JSX_NAMES = new Set(["box", "text", "span", "scrollbox", "Show", "For", "Switch", "Match"])
const voids = new Set(["br", "hr", "img", "input", "meta", "link"])
const tagStack = []
const tagErrors = []
const lineAt = (index) => src.slice(0, index).split("\n").length

for (let i = 0; i < clean.length; i += 1) {
  if (clean[i] !== "<") continue
  const prev = clean[i - 1]
  // skip generics / comparison like `Record<...` (prev char alnum) and `a < b`
  const closing = clean[i + 1] === "/"
  const nameStart = i + (closing ? 2 : 1)
  const nameMatch = clean.slice(nameStart).match(/^[A-Za-z][A-Za-z0-9_]*/)
  if (!nameMatch) continue
  const name = nameMatch[0]
  if (!JSX_NAMES.has(name)) continue
  if (!closing && /[A-Za-z0-9_$]/.test(prev ?? "")) continue

  // scan to the matching '>' at bracket depth 0, skipping quotes
  let j = nameStart + name.length
  let depth = 0
  let quote = null
  let selfClosing = false
  for (; j < clean.length; j += 1) {
    const ch = clean[j]
    if (quote) { if (ch === "\\") { j += 1; continue } if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue }
    if (ch === "{" || ch === "(" || ch === "[") { depth += 1; continue }
    if (ch === "}" || ch === ")" || ch === "]") { depth -= 1; continue }
    if (ch === ">" && depth === 0) {
      selfClosing = clean[j - 1] === "/"
      break
    }
    if (ch === "<" && depth === 0) break // malformed
  }
  const line = lineAt(i)
  if (closing) {
    const top = tagStack.pop()
    if (!top || top.name !== name) {
      tagErrors.push(`line ${line}: </${name}> does not match ${top ? `<${top.name}> (line ${top.line})` : "empty stack"}`)
    }
  } else if (!selfClosing && !voids.has(name)) {
    tagStack.push({ name, line })
  }
  i = j
}
for (const leftover of tagStack) tagErrors.push(`line ${leftover.line}: unclosed <${leftover.name}>`)

console.log(`file: ${path}`)
console.log(`balanced brackets/parens/braces: ${bracketError ? "FAIL" : "PASS"}`)
if (bracketError) console.log(`  ${bracketError}`)
console.log(`balanced JSX tags (${JSX_NAMES.size}-name whitelist): ${tagErrors.length === 0 ? "PASS" : "FAIL"}`)
for (const err of tagErrors) console.log(`  ${err}`)
process.exit(bracketError || tagErrors.length ? 1 : 0)
