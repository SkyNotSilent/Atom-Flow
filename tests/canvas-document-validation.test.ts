import assert from 'node:assert/strict';
import {
  extractCanvasBusinessLayouts,
  hasEmbeddedCanvasMedia,
  readCanvasDocumentSchemaVersion,
  resolveCanvasDocumentSchemaVersion,
} from '../src/server/canvasDocument.js';

const snapshot = (...records: Array<Record<string, unknown>>) => ({
  store: Object.fromEntries(records.map((record, index) => [`record:${index}`, record])),
});

assert.equal(
  readCanvasDocumentSchemaVersion({ schema: { schemaVersion: 2 }, store: {} }),
  2,
  'the embedded tldraw schema version must remain authoritative on a first save',
);
assert.equal(
  resolveCanvasDocumentSchemaVersion({ schema: { schemaVersion: 2 }, store: {} }, 1),
  2,
  'a stale project default must not relabel a v2 tldraw snapshot as v1',
);
assert.equal(resolveCanvasDocumentSchemaVersion({ store: {} }, 1), 1);
assert.equal(readCanvasDocumentSchemaVersion({ schema: { schemaVersion: '2' }, store: {} }), null);

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'shape',
  type: 'text',
  props: { text: 'data: 是一种 URI scheme；blob: URL 也可以在正文中讨论。' },
})), false, 'ordinary text mentioning data: or blob: must remain persistable');

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'shape',
  type: 'note',
  props: { richText: { type: 'doc', content: [{ type: 'text', text: 'blob: URL 示例' }] } },
})), false, 'nested note prose must not be mistaken for embedded media');

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'asset',
  type: 'image',
  props: { src: 'data:image/png;base64,AAAA' },
})), true, 'an embedded tldraw image asset must be rejected');

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'asset',
  type: 'video',
  props: { src: 'blob:https://example.com/temporary' },
})), true, 'a temporary blob asset must be rejected');

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'asset',
  type: 'bookmark',
  props: { src: 'https://example.com/article', image: 'data:image/png;base64,AAAA', favicon: null },
})), true, 'bookmark preview and favicon fields must not smuggle embedded media');

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'asset',
  type: 'image',
  props: { src: 'https://cdn.example.com/image.png' },
})), true, 'a remote tldraw asset must not bypass the bounded upload API');

assert.equal(hasEmbeddedCanvasMedia(snapshot({
  typeName: 'shape',
  type: 'image',
  props: { assetId: null, url: 'https://attacker.example/image.png' },
})), true, 'a direct media shape must be rejected even without a matching asset record');

assert.deepEqual(extractCanvasBusinessLayouts({
  store: {
    'shape:atomflow-node-7': {
      id: 'shape:atomflow-node-7',
      typeName: 'shape',
      type: 'atomflow-node',
      x: 40,
      y: 60,
      props: { nodeId: '7', w: 320, h: 190 },
    },
    'shape:copied-node': {
      id: 'shape:copied-node',
      typeName: 'shape',
      type: 'atomflow-node',
      x: 999,
      y: 999,
      props: { nodeId: '7', w: 500, h: 500 },
    },
  },
}), [{ nodeId: 7, x: 40, y: 60, width: 320, height: 190 }], 'only the canonical business shape may update authoritative node geometry');

console.log('PASS: canvas snapshots reject unmanaged media while preserving prose');
