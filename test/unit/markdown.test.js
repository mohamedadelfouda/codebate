import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "../../public/markdown.js";

test("escapes HTML so raw markup can never render", () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes("<script>"), "raw <script> must be escaped");
  assert.ok(html.includes("&lt;script&gt;"), "angle brackets become entities");
});

test("an img/onerror injection cannot break out of text", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/i.test(html), "no live <img> tag");
  assert.ok(html.includes("&lt;img"), "the tag is shown as escaped text");
});

test("javascript: and other non-http links are NOT turned into anchors", () => {
  for (const evil of ["[x](javascript:alert(1))", "[x](data:text/html,<script>)", "[x](file:///etc/passwd)"]) {
    const html = renderMarkdown(evil);
    assert.ok(!html.includes("<a "), `must not linkify ${evil}`);
    assert.ok(!/javascript:/i.test(html) || !html.includes("href"), "no javascript: href");
  }
});

test("a huge line of unterminated link brackets does not hang (regex is length-bounded, not quadratic)", () => {
  const start = Date.now();
  const html = renderMarkdown("[".repeat(20000) + "tail with no closing brackets at all");
  assert.ok(Date.now() - start < 1000, "must render well under a second, not scan quadratically");
  assert.match(html, /tail with no closing brackets/);
});

test("http/https links render as safe anchors", () => {
  const html = renderMarkdown("see [docs](https://example.com/a?b=1&c=2)");
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test("emphasis passes cannot corrupt an emitted anchor's target attribute", () => {
  const html = renderMarkdown("[a](https://e.com/x) some_ [b](https://e.com/y)");
  assert.ok(!/target="<em>/.test(html), "no <em> spliced into target=");
  assert.match(html, /target="_blank" rel="noopener noreferrer">a<\/a>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer">b<\/a>/);
});

test("a link whose text contains inline code is fully restored", () => {
  const html = renderMarkdown("[use `run`](https://e.com)");
  assert.match(html, /<a href="https:\/\/e\.com"[^>]*>use <code>run<\/code><\/a>/);
});

test("bold, italic and inline code render", () => {
  assert.match(renderMarkdown("**b**"), /<strong>b<\/strong>/);
  assert.match(renderMarkdown("_i_"), /<em>i<\/em>/);
  assert.match(renderMarkdown("`x`"), /<code>x<\/code>/);
});

test("inline code contents are not re-parsed as markdown", () => {
  const html = renderMarkdown("`a*b*c`");
  assert.match(html, /<code>a\*b\*c<\/code>/);
  assert.ok(!html.includes("<em>"), "asterisks inside code stay literal");
});

test("plain digits with surrounding spaces are never mistaken for a code slot", () => {
  const html = renderMarkdown("finish step 3 then step 4 today");
  assert.ok(!html.includes("<code>"), "no spurious <code> from bare numbers");
  assert.ok(html.includes("step 3 then step 4"), "text is preserved verbatim");
});

test("headings and lists become block elements with per-block direction", () => {
  const html = renderMarkdown("## Title\n- one\n- two");
  assert.match(html, /<div class="md-h" dir="auto">Title<\/div>/);
  assert.match(html, /<ul class="md-list" dir="auto"><li dir="auto">one<\/li><li dir="auto">two<\/li><\/ul>/);
});

test("ordered lists render as <ol>", () => {
  assert.match(renderMarkdown("1. first\n2. second"), /<ol class="md-list" dir="auto"><li[^>]*>first<\/li>/);
});

test("a bullet list and an ordered list are not merged into one block", () => {
  const html = renderMarkdown("- one\n1. two");
  assert.match(html, /<ul class="md-list"[^>]*><li[^>]*>one<\/li><\/ul>/);
  assert.match(html, /<ol class="md-list"[^>]*><li[^>]*>two<\/li><\/ol>/);
});

test("a stray sentinel/NUL in input cannot forge a code slot", () => {
  const nul = String.fromCharCode(0);
  const html = renderMarkdown("a" + nul + "0" + nul + "b");
  assert.ok(!html.includes("<code>"), "no code element from a forged marker");
  assert.ok(!html.includes("undefined"), "no undefined leaks into output");
  assert.match(html, /a0b/);
});

test("inline code inside a link URL cannot corrupt the href attribute", () => {
  const html = renderMarkdown("[x](https://e.com/`p`)");
  assert.ok(!/<a [^>]*<code>/.test(html), "no <code> spliced inside an anchor tag");
  assert.ok(!html.includes('href="https://e.com/<code>'), "href stays clean");
});

test("plain spaces are preserved (the NUL strip must not touch spaces)", () => {
  assert.match(renderMarkdown("a b  c"), /a b {1,2}c/);
});

test("paragraphs are separated and each carries dir=auto (bidi fix)", () => {
  const html = renderMarkdown("مرحبا يا عالم\n\nhello world");
  const paragraphs = html.match(/<p dir="auto">/g) || [];
  assert.equal(paragraphs.length, 2, "each paragraph is its own auto-directed block");
  assert.match(html, /hello world/);
});

test("fenced code blocks are preserved verbatim and forced LTR", () => {
  const html = renderMarkdown("```\nconst x = 1 < 2;\n```");
  assert.match(html, /<pre class="md-pre" dir="ltr" tabindex="0"><code>const x = 1 &lt; 2;<\/code><\/pre>/);
});

test("escapeHtml handles null/undefined without throwing", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});
