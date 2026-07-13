import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getAgentGroupContextIds,
  getAgentGroupContextNodes,
  normalizeAgentGroupBatchHistory,
} from '../src/components/write-canvas/CanvasAgentGroupPanel';
import type {
  WriteCanvasAgentBatch,
  WriteCanvasAgentGroup,
  WriteCanvasAgentRun,
  WriteCanvasEdge,
  WriteCanvasNode,
} from '../src/types';

const component = readFileSync(path.join(process.cwd(), 'src/components/write-canvas/CanvasAgentGroupPanel.tsx'), 'utf8');

assert.match(component, /export const CanvasAgentGroupPanel/, 'panel must export the integration component');
assert.match(component, /projects\/\$\{projectId\}\/agent-groups/, 'panel must load and create project groups');
assert.match(component, /agent-groups\/\$\{selectedGroup\.id\}\/batches\/stream/, 'panel must run the selected group');
assert.match(component, /member_start/);
assert.match(component, /member_final/);
assert.match(component, /member_error/);
assert.match(component, /type === 'final'/);
assert.match(component, /outputNodeIds/);
assert.match(component, /payload\.group\.nodeId/, 'creation must use the backend-created canonical group node');
assert.match(component, /agent-groups\/\$\{selectedGroup\.id\}\/batches/, 'panel must restore persisted batch history');
assert.match(component, /最近运行/, 'panel must display recent persisted runs');
assert.match(component, /partial/, 'panel must distinguish partial batches');
assert.match(component, /failed/, 'panel must display failed batches and member outcomes');
assert.match(component, /members\.length >= 3/, 'UI must enforce the three-member cap');
assert.match(component, /md:w-\[420px\]/, 'desktop sheet must remain compact');
assert.doesNotMatch(component, /\/api\/write\/canvas\/projects\/\$\{projectId\}\/nodes/, 'the panel must not create canvas nodes');

const baseNode = {
  id: 1,
  projectId: 7,
  kind: 'asset_text',
  role: 'material',
  contentType: 'text',
  origin: 'manual',
  status: 'ready',
  title: '素材',
  summary: '',
  businessRef: null,
  x: 0,
  y: 0,
  width: 300,
  height: 180,
  createdAt: '',
  updatedAt: '',
} satisfies WriteCanvasNode;

const contextNodes = getAgentGroupContextNodes([
  baseNode,
  { ...baseNode, id: 2, kind: 'agent', role: 'task', contentType: 'agent' },
  { ...baseNode, id: 3, kind: 'result', role: 'task', contentType: 'agent_group' },
  { ...baseNode, id: 4, role: 'group', contentType: 'canvas_group' },
  { ...baseNode, id: 5, role: 'insight', status: 'rejected' },
  { ...baseNode, id: 6, role: 'document', contentType: 'longform' },
]);
assert.deepEqual(contextNodes.map(node => node.id), [1, 6], 'only material, insight, and document nodes can become group context');

const group = {
  id: 11,
  projectId: 7,
  nodeId: 90,
  name: '对比组',
  sharedPrompt: '',
  status: 'ready',
  configSnapshot: {},
  members: [],
  createdAt: '',
  updatedAt: '',
} satisfies WriteCanvasAgentGroup;
const edge = (id: number, sourceNodeId: number, targetNodeId: number, relation: WriteCanvasEdge['relation']): WriteCanvasEdge => ({
  id,
  projectId: 7,
  sourceNodeId,
  targetNodeId,
  relation,
  createdAt: '',
});
assert.deepEqual(
  getAgentGroupContextIds([
    edge(1, 1, 90, 'context'),
    edge(2, 6, 90, 'context'),
    edge(3, 2, 90, 'context'),
    edge(4, 1, 91, 'context'),
    edge(5, 1, 90, 'generated'),
  ], group, contextNodes),
  [1, 6],
  'only canonical context edges targeting the selected group node are restored',
);

const batch = {
  id: 31,
  projectId: 7,
  groupId: 11,
  message: '生成三个标题',
  contextNodeIds: [1, 6],
  status: 'partial',
  contextSnapshot: {},
  configSnapshot: {},
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:01.000Z',
} satisfies WriteCanvasAgentBatch;
const run = {
  id: 41,
  projectId: 7,
  groupId: 11,
  groupMemberId: 21,
  batchId: 31,
  action: 'group_batch',
  status: 'failed',
  contextSnapshot: {},
  configSnapshot: {},
  error: '模型超时',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:01.000Z',
} satisfies WriteCanvasAgentRun;
assert.deepEqual(
  normalizeAgentGroupBatchHistory({ batches: [batch], runs: [run] })[0]?.runs.map(item => item.id),
  [41],
  'member outcomes returned beside batches must be associated with their persisted batch',
);

console.log('PASS: canvas Agent group panel contracts');
