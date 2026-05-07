# Floating Graph Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Knowledge Graph header bar and move the active/all switch plus zoom controls into a floating right-top toolbar inside the graph canvas.

**Architecture:** This is a focused React markup/style change inside the existing writing workspace graph view. The graph canvas remains the single positioning container; the SVG still owns node rendering and zoom transform, while a non-scaled absolutely positioned toolbar overlays the canvas.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind utility classes, lucide-react ZoomIn/ZoomOut icons.

---

## File Structure

- Modify: `src/pages/WritePage.tsx`
  - Remove the header wrapper at the top of the graph workspace.
  - Add an absolutely positioned right-top floating toolbar inside `atomflow-force-canvas`.
  - Reuse the existing `writeGraphView`, `setWriteGraphView`, `writeActivatedNodeIds`, `zoom`, `setZoom`, and `zoomLabel` state/values.
- No new files.
- No test files for this micro UI-only change; verification is via TypeScript build check and browser interaction.

---

### Task 1: Move Graph Controls Into Floating Toolbar

**Files:**
- Modify: `src/pages/WritePage.tsx:2816-2857`

- [ ] **Step 1: Inspect the current graph workspace block**

Read `src/pages/WritePage.tsx` around the graph workspace return block and confirm it still contains this shape:

```tsx
return (
  <div className="flex h-full min-h-0 gap-4 bg-bg">
    <div id="page-write" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[30px] border border-[#E7DAC0] bg-[#FBF7EF] shadow-[0_20px_48px_rgba(150,120,78,0.1)]">
      <div className="border-b border-[#E9DFC9] bg-[#FFFCF5] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold text-[#3C2A19]">知识关系图</div>
            <div className="mt-1 text-[12px] text-[#8B745C]">平面的 2D 受力系统。文章拆成原子星点，父子天然相连，跨节点只保留真实语义连接。</div>
          </div>
          <div className="flex items-center gap-2">
            {writeActivatedNodeIds.length > 0 ? (
              <div className="flex items-center gap-1 rounded-full border border-[#E5D6BB] bg-white px-1 py-1">
                <span className="px-2 text-[11px] text-[#8A7359]">显示范围</span>
                {[
                  { key: 'all', label: '全部' },
                  { key: 'activated', label: '激活' }
                ].map(item => (
                  <button
                    key={item.key}
                    onClick={() => setWriteGraphView(item.key as typeof writeGraphView)}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                      writeGraphView === item.key ? 'bg-[#F1E2C7] text-[#6F4E2D]' : 'text-[#9A8064] hover:bg-[#FCF4E4]'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="rounded-full border border-[#E5D6BB] bg-white px-2.5 py-1 text-[11px] text-[#8A7359]">{zoomLabel}</div>
            <button onClick={() => setZoom(prev => Math.min(1.35, +(prev + 0.05).toFixed(2)))} className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5D6BB] bg-white text-[#7F654C] transition-colors hover:bg-[#FCF4E4]">
              <ZoomIn size={14} />
            </button>
            <button onClick={() => setZoom(prev => Math.max(0.85, +(prev - 0.05).toFixed(2)))} className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5D6BB] bg-white text-[#7F654C] transition-colors hover:bg-[#FCF4E4]">
              <ZoomOut size={14} />
            </button>
          </div>
        </div>
      </div>

      <div ref={graphCanvasRef} className="atomflow-force-canvas relative min-h-0 flex-1 overflow-hidden">
```

- [ ] **Step 2: Replace the header plus canvas opening with the floating toolbar version**

Replace the header wrapper and the opening canvas line with this exact structure. Keep the graph empty state and `<svg>` block that follow untouched.

