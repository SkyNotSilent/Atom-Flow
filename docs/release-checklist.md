# AtomFlow 发布检查清单

## 1. 代码冻结
- 功能开发冻结，仅允许修复类改动
- 本次发布范围、版本号、负责人明确

## 2. 质量检查
- 执行 `npm run lint`
- 主流程手测：
  - 今日推送阅读与存入
  - 知识库筛选与来源回溯
  - 魔法写作召回与导出
  - 三栏拖拽宽度

## 3. 文档更新
- 更新 `CHANGELOG.md`
- 更新 `README.md` 的版本亮点
- 如有流程变更，更新 `docs/README_INTERNAL.md`

## 4. Git 操作
- 创建发布分支（如需）：`release/vX.Y.Z`
- 合并到 `main`
- 打标签：`vX.Y.Z`
- 推送分支与标签：
  - `git push origin main`
  - `git push origin vX.Y.Z`

## 5. 回滚预案
- 记录上一个稳定 tag
- 准备快速回滚命令：
  - `git revert <commit>`
  - 或 `git checkout <stable-tag>`
