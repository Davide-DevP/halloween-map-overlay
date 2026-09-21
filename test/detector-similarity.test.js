const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../src/core/map-detector/matcher');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');
const {
    buildSimilarity, similarPairsFromRows, FIXTURES, SIMILAR_MAP_SCORE
} = require('../scripts/prepare-detector');
const {buildTemplates, knownTemplates, measureSimilarity} = require('../scripts/build-pack');

/*
 * How far apart the maps' Tab panels actually are, and the build-time check
 * that keeps them that way. Nothing at runtime reads any of this: the matcher
 * scores every installed map on every gated-in frame, which is cheap enough
 * that skipping any of it was measured and dropped (docs/agents/detection.md
 * § Why there is no early exit). The separation still matters — it is what the
 * acceptance thresholds rest on — and a *new* map that is really an existing
 * one re-cut is a real authoring mistake, so both generators measure it and
 * say so.
 */

const KEYS = Object.keys(TEMPLATE_FILE.templates).sort();

test('the shipped maps are far apart, and the threshold sits in the gap', async () => {
    // The numbers docs/agents/detection.md quotes, asserted rather than
    // narrated. `*`-marked score = the map the frame shows; every other is a
    // cross-score.
    const built = await buildSimilarity(TEMPLATE_FILE.templates);
    assert.deepStrictEqual(built.measured, KEYS, 'every shipped map has frames of its own');
    assert.deepStrictEqual(built.pairs, [],
        'two shipped maps reached the threshold — see maps-authoring.md § When two maps score alike');

    let worstOwn = Infinity;
    let bestWrong = -Infinity;
    for (const row of built.rows) {
        worstOwn = Math.min(worstOwn, row.scores[row.key]);
        for (const [key, score] of Object.entries(row.scores)) {
            if (key !== row.key) bestWrong = Math.max(bestWrong, score);
        }
    }
    assert.ok(worstOwn >= 0.94, `the worst right-map score is ${worstOwn.toFixed(4)}`);
    assert.ok(bestWrong <= 0.51, `the best wrong-map score is ${bestWrong.toFixed(4)}`);
    // The threshold has to sit in that gap: above every wrong pair by a wide
    // margin, and below the accept floor, or it could never fire on a real map.
    assert.ok(SIMILAR_MAP_SCORE > bestWrong + 0.15, `${SIMILAR_MAP_SCORE} is too close to ${bestWrong}`);
    assert.ok(SIMILAR_MAP_SCORE < M.DEFAULT_MIN_SCORE);
    assert.ok(SIMILAR_MAP_SCORE < worstOwn);
});

test('similarPairsFromRows: the threshold, in either direction, once per pair', () => {
    const rows = [
        // A map's score against its own templates is not a pair.
        {key: 'a/One', scores: {'a/One': 1, 'a/Two': 0.69, 'a/Three': 0.70}},
        // The other direction of the same pair: still one entry.
        {key: 'a/Three', scores: {'a/One': 0.95, 'a/Two': 0.1, 'a/Three': 1}},
        {key: 'a/Two', scores: {'a/One': 0.2, 'a/Two': 1, 'a/Three': 0.2}}
    ];
    assert.deepStrictEqual(similarPairsFromRows(rows, 0.70), [['a/One', 'a/Three']],
        '0.70 is inclusive, 0.69 is not, and the pair is stored once with its keys sorted');
    assert.deepStrictEqual(similarPairsFromRows(rows, 0.96), []);
    assert.deepStrictEqual(similarPairsFromRows(rows, 0.6),
        [['a/One', 'a/Three'], ['a/One', 'a/Two']]);
    // The default is the constant, not a repeated literal.
    assert.deepStrictEqual(similarPairsFromRows([
        {key: 'a/One', scores: {'a/Two': SIMILAR_MAP_SCORE}}
    ]), [['a/One', 'a/Two']]);
    for (const empty of [null, undefined, [], [{key: 'a/One'}]]) {
        assert.deepStrictEqual(similarPairsFromRows(empty, 0.5), [], JSON.stringify(empty));
    }
    // A NaN score is not "above the threshold": one bad number must neither
    // flag every pair nor silently clear one.
    assert.deepStrictEqual(similarPairsFromRows([{key: 'a/One', scores: {'a/Two': NaN}}], 0.1), []);
});

test('build-pack flags a map that is really an existing one', async () => {
    // The check's whole job: a pack built from a shipped map's own Tab
    // screenshot is that map, and must be caught before it is published as a
    // second entry in the gallery.
    const key = 'tester/Fake Map';
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-similar-'));
    try {
        const clone = await buildTemplates(key, [path.join(FIXTURES, 'tab-haddonfield-heights.png')]);
        const known = knownTemplates(out, {packs: []}, key);
        assert.deepStrictEqual(Object.keys(known).sort(), KEYS, 'the bundled maps are the baseline');

        const result = await measureSimilarity(key, clone.templates,
            [path.join(FIXTURES, 'tab-haddonfield-heights.png')], known);
        assert.deepStrictEqual(result.alike, ['deftyconchgaming/Haddonfield Heights']);
        assert.ok(result.pairs.some(p => p.includes(key)));

        // Both directions are really measured: the flagged map's *other* view
        // (a civilian frame, which this pack has no template for) also scores
        // over the threshold against it, and so does its stored variant.
        const civilian = result.rows.find(r => r.file === 'tab-civilian-haddonfield-heights.png');
        assert.ok(civilian.scores[key] >= SIMILAR_MAP_SCORE,
            `a frame of the real map scored ${civilian.scores[key].toFixed(4)} against the clone`);
        assert.ok(result.rows.some(r => r.file.includes('stored variant')),
            'the stored variants are in the matrix, or a pack with no fixtures here is invisible');

        // A pack of a genuinely different map is not flagged.
        const other = await measureSimilarity(key, clone.templates,
            [path.join(FIXTURES, 'tab-haddonfield-heights.png')],
            {'deftyconchgaming/Orange Grove Estates': TEMPLATE_FILE.templates['deftyconchgaming/Orange Grove Estates']});
        assert.deepStrictEqual(other.alike, []);
    } finally {
        fs.rmSync(out, {recursive: true, force: true});
    }
});

test('knownTemplates reads the packs the index already published', () => {
    // The matrix has to include them, or the second pack of a pair is never
    // compared with the first.
    const key = 'tester/New Map';
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-similar-'));
    try {
        const published = 'tester/Old Map';
        fs.mkdirSync(path.join(out, 'tester-old-map'));
        fs.writeFileSync(path.join(out, 'tester-old-map', 'templates.json'), JSON.stringify({
            format: 2,
            size: TEMPLATE_FILE.size,
            templates: {[published]: [new Array(TEMPLATE_FILE.size ** 2).fill(0.5)]}
        }));
        const index = {packs: [{key: published, base: 'tester-old-map'}]};
        assert.deepStrictEqual(Object.keys(knownTemplates(out, index, key)).sort(),
            KEYS.concat([published]).sort());
        // A pack the index names but `packs/` does not hold ends the script
        // (`die`), so it cannot be asserted from inside this process — what is
        // checked here is that a published pack really enters the matrix.
    } finally {
        fs.rmSync(out, {recursive: true, force: true});
    }
});