```tsx
return (
  <div className="flex h-full min-h-0 gap-4 bg-bg">
    <div id="page-write" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[30px] border border-[#E7DAC0] bg-[#FBF7EF] shadow-[0_20px_48px_rgba(150,120,78,0.1)]">
      <div ref={graphCanvasRef} className="atomflow-force-canvas relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute right-4 top-4 z-20 flex items-center gap-2 rounded-full border border-[#E5D6BB]/90 bg-white/85 px-2 py-1.5 shadow-[0_14px_34px_rgba(128,96,56,0.16)] backdrop-blur-md">
          {writeActivatedNodeIds.length > 0 ? (
            <div className="flex items-center gap-1 rounded-full border border-[#E5D6BB] bg-[#FFFCF5] px-1 py-1">
              <span className="px-2 text-[11px] text-[#8A7359]">显示范围</span>
              {[
                { key: 'all', label: '全部' },
                { key: 'activated', label: '激活' }
              ].map(item => (
                <button
                  key={item.key}
                  onClick={() => setWriteGraphView(item.key as typeof writeGraphView)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                    writeGraphView === item.key ? 'bg-[#F1E2C7] text-[#6F4E2D]' : 'text-[#9A8064] hover:bg-[#FCF4E4]'
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="rounded-full border border-[#E5D6BB] bg-[#FFFCF5] px-2.5 py-1 text-[11px] text-[#8A7359]">{zoomLabel}</div>
          <button
            onClick={() => setZoom(prev => Math.min(1.35, +(prev + 0.05).toFixed(2)))}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[#E5D6BB] bg-[#FFFCF5] text-[#7F654C] transition-colors hover:bg-[#FCF4E4] focus:outline-none focus:ring-2 focus:ring-[#D8B878]/40"
            aria-label="放大知识关系图"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => setZoom(prev => Math.max(0.85, +(prev - 0.05).toFixed(2)))}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[#E5D6BB] bg-[#FFFCF5] text-[#7F654C] transition-colors hover:bg-[#FCF4E4] focus:outline-none focus:ring-2 focus:ring-[#D8B878]/40"
            aria-label="缩小知识关系图"
          >
            <ZoomOut size={14} />
          </button>
        </div>
```

- [ ] **Step 3: Verify JSX nesting**

Confirm the graph canvas still contains the grid immediately after the new toolbar:

```tsx
<div className="atomflow-force-grid absolute inset-0 pointer-events-none" />
```

Confirm the closing tags after the SVG/empty state still close, in order:

```tsx
      </div>
    </div>
    {renderAssistantAside()}
  </div>
);
```

- [ ] **Step 4: Run TypeScript check**

Run:

```bash
npx tsc --noEmit
```

Expected: command exits successfully with no TypeScript errors.

- [ ] **Step 5: Run production build**

Run:

```bash
npm run build
```

Expected: Vite build completes successfully and prints a production bundle summary.

- [ ] **Step 6: Browser verify the UI**

Run the dev server if it is not already running:

```bash
npm run dev
```

Open the app in a browser at the local dev URL printed by the command. Navigate to the writing workspace graph view and verify:

```text
- The old top header bar is gone.
- The graph canvas uses the released vertical space.
- The toolbar floats at the canvas right-top corner.
- The zoom percentage is visible.
- Zoom in increases the graph scale by 5% per click up to 135%.
- Zoom out decreases the graph scale by 5% per click down to 85%.
- If activated nodes exist, the 全部/激活 switch appears and still changes the visible graph scope.
- If activated nodes do not exist, the switch is hidden while zoom controls remain visible.
- The floating toolbar does not scale with the SVG graph.
```

- [ ] **Step 7: Commit**

Only commit if the user explicitly requests a commit. If committing, stage the modified file only:

```bash
git add src/pages/WritePage.tsx
git commit -m "refactor: float graph controls on canvas"
```

---

## Self-Review

- Spec coverage: The plan removes the header bar, moves the controls to the right-top of the graph canvas, preserves active/all and zoom behavior, keeps the toolbar independent from SVG zoom, and includes type/build/browser verification.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: All referenced state and helpers already exist in `src/pages/WritePage.tsx`: `writeActivatedNodeIds`, `writeGraphView`, `setWriteGraphView`, `zoomLabel`, `setZoom`, `ZoomIn`, `ZoomOut`, and `cn`.
