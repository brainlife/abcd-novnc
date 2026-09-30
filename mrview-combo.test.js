const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const prepare = require('./mrview-combo');
const projectId = 'a'.repeat(24), baseId = 'b'.repeat(24), tractId = 'c'.repeat(24);
async function fixture(run) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mrview-v2-')));
    const task = path.join(root, 'task'); fs.mkdirSync(task);
    const sourceRoot = path.join(root, 's3'); fs.mkdirSync(sourceRoot);
    const layers = [
        { datasetId: baseId, path: 't1.nii.gz', role: 'base', label: 'T1w' },
        { datasetId: tractId, path: 'track.tck', role: 'tract', label: 'Left arcuate' },
    ].map(layer => {
        const relative = `${projectId}/${layer.datasetId}/${layer.path}`;
        const file = path.join(sourceRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'original');
        return { ...layer, projectId, bucket: 'brainlife', storage: 's3fs', key: `archive/${relative}`, size: 8,
            etag: '"abc"', versionId: null, modified: fs.statSync(file).mtime.toISOString(), url: `https://brainlife.s3.amazonaws.com/archive/${relative}` };
    });
    const manifest = { version: 3, audience: 'brainlife-mrview', projectId, subject: '01', userId: 'user',
        issuedAt: Math.floor(Date.now()/1000), expiresAt: Math.floor(Date.now()/1000)+3600, totalBytes: 16, layers };
    const token = '1'.repeat(64);
    const config = { type: 'mrview-combo', project_id: projectId, mrview_token: token };
    let authorized;
    function publish() { authorized = JSON.parse(JSON.stringify(manifest)); }
    publish();
    let downloads = 0;
    const options = { taskDir: task, hostTaskDir: task, availableMemoryBytes: 32,
        resolveSession: async config => {if (config.mrview_token !== token) throw new Error('Invalid session token'); return authorized;},
        env: { MRVIEW_CACHE_DIR: path.join(root, 'cache'), MRVIEW_S3_MOUNTS: JSON.stringify([{ bucket: 'brainlife', prefix: 'archive/', root: sourceRoot }]) },
        diskStat: { bavail: 1000, bsize: 1024 },
        download: async (layer, file) => { downloads++; fs.writeFileSync(file, 'original', {mode: 0o600}); return crypto.createHash('sha256').update('original').digest('hex'); },
    };
    try { await run({ root, task, sourceRoot, config, manifest, options, publish, downloads: () => downloads }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('mounts only exact project files read-only, never a bucket, dataset or task directory', () => fixture(async f => {
    const args = await prepare(f.config, f.options);
    const mounts = args.filter((_, index) => index % 2 === 1);
    assert.equal(mounts.length, 3);
    assert(mounts.every(mount => mount.endsWith(',readonly')));
    assert(mounts.slice(0,2).every(mount => mount.includes(`${f.sourceRoot}/${projectId}/`)));
    assert(mounts.every(mount => !mount.includes('target=/input') && !mount.includes('target=/scene,')));
    assert.equal(f.downloads(), 0);
    const report = JSON.parse(fs.readFileSync(path.join(f.task, 'mrview-preflight.json')));
    assert.equal(report.mountedBytes, 16); assert.equal(report.downloadBytes, 0); assert.equal(report.availableMemoryBytes, 32); assert(report.warnings.length);
    const startup = fs.readFileSync(path.join(f.task, 'mrview-combo/xstartup'), 'utf8');
    assert.equal((startup.match(/vglrun mrview/g) || []).length, 1);
}));
test('downloads selected files only and reuses versioned cache across sessions', () => fixture(async f => {
    f.options.env.MRVIEW_S3_MOUNTS = '[]';
    await prepare(f.config, f.options); assert.equal(f.downloads(), 2);
    const next = path.join(f.root, 'next'); fs.mkdirSync(next);
    await prepare(f.config, { ...f.options, taskDir: next, hostTaskDir: next }); assert.equal(f.downloads(), 2);
    const report = JSON.parse(fs.readFileSync(path.join(next, 'mrview-preflight.json'))); assert.equal(report.cachedBytes, 16);
    // Same-size corrupt cache entries must not be reused.
    const cached = path.join(f.options.env.MRVIEW_CACHE_DIR, projectId, prepare.cacheIdentity(f.manifest.layers[0]));
    fs.writeFileSync(cached, 'corrupt!');
    await prepare(f.config, { ...f.options, taskDir: next, hostTaskDir: next }); assert.equal(f.downloads(), 3);
}));
test('rejects selected-project substitution and ignores task-provided file manifests', () => fixture(async f => {
    f.config.project_id = 'd'.repeat(24);
    await assert.rejects(prepare(f.config, f.options), /mismatched/);
    f.config.project_id = projectId;
    f.config.mrview_grant = {payload: 'untrusted-files'};
    f.config.layers = [{key: 'archive/other/private.nii.gz'}];
    await prepare(f.config, f.options); assert.equal(f.downloads(), 0);
    f.manifest.layers[0].key = 'archive/other/private.nii.gz'; f.publish();
    await assert.rejects(prepare(f.config, f.options), /escapes selected project/);
}));
test('rejects a symlink from the selected dataset into another project', () => fixture(async f => {
    const base = path.join(f.sourceRoot, projectId, baseId, 't1.nii.gz'); fs.unlinkSync(base);
    const foreign = path.join(f.sourceRoot, 'other-project.nii.gz'); fs.writeFileSync(foreign, 'original'); fs.symlinkSync(foreign, base);
    await assert.rejects(prepare(f.config, f.options), /redirects outside/); assert.equal(f.downloads(), 0);
}));
test('falls back from a stale mount and does not reuse another version from cache', () => fixture(async f => {
    f.manifest.layers[0].modified = new Date(0).toISOString(); f.publish();
    await prepare(f.config, f.options); assert.equal(f.downloads(), 1);
    f.manifest.layers[0].etag = '"new-version"'; f.publish();
    await prepare(f.config, f.options); assert.equal(f.downloads(), 2);
}));
test('insufficient disk fails before downloading with capacity report available', () => fixture(async f => {
    f.options.env.MRVIEW_S3_MOUNTS = '[]'; f.options.diskStat = { bavail: 1, bsize: 1 };
    await assert.rejects(prepare(f.config, f.options), /There isn’t enough space to open these files/);
    assert.equal(f.downloads(), 0); assert(fs.existsSync(path.join(f.task, 'mrview-preflight.json')));
}));
test('expired sessions cannot use even existing mounted or cached data', () => fixture(async f => {
    f.manifest.expiresAt = Math.floor(Date.now()/1000)-1; f.publish();
    await assert.rejects(prepare(f.config, f.options), /Expired/); assert.equal(f.downloads(), 0);
}));
test('ordinary viewers do not require a session token', async () => assert.deepEqual(await prepare({type:'mrview'}, {}), []));
test('rejects cached symlinks and invalid tokens cannot reuse valid cached content', () => fixture(async f => {
    f.options.env.MRVIEW_S3_MOUNTS = '[]'; await prepare(f.config, f.options);
    const file = path.join(f.options.env.MRVIEW_CACHE_DIR, projectId, prepare.cacheIdentity(f.manifest.layers[0]));
    fs.unlinkSync(file); fs.symlinkSync(path.join(f.sourceRoot, projectId, baseId, 't1.nii.gz'), file);
    await assert.rejects(prepare(f.config, f.options), /Invalid cache entry/);
    f.config.mrview_token = '0'.repeat(64);
    await assert.rejects(prepare(f.config, f.options), /Invalid session token/);
}));
test('host mount mappings preserve only the authorized project-relative file path', () => fixture(async f => {
    f.options.env.MRVIEW_S3_MOUNTS = JSON.stringify([{bucket: 'brainlife', prefix: 'archive/', root: f.sourceRoot, hostRoot: '/host/archive'}]);
    const args = await prepare(f.config, f.options);
    assert(args.some(arg => arg.includes(`source=/host/archive/${projectId}/${baseId}/t1.nii.gz,`)));
    assert(!args.some(arg => arg.includes(`source=${f.sourceRoot}`)));
}));
test('cache quota evicts old cached files without exposing or deleting pinned session files', () => fixture(async f => {
    f.options.env.MRVIEW_S3_MOUNTS = '[]'; f.options.env.MRVIEW_CACHE_MAX_BYTES = '16';
    fs.mkdirSync(path.join(f.options.env.MRVIEW_CACHE_DIR, projectId), {recursive:true, mode: 0o700});
    const old = path.join(f.options.env.MRVIEW_CACHE_DIR, projectId, 'f'.repeat(64)); fs.writeFileSync(old, Buffer.alloc(16));
    await prepare(f.config, f.options);
    assert(!fs.existsSync(old));
    const pins = fs.readdirSync(path.join(f.task, 'mrview-combo')).filter(name => name.startsWith('source-'));
    assert.equal(pins.length, 2); assert(pins.every(name => fs.readFileSync(path.join(f.task, 'mrview-combo', name), 'utf8') === 'original'));
}));
test('no unverified partial download can be mounted or reused', () => fixture(async f => {
    f.options.env.MRVIEW_S3_MOUNTS = '[]'; f.options.download = async (_, file) => { fs.writeFileSync(file, 'short'); throw new Error('connection lost'); };
    await assert.rejects(prepare(f.config, f.options), /connection lost/);
    assert.equal(fs.readdirSync(path.join(f.options.env.MRVIEW_CACHE_DIR, projectId)).length, 0);
}));
test('Docker exposes only selected files and rejects writes to the data bindings', {skip: !process.env.MRVIEW_DOCKER_SMOKE_IMAGE}, () => fixture(async f => {
    const mounts = await prepare(f.config, f.options);
    const command = 'set -eu; test "$(find /scene -type f | wc -l)" -eq 2; for file in /scene/*; do test "$(cat "$file")" = original; if printf changed > "$file" 2>/dev/null; then exit 41; fi; done; test ! -e /input; test ! -e /input-instance; printf writable > /tmp/control';
    const result = require('child_process').spawnSync('docker', ['run', '--rm', '--pull=never', '--network=none', ...mounts, '--entrypoint', '/bin/sh', process.env.MRVIEW_DOCKER_SMOKE_IMAGE, '-c', command], {encoding:'utf8', timeout:60000});
    assert.equal(result.status, 0, result.stderr || String(result.error));
    for (const layer of f.manifest.layers) assert.equal(fs.readFileSync(path.join(f.sourceRoot, projectId, layer.datasetId, layer.path), 'utf8'), 'original');
}));

test('copy sources are materialized into the destination-project cache even with an available source mount', () => fixture(async f => {
    const layer=f.manifest.layers[1]; const originalProject='d'.repeat(24), originalDataset='e'.repeat(24);
    layer.sourceProjectId=originalProject; layer.sourceDatasetId=originalDataset; layer.accessMode='copy-download';
    layer.key=`archive/${originalProject}/${originalDataset}/track.tck`;
    const source=path.join(f.sourceRoot,originalProject,originalDataset,'track.tck');
    fs.mkdirSync(path.dirname(source),{recursive:true}); fs.writeFileSync(source,'original'); layer.modified=fs.statSync(source).mtime.toISOString(); f.publish();
    const args=await prepare(f.config,f.options);
    assert.equal(f.downloads(),1);
    assert(args.every(arg=>!arg.includes(`source=${f.sourceRoot}/${originalProject}`)));
    assert(fs.existsSync(path.join(f.options.env.MRVIEW_CACHE_DIR,projectId,prepare.cacheIdentity(layer))));
    assert(!fs.existsSync(path.join(f.options.env.MRVIEW_CACHE_DIR,originalProject)));
    assert(args.some(arg=>arg.includes('source=') && arg.includes('/mrview-combo/source-')));
    layer.accessMode='mount-or-download'; f.publish();
    await assert.rejects(prepare(f.config,f.options),/Direct source escapes/);
}));

test('resolution uses only the trusted HTTPS endpoint, carries no JWT and refuses redirects', async () => {
    const {EventEmitter} = require('events'); const {PassThrough} = require('stream');
    const token = '1'.repeat(64); let calls = 0;
    const config = {mrview_token: token, project_id: projectId,
        warehouse_api: 'https://attacker.example/', mrview_manifest: {layers: ['untrusted']}};
    function request(url, options, callback) {
        calls++;
        assert.equal(url.href, 'https://brainlife.io/api/warehouse/dataset/mrview/session/resolve');
        assert.equal(options.headers.Authorization, 'Bearer ' + token);
        assert(!url.href.includes(token));
        const req = new EventEmitter(); req.end = body => {
            assert.deepEqual(JSON.parse(body), {taskId: 'f'.repeat(24), projectId});
            const response = new PassThrough(); response.statusCode = 302;
            response.headers = {location: 'https://attacker.example/'};
            callback(response); response.end();
        }; return req;
    }
    await assert.rejects(prepare.resolveSession(config, {TASK_ID: 'f'.repeat(24)}, request), /Unable to authorize/);
    assert.equal(calls, 1);
    await assert.rejects(prepare.resolveSession(config, {TASK_ID: 'f'.repeat(24), MRVIEW_WAREHOUSE_API: 'http://unsafe/'}, request), /HTTPS/);
});
test('Warehouse denial prevents all mount and cache access', () => fixture(async f => {
    f.options.resolveSession = async () => {throw new Error('Storage access denied');};
    await assert.rejects(prepare(f.config, f.options), /Storage access denied/);
    assert(!fs.existsSync(f.options.env.MRVIEW_CACHE_DIR));
    assert(!fs.existsSync(path.join(f.task, 'mrview-combo')));
}));
test('AWS environment token resolves without putting it in S3 config', async () => {
    const {EventEmitter} = require('events'); const {PassThrough} = require('stream');
    const env = {AMARETTI_TASK_ID: 'f'.repeat(24), MRVIEW_SESSION_TOKEN: '1'.repeat(64)};
    const responseData = {version: 3, projectId};
    const request = (url, options, callback) => {
        assert.equal(options.headers.Authorization, 'Bearer ' + env.MRVIEW_SESSION_TOKEN);
        const req = new EventEmitter(); req.end = body => {
            assert.equal(JSON.parse(body).taskId, env.AMARETTI_TASK_ID);
            const response = new PassThrough(); response.statusCode = 200;
            callback(response); response.end(JSON.stringify(responseData));
        }; return req;
    };
    assert.deepEqual(await prepare.resolveSession({project_id:projectId}, env, request), responseData);
});

test('a public FUSE mount with readable metadata but denied object bytes falls back to authorized download', () => fixture(async f => {
    const originalRead = fs.readSync;
    fs.readSync = () => {throw Object.assign(new Error('FUSE GetObject denied'), {code: 'EIO'});};
    try {
        assert.equal(prepare.mountedFile(f.manifest.layers[0], JSON.parse(f.options.env.MRVIEW_S3_MOUNTS)), null);
    } finally {fs.readSync = originalRead;}
}));

test('loads every selected tensor map at usable opacity but initially shows at most the first', () => fixture(async f => {
    for (const name of ['fa', 'md']) {
        const layer = {...f.manifest.layers[0], role:'overlay', path:name + '.nii.gz', label:name};
        layer.key = `archive/${projectId}/${layer.datasetId}/${layer.path}`;
        f.manifest.layers.push(layer);
    }
    f.manifest.totalBytes = 32; f.publish();
    await prepare(f.config, f.options);
    const script = () => fs.readFileSync(path.join(f.task, 'mrview-combo/xstartup'), 'utf8');
    assert.equal((script().match(/'-overlay.load'/g) || []).length, 2);
    assert.equal((script().match(/'-overlay.opacity' '0.5'/g) || []).length, 2);
    assert.deepEqual([...script().matchAll(/'-overlay.visible' '([01])'/g)].map(match => match[1]), ['1','0']);
    f.manifest.showTensorOnStart = false; f.publish();
    await prepare(f.config, f.options);
    assert.deepEqual([...script().matchAll(/'-overlay.visible' '([01])'/g)].map(match => match[1]), ['0','0']);
    assert.equal((script().match(/'-overlay.load'/g) || []).length, 2);
}));
test('T1w and tracks alone launch without any tensor overlay command', () => fixture(async f => {
    await prepare(f.config, f.options);
    const script = fs.readFileSync(path.join(f.task, 'mrview-combo/xstartup'), 'utf8');
    assert(!script.includes('-overlay.')); assert(script.includes('-tractography.load'));
}));

test('disk capacity uses native statfs when available', () => {
    const value = { bavail: 123, bsize: 4096 };
    assert.equal(prepare.diskStat('/tmp', directory => {
        assert.equal(directory, '/tmp'); return value;
    }, () => { throw new Error('df must not run'); }), value);
});
test('older workers use df without shell expansion, including paths with spaces', () => {
    const directory = '/tmp/scene with spaces;$(command)';
    const result = prepare.diskStat(directory, null, (command, args, options) => {
        assert.equal(command, 'df'); assert.deepEqual(args, ['-Pk', directory]);
        assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.timeout, 10000);
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 600 400 60% /mount with spaces\n';
    });
    assert.equal(result.bavail * result.bsize, 409600);
});
test('unreadable or malformed fallback capacity fails closed', () => {
    for (const output of ['garbage', 'Filesystem\n/dev/disk 100 50 -1 50% /',
        'Filesystem\n/dev/disk 100 50 999999999999999999999 50% /']) {
        assert.throws(() => prepare.diskStat('/tmp', null, () => output), /Unable to check temporary storage/);
    }
    assert.throws(() => prepare.diskStat('/tmp', null, () => { throw new Error('df failed'); }),
        /Unable to check temporary storage/);
});
test('disk fallback reads real filesystem capacity', () => {
    const result = prepare.diskStat(os.tmpdir(), null);
    assert(result.bavail >= 0); assert.equal(result.bsize, 1024);
});
test('preparation works without fs.statfsSync on older workers', () => fixture(async f => {
    const original = fs.statfsSync;
    try {
        fs.statfsSync = undefined;
        delete f.options.diskStat;
        await prepare(f.config, f.options);
        const report = JSON.parse(fs.readFileSync(path.join(f.task, 'mrview-preflight.json')));
        assert.equal(report.state, 'ready'); assert(report.diskAvailableBytes >= 0);
        assert(report.scratchAvailableBytes >= 0);
    } finally { fs.statfsSync = original; }
}));

test('display aliases fit MrView path truncation and show map names and tract annotations', () => {
    const paths = prepare.displayPaths([
        {role:'base', path:'t1.nii.gz', label:'neuro/anat/t1w · t1.nii.gz'},
        ...['fa', 'ad', 'md', 'rd'].map(map => ({role:'overlay', path:map+'.nii.gz', label:'neuro/tensor · '+map+'.nii.gz'})),
        {role:'tract', path:'track.tck', label:'AF_L · track.tck'},
        {role:'tract', path:'track.tck', label:'AF_R · track.tck'},
    ]);
    assert.deepEqual(paths, ['/scene/T1w.nii.gz', '/scene/FA.nii.gz', '/scene/AD.nii.gz', '/scene/MD.nii.gz', '/scene/RD.nii.gz', '/scene/AF_L.tck', '/scene/AF_R.tck']);
});
test('duplicate and long labels stay unique, short and safe', () => {
    const layers = Array.from({length: 100}, () => ({role:'overlay', path:'fa.nii.gz', label:'a very long annotation / with unsafe characters , ; · fa.nii.gz'}));
    const paths = prepare.displayPaths(layers);
    assert.equal(new Set(paths).size, 100);
    assert(paths.every(p => p.length <= 35 && /^\/scene\/FA--[a-zA-Z0-9_-]+\.nii\.gz$/.test(p)));
    assert.equal(prepare.displayPaths([{role:'tract', path:'track.tck', label:'AF_L · track.tck'}, {role:'tract', path:'track.tck', label:'AF_L · track.tck'}])[1], '/scene/AF_L--2.tck');
});
test('launch uses readable bind aliases without changing source files', () => fixture(async f => {
    f.manifest.layers[1].label = 'AF_L · track.tck'; f.publish();
    const binds = await prepare(f.config, f.options);
    assert(binds.some(value => value.includes('target=/scene/AF_L.tck,readonly')));
    const startup = fs.readFileSync(path.join(f.task, 'mrview-combo/xstartup'), 'utf8');
    assert(startup.includes("'-tractography.load' '/scene/AF_L.tck'"));
    const stored = JSON.parse(fs.readFileSync(path.join(f.task, 'mrview-combo/manifest.json')));
    assert.equal(stored.layers[1].datasetId, tractId);
    assert.equal(stored.layers[1].path, 'track.tck');
    assert.equal(fs.readFileSync(path.join(f.sourceRoot, projectId, tractId, 'track.tck'), 'utf8'), 'original');
}));

test('ITK-SNAP starts one process with base, additional images and multiple segmentations', () => fixture(async f => {
    f.config.type = 'itksnap-combo'; f.manifest.audience = 'brainlife-itksnap';
    f.manifest.layers[1].path = 'mask.nii.gz'; f.manifest.layers[1].role = 'segmentation';
    f.manifest.layers[1].key = `archive/${projectId}/${tractId}/mask.nii.gz`;
    for (const [name, role] of [['fa.nii.gz', 'overlay'], ['parc.nii.gz', 'segmentation']]) {
        f.manifest.layers.push({...f.manifest.layers[1], path: name, key: `archive/${projectId}/${tractId}/${name}`, role});
    }
    f.manifest.totalBytes = 32; f.publish();
    const binds = await prepare(f.config, f.options);
    assert.equal(binds.length, 10);
    assert(binds.filter((_, i) => i % 2).every(bind => bind.endsWith(',readonly')));
    const startup = fs.readFileSync(path.join(f.task, 'mrview-combo/xstartup'), 'utf8');
    assert.equal((startup.match(/exec itksnap/g) || []).length, 1);
    assert.match(startup, /'-g' .* '-o' .* '-s' /);
    assert(!startup.includes('-overlay') && !startup.includes('-fullscreen'));
    assert(!startup.includes(f.config.mrview_token));
    f.config.type = 'mrview-combo';
    await assert.rejects(prepare(f.config, f.options), /mismatched/);
}));


test('segmentation display names describe the mask or parcellation instead of anatomy', () => {
    const targets = prepare.displayPaths([
        {role: 'base', path: 't1.nii.gz', label: 'T1w'},
        {role: 'segmentation', path: 'mask.nii.gz', label: 'Brain mask'},
        {role: 'segmentation', path: 'parc.nii.gz', label: 'Cortical parcels'},
    ]);
    assert.match(targets[1], /Brain.mask/);
    assert.match(targets[2], /Cortical.parcels/);
    assert(!targets[1].includes('T1w'));
});
