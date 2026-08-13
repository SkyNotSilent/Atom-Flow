import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getAgentGroupContextIds,
  getAgentGroupContextNodes,
  isTerminalAgentGroupBatchStatus,
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
assert.match(component, /onProjectRefresh/, 'panel must ask the parent to reload canonical project nodes and edges');
assert.match(component, /reconcilePersistedRun[\s\S]{0,1600}loadBatchHistory[\s\S]{0,1200}onProjectRefresh/, 'terminal reconciliation must reload history and project state together');
assert.match(component, /finally \{[\s\S]{0,520}reconcilePersistedRun/, 'success, partial, failure, and abort paths must share terminal reconciliation');
assert.match(component, /AGENT_GROUP_RECONCILE_WARNING_ATTEMPTS\s*=\s*\d+/, 'long reconciliation must expose a delayed-state warning');
assert.match(component, /AGENT_GROUP_RECONCILE_SLOW_DELAY_MS\s*=\s*\d+/, 'long reconciliation must reduce its polling rate');
assert.match(component, /attempt >= AGENT_GROUP_RECONCILE_WARNING_ATTEMPTS[\s\S]{0,160}AGENT_GROUP_RECONCILE_SLOW_DELAY_MS/, 'post-warning reconciliation must use the slower polling interval');
assert.match(component, /while \(isCurrentRun\(\)\)/, 'abort and error reconciliation must keep polling until durable terminal state');
assert.match(component, /observedBatchId/, 'reconciliation must follow the batch observed in the stream');
assert.match(component, /let requestAccepted = false/, 'the panel must distinguish a rejected launch from a persisted batch');
assert.match(component, /requestAccepted = true[\s\S]{0,400}response\.body/, 'an accepted response must be reconciled even when its stream body is unavailable');
assert.match(component, /if \(requestAccepted\)[\s\S]{0,240}reconcilePersistedRun/, 'pre-batch HTTP failures must release the run lock instead of polling forever');
assert.match(component, /finalStatus === 'completed'[\s\S]{0,180}onResults/, 'only a fully completed batch should auto-select generated results');
assert.match(component, /activeRunTokenRef/, 'each batch run must own an identity token');
const persistedBatchRecovery = component.match(/const restorePersistedBatch[\s\S]*?void restorePersistedBatch\(\)/)?.[0] || '';
assert.match(persistedBatchRecovery, /latestBatch/, 'reopening must inspect the latest persisted batch');
assert.match(persistedBatchRecovery, /!latestBatch \|\| isTerminalAgentGroupBatchStatus/, 'terminal history must not recreate a run lock');
assert.match(persistedBatchRecovery, /setIsRunning\(true\)/, 'a non-terminal persisted batch must restore the run lock');
assert.match(persistedBatchRecovery, /await reconcilePersistedRun/, 'a non-terminal persisted batch must resume terminal reconciliation');
const selectedGroupRecoveryEffect = component.match(/useEffect\(\(\) => \{[\s\S]*?const restorePersistedBatch[\s\S]*?\}, \[loadBatchHistory, reconcilePersistedRun, selectedGroup\]\);/)?.[0] || '';
assert.match(selectedGroupRecoveryEffect, /return;\s*}\s*setIsRunning\(false\);\s*setRunStates/, 'switching groups must clear the prior run lock before restoring history');
assert.match(component, /run\.status === 'queued'[\s\S]{0,100}status: 'running'/, 'queued persisted members must render as active work');
assert.match(
  component,
  /await reconcilePersistedRun[\s\S]{0,600}await onResults[\s\S]{0,800}setIsRunning\(false\)/,
  'the run lock must remain held through persisted reconciliation and result delivery',
);
assert.doesNotMatch(
  component,
  /finally \{[\s\S]{0,180}setIsRunning\(false\)[\s\S]{0,300}await reconcilePersistedRun/,
  'a batch must not unlock before terminal reconciliation',
);
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

assert.equal(isTerminalAgentGroupBatchStatus('completed'), true);
assert.equal(isTerminalAgentGroupBatchStatus('partial'), true);
assert.equal(isTerminalAgentGroupBatchStatus('failed'), true);
assert.equal(isTerminalAgentGroupBatchStatus('cancelled'), true);
assert.equal(isTerminalAgentGroupBatchStatus('running'), false);
assert.equal(isTerminalAgentGroupBatchStatus('queued'), false);

console.log('PASS: canvas Agent group panel contracts');
