import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContent(markup) {
  return String(markup || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function labelledByTarget(targetId) {
  const escapedId = escapeRegExp(targetId);
  return new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bid=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i").exec(html);
}

test("static form controls have programmatic accessible names", () => {
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].map((match) => match[0]);

  for (const control of controls) {
    if (/\btype=["']hidden["']/i.test(control)) continue;
    const id = control.match(/\bid=["']([^"']+)["']/i)?.[1];
    assert.ok(id, `form control is missing an id: ${control}`);

    const ariaLabel = control.match(/\baria-label=["']([^"']*)["']/i)?.[1].trim();
    const labelledBy = control.match(/\baria-labelledby=["']([^"']*)["']/i)?.[1].trim();
    const hasAriaLabelledBy = Boolean(labelledBy) && labelledBy.split(/\s+/).every((targetId) => textContent(labelledByTarget(targetId)?.[2]));
    const hasAriaName = Boolean(ariaLabel) || hasAriaLabelledBy;
    const label = new RegExp(`<label\\b[^>]*\\bfor=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/label>`, "i").exec(html);
    const hasLabel = Boolean(textContent(label?.[1]));
    assert.ok(hasAriaName || hasLabel, `#${id} is missing an associated label`);
  }
});

test("aria-labelledby references existing nonblank labels", () => {
  const references = [...html.matchAll(/<[a-z][\w:-]*\b[^>]*\baria-labelledby=["']([^"']*)["'][^>]*>/gi)];
  assert.ok(references.length > 0, "static markup should contain aria-labelledby relationships");

  for (const reference of references) {
    const targetIds = reference[1].trim().split(/\s+/).filter(Boolean);
    assert.ok(targetIds.length > 0, `aria-labelledby is blank: ${reference[0]}`);
    for (const targetId of targetIds) {
      const target = labelledByTarget(targetId);
      assert.ok(target, `aria-labelledby references missing #${targetId}`);
      assert.ok(textContent(target[2]), `aria-labelledby references blank #${targetId}`);
    }
  }
});
