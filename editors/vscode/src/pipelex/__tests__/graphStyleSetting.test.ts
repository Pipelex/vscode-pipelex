import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_STYLES } from '@pipelex/mthds-ui';

// graphConfig.ts imports `vscode`, which exists only inside an Extension Host;
// nothing read here touches it.
vi.mock('vscode', () => ({}));

import { GRAPH_STYLE_IDS } from '../graph/graphConfig';

// Three lists name the graph styles, and they must agree:
//
//   - mthds-ui's registry (`GRAPH_STYLES`), which the renderer draws from and
//     the toolbar's style menu lists;
//   - the extension host's local copy (`GRAPH_STYLE_IDS` in graphConfig.ts),
//     kept so the host never imports the webview package, which guards the
//     setting on its way in;
//   - the `pipelex.graph.style` enum, which is what a user can pick in Settings.
//
// The menu offers every registered style and writes the choice back to the
// setting, so a style mthds-ui adds would be pickable in the graph, refused by
// the host's guard on the next open, and flagged as invalid in settings.json.
// This test is how the bump that brings a new style finds out.

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const styleSetting: { enum: string[]; enumDescriptions: string[]; default: string } =
    pkg.contributes.configuration.properties['pipelex.graph.style'];

describe('the graph style lists agree', () => {
    it('the host copy matches mthds-ui\'s registry, in registry order', () => {
        expect([...GRAPH_STYLE_IDS]).toEqual(Object.keys(GRAPH_STYLES));
    });

    it('the pipelex.graph.style enum offers exactly the host\'s styles', () => {
        expect(styleSetting.enum).toEqual([...GRAPH_STYLE_IDS]);
        expect(styleSetting.enumDescriptions).toHaveLength(styleSetting.enum.length);
    });

    it('the setting defaults to detailed, the drawing graphs had before styles', () => {
        expect(styleSetting.default).toBe('detailed');
    });
});
