const {test, after} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {installElectronStub} = require('./helpers/electron-stub');

/*
 * `core/user-data.js` (the custom map files behind four IPC channels) and
 * `core/utils.js` (the two fs helpers it uses), against a temp userData.
 * The one rule that matters: a name the user typed can never read, write or
 * delete anything outside `userData/custom/`.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-user-data-'));
after(() => fs.rmSync(TMP, {recursive: true, force: true}));

let userData = TMP;
const stub = installElectronStub({app: {getPath: () => userData}});
const UserData = require('../src/core/user-data');
const {ensureDirectoryExistence, getFilesFromDir} = require('../src/core/utils');

function build() {
    userData = fs.mkdtempSync(path.join(TMP, 'u-'));
    const library = {invalidated: 0, invalidate() { this.invalidated += 1; }};
    new UserData(library);
    // A file beside custom/ that a traversal would reach.
    fs.writeFileSync(path.join(userData, 'settings-app.json'), '{"opacity":0.5}');
    return {library, custom: path.join(userData, 'custom')};
}

/** Every file under userData, relative, sorted — the whole observable disk. */
function snapshot() {
    return getFilesFromDir(userData).map(f => path.relative(userData, f).split(path.sep).join('/')).sort();
}

test('write, list, read and delete round-trip, and the catalogue is told', async () => {
    const {library} = build();
    await stub.invoke('write-custom-data', 'My Map.png', new Uint8Array([1, 2, 3]));
    assert.deepStrictEqual(await stub.invoke('get-custom-photos'), ['My Map.png']);
    assert.deepStrictEqual([...await stub.invoke('read-custom-data', 'My Map.png')], [1, 2, 3]);
    await stub.invoke('delete-custom-data', 'My Map.png');
    assert.deepStrictEqual(await stub.invoke('get-custom-photos'), []);
    assert.strictEqual(library.invalidated, 2, 'one invalidation per write and per delete');
});

test('the list creates custom/ on first use and starts empty', async () => {
    const {custom} = build();
    assert.ok(!fs.existsSync(custom));
    assert.deepStrictEqual(await stub.invoke('get-custom-photos'), []);
    assert.ok(fs.statSync(custom).isDirectory());
});

test('reading a map that is not there is an empty buffer, not an error', async () => {
    build();
    const bytes = await stub.invoke('read-custom-data', 'Gone.png');
    assert.ok(Buffer.isBuffer(bytes));
    assert.strictEqual(bytes.length, 0);
});

test('deleting a map that is not there is a no-op', async () => {
    build();
    await stub.invoke('delete-custom-data', 'Gone.png');
    assert.deepStrictEqual(snapshot(), ['settings-app.json']);
});

test('a traversal name is written inside custom/, never beside it', async () => {
    build();
    for (const name of ['../x.png', '..\\y.png', '../../../z.png', 'sub/../../w.png']) {
        await stub.invoke('write-custom-data', name, new Uint8Array([9]));
    }
    for (const file of snapshot()) {
        assert.ok(file === 'settings-app.json' || file.startsWith('custom/'), `${file} escaped custom/`);
    }
    assert.ok(!fs.existsSync(path.join(TMP, 'x.png')));
});

test('a traversal name cannot read or delete a file outside custom/', async () => {
    build();
    const read = await stub.invoke('read-custom-data', '../settings-app.json');
    assert.strictEqual(read.length, 0, 'read something outside custom/');
    await stub.invoke('delete-custom-data', '../settings-app.json');
    assert.ok(fs.existsSync(path.join(userData, 'settings-app.json')), 'deleted outside custom/');
});

test('".." resolves to userData itself: refused, and nothing outside custom/ changes', async () => {
    build();
    const before = snapshot();
    assert.strictEqual(await stub.invoke('write-custom-data', '..', new Uint8Array([1])), false);
    assert.strictEqual((await stub.invoke('read-custom-data', '..')).length, 0);
    await stub.invoke('delete-custom-data', '..');
    assert.deepStrictEqual(snapshot(), before);
});

test('an empty or "." name cannot replace the custom/ folder with a file', async () => {
    const {custom} = build();
    for (const name of ['', '.', null, undefined]) {
        await stub.invoke('write-custom-data', name, new Uint8Array([1])).catch(() => {});
    }
    assert.ok(!fs.existsSync(custom) || fs.statSync(custom).isDirectory());
    assert.deepStrictEqual(await stub.invoke('get-custom-photos'), []);
});

test('ensureDirectoryExistence builds every missing parent, and is idempotent', () => {
    const file = path.join(fs.mkdtempSync(path.join(TMP, 'e-')), 'a', 'b', 'c', 'file.txt');
    ensureDirectoryExistence(file);
    assert.ok(fs.statSync(path.dirname(file)).isDirectory());
    assert.strictEqual(ensureDirectoryExistence(file), true);
    assert.ok(!fs.existsSync(file), 'only the directories, never the file');
});

test('getFilesFromDir lists files recursively, never directories', () => {
    const root = fs.mkdtempSync(path.join(TMP, 'g-'));
    fs.mkdirSync(path.join(root, 'sub', 'deeper'), {recursive: true});
    fs.writeFileSync(path.join(root, 'one.png'), '');
    fs.writeFileSync(path.join(root, 'sub', 'deeper', 'two.png'), '');
    const found = getFilesFromDir(root).map(f => path.relative(root, f).split(path.sep).join('/')).sort();
    assert.deepStrictEqual(found, ['one.png', 'sub/deeper/two.png']);
    assert.deepStrictEqual(getFilesFromDir(path.join(root, 'sub', 'deeper', '..', 'deeper')).length, 1);
});
