const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const {once} = require('events');
test('stop is safe before Docker exists and kills preparation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-stop-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    const exited = once(child, 'exit');
    try {
        fs.writeFileSync(path.join(dir, 'setup.pid'), String(child.pid));
        const stopped = spawnSync('bash', [path.join(__dirname, 'stop.sh')], {cwd:dir, encoding:'utf8'});
        assert.equal(stopped.status, 0, stopped.stderr);
        const timeout = setTimeout(()=>child.kill('SIGKILL'), 3000);
        const [, signal] = await exited; clearTimeout(timeout);
        assert.equal(signal, 'SIGTERM'); assert(!fs.existsSync(path.join(dir,'setup.pid')));
        assert.equal(spawnSync('bash', [path.join(__dirname,'stop.sh')], {cwd:dir}).status, 0);
    } finally { child.kill(); fs.rmSync(dir,{recursive:true,force:true}); }
});
test('status reports preparation errors before a URL exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-status-'));
    try {
        fs.writeFileSync(path.join(dir,'setup-error.txt'),'Insufficient worker disk space');
        const result = spawnSync('bash',[path.join(__dirname,'status.sh')],{cwd:dir,encoding:'utf8'});
        assert.equal(result.status,2); assert.match(result.stdout,/Insufficient worker disk/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
