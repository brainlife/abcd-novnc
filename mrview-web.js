'use strict';
const fs = require('fs');
const path = require('path');
// Serve only static viewer code, never the task directory or session data.
module.exports = function prepareWeb(taskDir, noVncRoot = '/usr/local/noVNC') {
    const root = path.join(taskDir, 'mrview-web');
    fs.mkdirSync(root, { recursive: true });
    for (const name of ['core', 'vendor']) {
        const source = path.join(noVncRoot, name);
        if (!fs.existsSync(source)) {
            if (name === 'core') throw new Error('The worker is missing noVNC client files.');
            continue;
        }
        const target = path.join(root, name);
        if (!fs.existsSync(target)) fs.symlinkSync(source, target, 'dir');
    }
    for (const name of ['mrview.html', 'mrview-gestures.js'])
        fs.copyFileSync(path.join(__dirname, name), path.join(root, name));
    // novnc_proxy checks for this entry point before starting its web server.
    fs.copyFileSync(path.join(__dirname, 'mrview.html'), path.join(root, 'vnc.html'));
    return root;
};
