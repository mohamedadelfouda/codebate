// Minimal, XSS-safe Markdown renderer for chat messages.
//
// Safety model: the raw text is HTML-escaped FIRST, so the working string contains
// no live `< > & " '`. Every tag emitted below is a fixed literal, and every
// interpolated value is a slice of the already-escaped string — so untrusted
// content can never introduce markup. Links are restricted to http(s) schemes.
//
// Each block-level element carries dir="auto" so a message that mixes Arabic and
// English gets per-paragraph direction instead of one direction for the whole body.

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// A NUL byte cannot occur in normal text (and is stripped from input below), so it
// is a safe placeholder marker for parking already-emitted spans out of the way.
const SENTINEL = String.fromCharCode(0);
const SLOT = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");
// Link URLs stop at whitespace, ")", or the sentinel — the last prevents a parked
// span from ever being captured into an href. Both capture groups are length-bounded
// (unlike an unbounded `+?`) so a malformed line with many `[` and no matching `](...)`
// can't force a quadratic re-scan of the rest of the line from every bracket.
const LINK = new RegExp("\\[([^\\]\\n]{1,500}?)\\]\\((https?://[^\\s)" + SENTINEL + "]{1,2000}?)\\)", "g");

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>'"]/g, (c) => ESCAPE[c]);
}

// Inline spans, applied to an already-escaped string. Inline code AND links are
// parked behind sentinels before the emphasis passes run, so those passes can
// never re-parse a code span's contents or corrupt an emitted anchor's markup
// (e.g. matching a `_` inside target="_blank"). Parked spans are expanded last,
// looping so a link that itself contains inline code is fully restored.
function renderInline(escaped) {
  const parked = [];
  const park = (html) => SENTINEL + (parked.push(html) - 1) + SENTINEL;
  let s = escaped.replace(/`([^`\n]+?)`/g, (_, code) => park(`<code>${code}</code>`));
  s = s.replace(LINK, (_, text, url) => park(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`));
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");
  let previous;
  do { previous = s; s = s.replace(SLOT, (_, index) => parked[Number(index)] ?? ""); } while (s !== previous);
  return s;
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;
const ORDERED = /^\s*\d+\.\s+/;

// Normalize away CR and any stray sentinel bytes from untrusted input before parsing.
function normalize(raw) {
  return String(raw ?? "").split(SENTINEL).join("").replace(/\r\n?/g, "\n");
}

export function renderMarkdown(raw) {
  const lines = escapeHtml(normalize(raw)).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buffer.push(lines[i]); i += 1; }
      i += 1; // consume the closing fence
      blocks.push(`<pre class="md-pre" dir="ltr" tabindex="0"><code>${buffer.join("\n")}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(`<div class="md-h" dir="auto">${renderInline(heading[2])}</div>`);
      i += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = ORDERED.test(line);
      const items = [];
      // Keep a run to one marker kind so an ordered item can't be swallowed as a bullet.
      while (i < lines.length && LIST_ITEM.test(lines[i]) && ORDERED.test(lines[i]) === ordered) {
        items.push(renderInline(lines[i].replace(LIST_ITEM, "")));
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(`<${tag} class="md-list" dir="auto">${items.map((it) => `<li dir="auto">${it}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*$/.test(line)) { i += 1; continue; }

    const paragraph = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i])
      && !/^#{1,6}\s/.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p dir="auto">${renderInline(paragraph.join("<br>"))}</p>`);
  }
  return blocks.join("");
}
