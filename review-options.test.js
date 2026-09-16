const assert = require('assert');
const reviewOptions = require('./review-options');
assert.deepStrictEqual(reviewOptions({type: 'fsleyes'}), []);
assert.deepStrictEqual(reviewOptions({type: 'fsleyes', review_scene: {version: 1, mode: 'outline'}}), []);
const scene = {version: 1, mode: 'outline', reference: {path: 'data/DMRI.nii.gz'}};
const options = reviewOptions({type: 'fsleyes-review', review_scene: scene});
assert.strictEqual(options[0], '-e');
assert.deepStrictEqual(JSON.parse(Buffer.from(options[1].slice('FSL_REVIEW_SCENE='.length), 'base64').toString('utf8')), scene);
assert.throws(() => reviewOptions({type: 'fsleyes-review'}), /Invalid/);
assert.throws(() => reviewOptions({type: 'fsleyes-review', review_scene: {version: 1, mode: 'outline', extra: 'x'.repeat(20000)}}), /too large/);
console.log('Review options tests passed; ordinary FSLeyes receives no extra arguments.');

const ordinary = {type: 'fsleyes', input_self: true, input_task_id: 'original'};
assert.strictEqual(reviewOptions.resolveInput(ordinary, '/scratch/instance/task'), ordinary);
const remote = reviewOptions.resolveInput({type: 'fsleyes-review', input_self: true}, '/scratch/instance/task');
assert.strictEqual(remote.input_instance_id, 'instance');
assert.strictEqual(remote.input_task_id, 'task');
assert.strictEqual(remote.subdir, null);
