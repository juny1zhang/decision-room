// The stylesheet's legibility floor (public/app.css): no text is set below 11px, at any breakpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const css = (await fs.readFile(new URL('../../public/app.css', import.meta.url), 'utf8')).replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);
/** Every font-size and font declaration, media queries included, as "property: value". */
const declarations = [...css.matchAll(/(?<![\w-])(?:font-size|font)\s*:[^;{}]*/g)].map(([text]) =>
  text.replace(/\s+/g, ' ')
);

test('the stylesheet sets no text below 11px', () => {
  assert.ok(declarations.length > 50, 'font declarations are found');
  const tooSmall = declarations.filter((declaration) => {
    // In the font shorthand, a px value after "/" is the line height.
    const sizes = [...declaration.matchAll(/(?<!\/\s*)(\d*\.?\d+)px/g)].map(([, value]) => Number(value));
    return sizes.some((size) => size < 11);
  });
  assert.deepEqual(tooSmall, []);
});

test('a relative font size below 1em keeps an 11px floor', () => {
  const unguarded = declarations.filter(
    (declaration) =>
      /(?<![\d.])0?\.\d+r?em|(?<![\d.])\d{1,2}(?:\.\d+)?%/.test(declaration) &&
      !/max\(\s*(?:1[1-9]|[2-9]\d)px/.test(declaration)
  );
  assert.deepEqual(unguarded, []);
});
