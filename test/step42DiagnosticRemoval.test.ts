/**
 * PRE-RELEASE-UX-A14 — the development diagnostic block is gone from the release panel.
 *
 * ## What was removed, and what was not
 *
 * The panel used to list at most three parsed teaching-class identities under 「教学班识别样本」 so the parser could be checked against the page by eye. That was a
 * development aid, and it shipped to users. This slice removes the SURFACE — the section, the renderer that filled it, and the one call site that fed it.
 *
 * Nothing about READING the page changed. The content script still scans teaching-class rows, the status reply still carries its bounded sample, and both the
 * complete and the bounded contracts are still asserted elsewhere. What is asserted here is the removal, and that its return would fail.
 *
 * ## Why the built artifact is decoded first
 *
 * esbuild escapes non-ASCII literals as `\uXXXX`, so a raw `includes('教学班识别样本')` against the bundle answers `false` for text that IS present — which would make
 * a negative assertion pass without checking anything. Measured: the raw panel does not contain the phrase at all, while a decoded panel that still carried the
 * block does.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sidepanelDir = join(repoRoot, 'apps', 'extension', 'src', 'sidepanel');
const panelSource = readFileSync(join(sidepanelDir, 'sidepanel.ts'), 'utf8');
const panelHtml = readFileSync(join(sidepanelDir, 'sidepanel.html'), 'utf8');
const panelCss = readFileSync(join(sidepanelDir, 'sidepanel.css'), 'utf8');
const builtHtml = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.html'), 'utf8');
const builtPanelRaw = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.js'), 'utf8');

/** The built panel with esbuild's `\uXXXX` escaping undone. */
const builtPanel = builtPanelRaw.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** The words and ids that must not come back. */
const REMOVED_HEADING = '教学班识别样本';
const REMOVED_IDS = ['course-samples', 'course-samples-list', 'course-samples-empty'];

describe('PRE-RELEASE-UX-A14 the diagnostic block is out of the production panel', () => {
  it('A. the built document carries no such heading', () => {
    expect(builtHtml.includes(REMOVED_HEADING), 'built sidepanel.html').toBe(false);
    // The decode is checked FIRST, so a broken decode cannot make the assertions below pass vacuously.
    expect(builtPanel.includes('学生自报平均成绩'), 'the decode must produce readable Chinese').toBe(true);
    expect(builtPanel.includes(REMOVED_HEADING)).toBe(false);
  });

  it('B. none of the three ids exist in the source markup or the build', () => {
    for (const id of REMOVED_IDS) {
      expect(panelHtml.includes(id), id).toBe(false);
      expect(builtHtml.includes(id), id).toBe(false);
    }
  });

  it('C. the panel code no longer looks for them, and holds no sample data', () => {
    for (const gone of [REMOVED_HEADING, ...REMOVED_IDS, 'SAMPLES_ELEMENT_ID', 'setRowSamples']) {
      expect(panelSource.includes(gone), gone).toBe(false);
    }
    /*
     * The status reply still CARRIES a bounded row sample — that contract is asserted elsewhere and is not this slice's business — but the panel must not read it.
     * A panel that decoded a field it never rendered is exactly how the display would come back by accident.
     */
    expect(/record\.rows/u.test(panelSource)).toBe(false);
    expect(panelSource.includes('RowIdentity')).toBe(false);
  });

  it('D. the removed styles went with the removed markup', () => {
    // Markup that cannot be reached needs no presentation, and a leftover rule is how a removed block quietly reappears.
    for (const gone of ['panel-samples']) {
      expect(panelCss.includes(gone), gone).toBe(false);
    }
  });

  it('E. the READ path is untouched: the scanner and both row contracts still exist', () => {
    /*
     * The fact that users no longer see sample rows must not mean the scanner stopped collecting real rows. Asserted at the source that does the reading, so the
     * removal cannot be mistaken for a capability loss.
     */
    const contentSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'content', 'content-script.ts'), 'utf8');
    expect(contentSource).toContain('function scanVisibleRows(');
    expect(contentSource).toContain('QUERY_VISIBLE_ROWS_MESSAGE');
    // The bounded diagnostic reply is still bounded, and the complete one is still complete: two different contracts, both unchanged.
    expect(contentSource).toContain('scanVisibleRows(MAX_ROW_SAMPLES)');
    expect(contentSource).toContain('rows: supported ? scanVisibleRows() : []');
    // And the composition that recommends from a complete read is untouched.
    expect(readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'background', 'visible-courses.ts'), 'utf8')).toContain('requestVisibleRows');
  });

  it('F. the panel still renders everything it is supposed to', () => {
    /*
     * "Opening the panel still works without them" is asserted as the presence of the elements the panel DOES require. `cardTargets` reports a missing element and
     * returns null, so if the removal had taken one of these with it, the cards would silently stop rendering.
     */
    for (const id of [
      'page-status', 'panel-count', 'fact-version',
      'full-preparation-start', 'full-preparation-cancel',
      'card-list-recommended', 'card-list-rated', 'card-list-insufficient',
      'cards-recommended', 'cards-rated', 'cards-insufficient',
      'grade-disclaimer', 'rated-toggle', 'rated-count', 'rated-cards',
    ]) {
      expect(panelHtml.includes(`id="${id}"`), id).toBe(true);
    }
    // The result area and its summary counts survived the removal too.
    for (const id of ['recommendation', 'recommendation-count-recommended', 'recommendation-count-rated', 'recommendation-count-insufficient']) {
      expect(panelHtml.includes(`id="${id}"`), id).toBe(true);
    }
  });

  it('G. the panel no longer depends on any removed node to render', () => {
    // Each `getElementById` the panel still performs must name an element the markup still has.
    const looked = [...panelSource.matchAll(/getElementById\('([^']+)'\)/gu)].map((match) => match[1] ?? '');
    expect(looked.length).toBeGreaterThan(0);
    for (const id of new Set(looked)) {
      if (id === 'grade-disclaimer' || id.startsWith('card-list-') || id.startsWith('cards-') || id.startsWith('recommendation') || id.startsWith('full-preparation')) {
        expect(panelHtml.includes(`id="${id}"`), id).toBe(true);
      }
    }
  });

  it('H. the skeleton gate still SCANS the artifact rather than asserting a constant', () => {
    /*
     * The gate is the second guard against reintroduction, and a mutation proved why this check exists: replacing its verdict with `check(..., true)` left every test
     * green, because the removal suite reads the artifact itself and the gate had stopped reading anything.
     *
     * What is asserted is that the gate's check still performs the substring test on the built document. The exact line is pinned, which is the same technique the
     * panel-hash pin uses: an edit that guts the check has to change the line, so it cannot pass unnoticed. A constant — `true`, or a captured variable — would satisfy
     * neither fragment.
     */
    const gate = readFileSync(join(repoRoot, 'scripts', 'verify-extension-skeleton.mjs'), 'utf8');
    expect(gate).toContain('check(\'产物面板不含开发用「教学班识别样本」区块\'');
    expect(gate).toContain("readFileSync(join(distDir, 'sidepanel', 'sidepanel.html'), 'utf8').includes('教学班识别样本')");
    // And the source-side half of the rule is present too.
    expect(gate).toContain("for (const gone of ['教学班识别样本', 'course-samples'])");
  });
});
