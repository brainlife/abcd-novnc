const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('./mrview-gestures');
const prepareWeb = require('./mrview-web');
function fixture() {
    const handlers = new Map(), events = new Map(), keys = [];
    const screen = { addEventListener: (name, fn, opts) => {
        assert.equal(opts.capture, true); assert.equal(opts.passive, false); handlers.set(name, fn);
    }, removeEventListener: name => handlers.delete(name) };
    const rfb = { sendKey: (...args) => keys.push(args), addEventListener: (name, fn) => events.set(name, fn),
        removeEventListener: name => events.delete(name) };
    let time = 1000;
    const gestures = install(screen, rfb, { now: () => time });
    return { handlers, events, keys, gestures, tick: ms => time += ms,
        send(name, props) {
            let cancelled = false;
            handlers.get(name)({ preventDefault() { cancelled = true; }, stopImmediatePropagation() {}, ...props });
            return cancelled;
        } };
}
test('pinches zoom in and out through native shortcuts; ordinary scrolling stays untouched', () => {
    const f = fixture(); f.events.get('connect')();
    assert.equal(f.send('wheel', { ctrlKey: false, deltaY: 100 }), false);
    assert.deepEqual(f.keys, []);
    assert.equal(f.send('wheel', { ctrlKey: true, deltaY: -6 }), true);
    assert.deepEqual(f.keys, []);
    f.send('wheel', { ctrlKey: true, deltaY: -6 });
    assert.deepEqual(f.keys, [[0xffe3, 'ControlLeft', true], [0x2b, 'Equal'], [0xffe3, 'ControlLeft', false]]);
    f.send('wheel', { ctrlKey: true, deltaY: 12 });
    assert.deepEqual(f.keys.slice(-3), [[0xffe3, 'ControlLeft', true], [0x2d, 'Minus'], [0xffe3, 'ControlLeft', false]]);
});
test('Safari gestures do not double-zoom via simultaneous wheel events', () => {
    const f = fixture(); f.events.get('connect')();
    f.send('gesturestart', { scale: 1 });
    f.send('gesturechange', { scale: 1.1 });
    const count = f.keys.length; assert(count > 0);
    f.send('wheel', { ctrlKey: true, deltaY: -30 }); assert.equal(f.keys.length, count);
    f.send('gestureend', {});
    f.send('wheel', { ctrlKey: true, deltaY: 12 }); assert.equal(f.keys.length, count + 3);
});
test('disconnect and disposal stop inputs and remove gesture listeners', () => {
    const f = fixture(); f.gestures.zoom(1); assert.equal(f.keys.length, 0);
    f.events.get('connect')(); f.gestures.zoom(1); assert.equal(f.keys.length, 3);
    f.events.get('disconnect')(); f.gestures.zoom(-1); assert.equal(f.keys.length, 3);
    f.gestures.dispose(); assert.equal(f.handlers.size, 0); assert.equal(f.events.size, 0);
});
test('web root serves only client assets, not task config, tokens or data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrview-web-'));
    try {
        const task = path.join(root, 'task'), novnc = path.join(root, 'novnc');
        fs.mkdirSync(task); fs.mkdirSync(path.join(novnc, 'core'), { recursive: true });
        fs.mkdirSync(path.join(novnc, 'vendor'));
        fs.writeFileSync(path.join(task, 'config.json'), 'private');
        fs.writeFileSync(path.join(novnc, 'private.txt'), 'private');
        const web = prepareWeb(task, novnc);
        assert.deepEqual(fs.readdirSync(web).sort(), ['core', 'mrview-gestures.js', 'mrview.html', 'vendor', 'vnc.html']);
        assert.equal(fs.realpathSync(path.join(web, 'core')), fs.realpathSync(path.join(novnc, 'core')));
        assert.equal(fs.readFileSync(path.join(web, 'vnc.html'), 'utf8'), fs.readFileSync(path.join(web, 'mrview.html'), 'utf8'));
        assert.equal(prepareWeb(task, novnc), web);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
