// Only the separate review image receives a scene; ordinary viewers are unchanged.
module.exports = function reviewOptions(config) {
    if(config.type !== 'fsleyes-review') return [];
    const scene = config.review_scene;
    if(!scene || scene.version !== 1 || !['grayscale', 'outline'].includes(scene.mode)) {
        throw new Error('Invalid FSLeyes review scene');
    }
    const encoded = Buffer.from(JSON.stringify(scene), 'utf8').toString('base64');
    if(encoded.length > 16384) throw new Error('FSLeyes review scene is too large');
    return ['-e', 'FSL_REVIEW_SCENE=' + encoded];
};

// Remote competition images are downloaded by the dedicated viewer itself. Its
// own task directory supplies the existing noVNC mount contract, with no data task.
module.exports.resolveInput = function resolveInput(config, cwd) {
    if(!['fsleyes-review', 'mrview-combo'].includes(config.type) || config.input_self !== true) return config;
    const path = require('path');
    return Object.assign({}, config, {
        input_instance_id: path.basename(path.dirname(cwd)),
        input_task_id: path.basename(cwd),
        subdir: null,
    });
};
