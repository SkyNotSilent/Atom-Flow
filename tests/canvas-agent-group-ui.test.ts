import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const component = readFileSync(path.join(process.cwd(), 'src/components/write-canvas/CanvasAgentGroupPanel.tsx'), 'utf8');

assert.match(component, /export const CanvasAgentGroupPanel/, 'panel must export the integration component');
assert.match(component, /projects\/\$\{projectId\}\/agent-groups/, 'panel must load and create project groups');
assert.match(component, /agent-groups\/\$\{selectedGroup\.id\}\/batches\/stream/, 'panel must run the selected group');
assert.match(component, /member_start/);
assert.match(component, /member_final/);
assert.match(component, /member_error/);
assert.match(component, /type === 'final'/);
assert.match(component, /outputNodeIds/);
assert.match(component, /members\.length >= 3/, 'UI must enforce the three-member cap');
assert.match(component, /md:w-\[420px\]/, 'desktop sheet must remain compact');
assert.doesNotMatch(component, /\/api\/write\/canvas\/projects\/\$\{projectId\}\/nodes/, 'the panel must not create canvas nodes');

console.log('PASS: canvas Agent group panel contracts');
