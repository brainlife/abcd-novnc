'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { execFileSync } = require('child_process');

// Older worker Node versions do not expose fs.statfsSync.
function diskStat(directory, statfs = fs.statfsSync, run = execFileSync) {
    if (typeof statfs === 'function') return statfs(directory);
    try {
        const output = run('df', ['-Pk', path.resolve(directory)], {
            encoding: 'utf8', timeout: 10000, env: { ...process.env, LC_ALL: 'C' },
        });
        const rows = output.trim().split(/\r?\n/);
        const match = rows.length === 2 && rows[1].match(/^.+?\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+.+$/);
        const available = match && Number(match[1]);
        if (!match || !Number.isSafeInteger(available) || available < 0 ||
            !Number.isSafeInteger(available * 1024)) throw new Error('Invalid disk capacity');
        return { bavail: available, bsize: 1024 };
    } catch (_) {
        throw new Error('Unable to check temporary storage space. Please try again or contact support.');
    }
}

function relative(value) {
    if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value) ||
        value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid MrView path');
    return value;
}
function inside(root, file) { return file.startsWith(root + path.sep); }
function slug(value) { return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'layer'; }
// MrView 3.0 shortens full paths to their final 35 characters. Keep the
// entire display path within that budget; retain provenance in manifest.json.
function displayPaths(layers) {
    const used = new Set();
    return layers.map(layer => {
        const filename = path.posix.basename(layer.path);
        const extension = filename.match(/\.(tck|nii|mif)(\.gz)?$/i)[0];
        const stem = filename.slice(0, -extension.length);
        const suffix = ' · ' + filename;
        let label = String(layer.label || '');
        if (label.endsWith(suffix)) label = label.slice(0, -suffix.length);
        if (/^(neuro\/)?(tensor|anat\/t1w|track\/tck)$/.test(label)) label = '';
        let name;
        if (layer.role === 'overlay') {
            const map = stem.match(/(?:^|[_-])(fa|ad|md|rd|adc|cl|cp|cs)(?:[_-]|$)/i);
            name = map ? map[1].toUpperCase() : stem;
            if (label && label.toLowerCase() !== name.toLowerCase()) name += '--' + label;
        } else if (layer.role === 'tract') name = label || (stem === 'track' ? 'Tract' : stem);
        else if (layer.role === 'segmentation') name = label || stem || 'Segmentation';
        else name = /^(neuro\/)?anat\/t1w$/.test(String(layer.label || '')) || /^t1/i.test(stem) ? 'T1w' : label || stem || 'Base';
        name = slug(name).replace(/^-+|-+$/g, '') || 'Layer';
        const budget = 35 - '/scene/'.length - extension.length;
        let count = 1, target;
        do {
            const disambiguator = count === 1 ? '' : '--' + count;
            target = '/scene/' + name.slice(0, budget - disambiguator.length) + disambiguator + extension;
            count++;
        } while (used.has(target.toLowerCase()));
        used.add(target.toLowerCase());
        return target;
    });
}
function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
// This address is trusted service configuration, never taken from task config.
const DEFAULT_WAREHOUSE_API = 'https://brainlife.io/api/warehouse/';
function resolveSession(config, env, request = https.request) {
    const token = config.mrview_token || env.MRVIEW_SESSION_TOKEN;
    const taskId = env.TASK_ID || env.AMARETTI_TASK_ID;
    if (!/^[a-f0-9]{64}$/.test(token || '') || !/^[a-f0-9]{24}$/i.test(taskId || ''))
        return Promise.reject(new Error('Missing or invalid MrView session token or task ID'));
    const api = new URL(env.MRVIEW_WAREHOUSE_API || DEFAULT_WAREHOUSE_API);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash)
        return Promise.reject(new Error('MrView requires a trusted HTTPS Warehouse address'));
    const url = new URL('dataset/mrview/session/resolve', api.href.replace(/\/?$/, '/'));
    const body = JSON.stringify({taskId, projectId: config.project_id});
    return new Promise((resolve, reject) => {
        const req = request(url, {method: 'POST', timeout: 30000, headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        }}, res => {
            // No redirects: the token is sent only to the trusted Warehouse endpoint.
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(res.statusCode === 403
                    ? 'MrView access was denied or the session expired. Open a new session and try again.'
                    : 'Unable to authorize MrView files. Please try again.'));
            }
            let bytes = 0; const chunks = [];
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > 4 * 1024 * 1024) res.destroy(new Error('MrView file list is too large'));
                else chunks.push(chunk);
            });
            res.on('error', () => reject(new Error('Could not receive the MrView file list')));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (_) { reject(new Error('Invalid MrView file list from Warehouse')); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('MrView authorization timed out')));
        // Never expose the request object or token through error details.
        req.on('error', () => reject(new Error('Could not contact Warehouse to authorize MrView files')));
        req.end(body);
    });
}
function validateManifest(config, manifest, now = Date.now()) {
    const isItk = config.type === 'itksnap-combo';
    if (!manifest || typeof manifest !== 'object') throw new Error('Invalid MrView file list');
    if (manifest.showTensorOnStart !== undefined && typeof manifest.showTensorOnStart !== 'boolean')
        throw new Error('Invalid initial tensor visibility');
    if (manifest.version !== 3 || manifest.audience !== (isItk ? 'brainlife-itksnap' : 'brainlife-mrview') || manifest.projectId !== config.project_id ||
        !/^[a-f0-9]{24}$/i.test(manifest.projectId) || !manifest.subject ||
        !Number.isFinite(manifest.issuedAt) || !Number.isFinite(manifest.expiresAt) || manifest.expiresAt * 1000 <= now ||
        manifest.issuedAt * 1000 > now + 60000 || manifest.expiresAt - manifest.issuedAt > 4 * 3600)
        throw new Error('Expired or mismatched MrView project manifest');
    if (!Array.isArray(manifest.layers) || manifest.layers.length < 2 || manifest.layers.length > 1000 || manifest.layers.some(layer => !layer || typeof layer !== 'object') ||
        manifest.layers.filter(layer => layer.role === 'base').length !== 1) throw new Error('Invalid MrView scene');
    const seen = new Set();
    for (const layer of manifest.layers) {
        if (layer.projectId !== manifest.projectId || !/^[a-f0-9]{24}$/i.test(layer.datasetId) ||
            !(isItk ? ['base', 'overlay', 'segmentation'] : ['base', 'overlay', 'tract']).includes(layer.role) || !['s3fs', 's3fs-embargo'].includes(layer.storage) ||
            !Number.isSafeInteger(layer.size) || layer.size <= 0 || typeof layer.etag !== 'string') throw new Error('Invalid project file');
        relative(layer.path);
        const mode = layer.accessMode || 'mount-or-download';
        if (!['mount-or-download', 'copy-download'].includes(mode)) throw new Error('Invalid source access mode');
        const sourceProjectId = layer.sourceProjectId || manifest.projectId;
        const sourceDatasetId = layer.sourceDatasetId || layer.datasetId;
        if (!/^[a-f0-9]{24}$/i.test(sourceProjectId) || !/^[a-f0-9]{24}$/i.test(sourceDatasetId)) throw new Error('Invalid source provenance');
        if (mode !== 'copy-download' && (sourceProjectId !== manifest.projectId || sourceDatasetId !== layer.datasetId)) throw new Error('Direct source escapes selected project');
        const suffix = `${sourceProjectId}/${sourceDatasetId}/${layer.path}`;
        if (![suffix, `archive/${suffix}`].includes(layer.key)) throw new Error('File escapes selected project');
        if (isItk && !/\.nii(\.gz)?$/i.test(layer.path)) throw new Error('ITK-SNAP requires NIfTI image files');
        if (!(layer.role === 'tract' ? /\.tck$/i : /\.(nii|mif)(\.gz)?$/i).test(layer.path)) throw new Error('Invalid file format');
        const url = new URL(layer.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid download URL');
        const identity = `${layer.bucket}/${layer.key}`;
        if (seen.has(identity)) throw new Error('Duplicate file');
        seen.add(identity);
    }
    if (manifest.totalBytes !== manifest.layers.reduce((sum, layer) => sum + layer.size, 0)) throw new Error('Invalid total file size');
    return manifest;
}
function memoryAvailable() {
    let bytes = os.freemem();
    try {
        const available = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
        if (available) bytes = Number(available[1]) * 1024;
    } catch (_) { /* Non-Linux test host. */ }
    for (const [limitPath, usedPath] of [
        ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
        ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
    ]) {
        try {
            const limit = Number(fs.readFileSync(limitPath, 'utf8'));
            const used = Number(fs.readFileSync(usedPath, 'utf8'));
            if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) bytes = Math.min(bytes, Math.max(0, limit - used));
        } catch (_) { /* No cgroup memory limit. */ }
    }
    return bytes;
}
function mkdirPrivate(directory) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077))
        throw new Error('MrView cache must be a private directory owned by the worker');
}
function mountedFile(layer, mounts) {
    for (const mount of mounts) {
        if (mount.bucket !== layer.bucket || typeof mount.prefix !== 'string' || !layer.key.startsWith(mount.prefix) ||
            (mount.prefix && !mount.prefix.endsWith('/'))) continue;
        const rest = relative(layer.key.slice(mount.prefix.length));
        let root, file;
        try {
            root = fs.realpathSync(mount.root);
            const candidate = path.join(root, rest);
            file = fs.realpathSync(candidate);
            // No symlink within the selected project may redirect to another project or sibling file.
            if (file !== candidate || !inside(root, file)) throw new Error('S3 file redirects outside its authorized path');
            fs.accessSync(file, fs.constants.R_OK);
            const stat = fs.statSync(file);
            // A stale/mismatched mount falls back to the version/ETag-conditional object download.
            if (!stat.isFile() || stat.size !== layer.size || !layer.modified || Math.abs(stat.mtimeMs - Date.parse(layer.modified)) > 1000) continue;
            // FUSE can expose metadata/mode bits even when anonymous GetObject is
            // denied by an embargo tag. Probe an actual read before choosing a bind.
            const fd = fs.openSync(file, 'r');
            try { if (fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) !== 1) continue; }
            finally { fs.closeSync(fd); }
        } catch (error) {
            if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO'].includes(error.code)) continue;
            throw error;
        }
        const host = path.join(mount.hostRoot || root, rest);
        if (!path.isAbsolute(host) || /[,\n\r]/.test(host)) continue;
        return host;
    }
    return null;
}
async function hashFile(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
function cacheIdentity(layer) {
    return crypto.createHash('sha256').update(JSON.stringify([layer.projectId, layer.datasetId, layer.bucket, layer.key, layer.versionId, layer.etag, layer.size])).digest('hex');
}
async function cachedFile(cacheRoot, layer) {
    const file = path.join(cacheRoot, cacheIdentity(layer));
    try {
        const stat = fs.lstatSync(file);
        const metaStat = fs.lstatSync(file + '.json');
        if (!stat.isFile() || stat.isSymbolicLink() || !metaStat.isFile() || metaStat.isSymbolicLink()) throw new Error('Invalid cache entry');
        const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
        if (stat.size !== layer.size || meta.identity !== cacheIdentity(layer) || meta.sha256 !== await hashFile(file)) return null;
        fs.utimesSync(file, new Date(), stat.mtime);
        return file;
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}
async function download(layer, destination) {
    const response = await new Promise((resolve, reject) => {
        const req = https.get(layer.url, { headers: layer.versionId ? {} : { 'If-Match': layer.etag }, timeout: 120000 }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`Selected file download failed (${res.statusCode})`)); }
            else resolve(res);
        });
        req.on('timeout', () => req.destroy(new Error('Selected file download timed out')));
        req.on('error', reject);
    });
    let received = 0;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({ transform(chunk, _, cb) {
        received += chunk.length;
        if (received > layer.size) return cb(new Error('Selected file exceeded its authorized size'));
        hash.update(chunk); cb(null, chunk);
    } });
    await pipeline(response, meter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (received !== layer.size) throw new Error('Selected file download was incomplete');
    return hash.digest('hex');
}
// Evict only finalized entries. An existing Linux bind mount keeps its inode alive after eviction.
function pruneCache(base, needed, maxBytes, ttlMs, keep = new Set()) {
    const entries = [];
    for (const project of fs.readdirSync(base).filter(name => /^[a-f0-9]{24}$/i.test(name))) {
        const root = path.join(base, project);
        const dirStat = fs.lstatSync(root);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Invalid project cache directory');
        for (const name of fs.readdirSync(root)) {
            if (!/^[a-f0-9]{64}(?:\.[a-f0-9]+\.part(?:\.json)?)?$/.test(name)) continue;
            const file = path.join(root, name); const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid cache file');
            if (name.includes('.part')) {
                if (Date.now() - stat.mtimeMs > ttlMs) fs.unlinkSync(file);
            } else entries.push({file, stat});
        }
    }
    entries.sort((a,b) => a.stat.atimeMs - b.stat.atimeMs);
    let bytes = entries.reduce((sum, entry) => sum + entry.stat.size, 0);
    for (const {file, stat} of entries) {
        if (keep.has(file)) continue;
        if (Date.now() - stat.atimeMs < ttlMs && bytes + needed <= maxBytes) continue;
        fs.unlinkSync(file); fs.rmSync(file + '.json', {force:true}); bytes -= stat.size;
    }
}
async function prepareCombo(config, options) {
    if (!['mrview-combo', 'itksnap-combo'].includes(config.type)) return [];
    const env = options.env || process.env;
    const manifest = validateManifest(config, await (options.resolveSession || resolveSession)(config, env));
    const directory = path.join(options.taskDir, 'mrview-combo');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let cacheBase = path.resolve(env.MRVIEW_CACHE_DIR || path.join(os.tmpdir(), `brainlife-mrview-cache-${process.getuid ? process.getuid() : 'worker'}`));
    mkdirPrivate(cacheBase);
    cacheBase = fs.realpathSync(cacheBase);
    const cacheRoot = path.join(cacheBase, manifest.projectId);
    mkdirPrivate(cacheRoot);
    const mounts = JSON.parse(env.MRVIEW_S3_MOUNTS || '[]');
    if (!Array.isArray(mounts)) throw new Error('MRVIEW_S3_MOUNTS must be a list');
    if (!mounts.length && env.BRAINLIFE_s3fs && !env.BRAINLIFE_HOSTSCRATCH)
        mounts.push({ bucket: 'brainlife', prefix: 'archive/', root: env.BRAINLIFE_s3fs });
    const plans = [];
    for (const layer of manifest.layers) {
        const mounted = layer.accessMode === 'copy-download' ? null : mountedFile(layer, mounts);
        plans.push({ layer, mounted, cached: mounted ? null : await cachedFile(cacheRoot, layer) });
    }
    const missingBytes = plans.filter(plan => !plan.mounted && !plan.cached).reduce((sum, plan) => sum + plan.layer.size, 0);
    const maxBytes = Number(env.MRVIEW_CACHE_MAX_BYTES || 50 * 1024 ** 3);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid MrView cache budget');
    const kept = new Set(plans.filter(plan => plan.cached).map(plan => plan.cached));
    const selectedCacheBytes = plans.filter(plan => !plan.mounted).reduce((sum, plan) => sum + plan.layer.size, 0);
    if (selectedCacheBytes > maxBytes) throw new Error('This selection exceeds the temporary storage limit for a session. Select fewer files and try again.');
    pruneCache(cacheBase, missingBytes, maxBytes, Number(env.MRVIEW_CACHE_TTL_MS || 24 * 3600 * 1000), kept);
    const statfs = options.diskStat || diskStat(cacheRoot);
    const diskAvailableBytes = Number(statfs.bavail) * Number(statfs.bsize);
    const scratchStatfs = options.diskStat || diskStat(options.taskDir);
    const scratchAvailableBytes = Number(scratchStatfs.bavail) * Number(scratchStatfs.bsize);
    const scratchCopyBytes = fs.statSync(cacheRoot).dev === fs.statSync(options.taskDir).dev ? 0 : selectedCacheBytes;
    const availableMemoryBytes = options.availableMemoryBytes ?? memoryAvailable();
    const warnings = [];
    if (manifest.totalBytes > availableMemoryBytes * 0.25) warnings.push('This selection may be slow to display. Try opening fewer files at once.');
    if (missingBytes > diskAvailableBytes * 0.5) warnings.push('This selection needs a lot of temporary storage. Consider opening fewer files.');
    const report = { totalBytes: manifest.totalBytes, downloadBytes: missingBytes,
        mountedBytes: plans.filter(plan => plan.mounted).reduce((sum, plan) => sum + plan.layer.size, 0),
        cachedBytes: plans.filter(plan => plan.cached).reduce((sum, plan) => sum + plan.layer.size, 0),
        availableMemoryBytes, diskAvailableBytes, scratchAvailableBytes, scratchCopyBytes, warnings, state: 'preparing' };
    const writeReport = () => { fs.writeFileSync(path.join(options.taskDir, 'mrview-preflight.json.tmp'), JSON.stringify(report));
        fs.renameSync(path.join(options.taskDir, 'mrview-preflight.json.tmp'), path.join(options.taskDir, 'mrview-preflight.json')); };
    writeReport();
    if (scratchCopyBytes > scratchAvailableBytes * 0.9) throw new Error('There isn’t enough space to open these files. Select fewer files and try again.');
    if (missingBytes > diskAvailableBytes * 0.9) throw new Error('There isn’t enough space to open these files. Select fewer files and try again.');
    const binds = [];
    const layers = [];
    const targets = displayPaths(plans.map(plan => plan.layer));
    for (const [index, plan] of plans.entries()) {
        report.completedFiles = index; writeReport();
        const layer = plan.layer;
        let source = plan.mounted;
        if (!source) {
            let local = plan.cached;
            if (!local) {
                local = path.join(cacheRoot, cacheIdentity(layer));
                const temp = local + `.${crypto.randomBytes(8).toString('hex')}.part`;
                try {
                    const digest = await (options.download || download)(layer, temp);
                    if (fs.statSync(temp).size !== layer.size) throw new Error('Downloaded file size mismatch');
                    fs.renameSync(temp, local);
                    const metaTemp = temp + '.json';
                    fs.writeFileSync(metaTemp, JSON.stringify({ identity: cacheIdentity(layer), sha256: digest }), { mode: 0o600 });
                    fs.renameSync(metaTemp, local + '.json');
                } finally { fs.rmSync(temp, { force: true }); }
            }
            // Pin cached content in task scratch so cache eviction cannot invalidate a pending Docker bind.
            const pinned = path.join(directory, `source-${cacheIdentity(layer)}`);
            fs.rmSync(pinned, {force: true});
            {
                try { fs.linkSync(local, pinned); }
                catch (error) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(local, pinned, fs.constants.COPYFILE_EXCL); }
            }
            source = path.join(options.hostTaskDir, 'mrview-combo', `source-${cacheIdentity(layer)}`);
        }
        if (!path.isAbsolute(source) || /[,\n\r]/.test(source)) throw new Error('Invalid file bind path');
        const target = targets[index];
        binds.push('--mount', `type=bind,source=${source},target=${target},readonly`);
        layers.push({ datasetId: layer.datasetId, path: layer.path, size: layer.size, role: layer.role, label: layer.label, containerPath: target });
    }
    const base = layers.find(layer => layer.role === 'base');
    const isItk = config.type === 'itksnap-combo';
    const args = [isItk ? '-g' : '-load', base.containerPath];
    if (isItk) {
        const images = layers.filter(layer => layer.role === 'overlay');
        const segments = layers.filter(layer => layer.role === 'segmentation');
        if (images.length) args.push('-o', ...images.map(layer => layer.containerPath));
        if (segments.length) args.push('-s', ...segments.map(layer => layer.containerPath));
    } else {
        let firstOverlay = true;
        for (const layer of layers.filter(layer => layer.role !== 'base')) {
            args.push(layer.role === 'tract' ? '-tractography.load' : '-overlay.load', layer.containerPath);
            if (layer.role === 'overlay') {
                args.push('-overlay.opacity', '0.5', '-overlay.visible', firstOverlay && manifest.showTensorOnStart !== false ? '1' : '0');
                firstOverlay = false;
            }
        }
        args.push('-fullscreen');
    }
    const startup = path.join(directory, 'xstartup');
    fs.writeFileSync(startup, '#!/bin/bash\nset -eu\n' + (isItk ? 'unset SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS\nXFCE_PANEL_MIGRATE_DEFAULT=true startxfce4 &\nexec itksnap ' : 'export PATH="$PATH:/mrtrix3/bin"\nvglclient &\nXFCE_PANEL_MIGRATE_DEFAULT=true startxfce4 &\nvglrun mrview ') + args.map(quote).join(' ') + '\n', { mode: 0o755 });
    // Mount only the launcher and exact files, never the task root, cache root, bucket or project.
    binds.push('--mount', `type=bind,source=${options.hostTaskDir}/mrview-combo/xstartup,target=/root/.vnc/xstartup,readonly`);
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ projectId: manifest.projectId, subject: manifest.subject, layers }, null, 2));
    report.state = 'ready'; report.completedFiles = plans.length; writeReport();
    pruneCache(cacheBase, 0, maxBytes, Number(env.MRVIEW_CACHE_TTL_MS || 24 * 3600 * 1000));
    return binds;
}
module.exports = prepareCombo;
module.exports.validateManifest = validateManifest;
module.exports.resolveSession = resolveSession;
module.exports.mountedFile = mountedFile;
module.exports.cacheIdentity = cacheIdentity;

module.exports.diskStat = diskStat;

module.exports.displayPaths = displayPaths;
