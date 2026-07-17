# AtomFlow 第三方声明

最后更新：2026-07-12

AtomFlow 项目自有代码默认按根目录 [LICENSE](LICENSE) 的 MIT License 提供，但明确标注为其他许可证的组件、文件和第三方依赖除外。MIT License 不会覆盖、替代或重新许可第三方软件。

本文件提供重点披露，不代替 `package-lock.json`、各依赖包内许可证或供应商合同。分发者应在每次发布前重新生成完整依赖清单并保留所有适用声明。

## Apache-2.0 文件

[`src/App.tsx`](src/App.tsx) 明确标注 `SPDX-License-Identifier: Apache-2.0`，因此该文件按 Apache License 2.0 提供，而不是由仓库根目录的 MIT License 重新许可。许可证全文见 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)。

## tldraw

- 组件：`tldraw`
- 本仓库锁定版本：`5.2.3`
- 用途：魔法写作无限画布
- 上游仓库：[tldraw/tldraw](https://github.com/tldraw/tldraw)
- 许可证说明：[tldraw License](https://tldraw.dev/community/license)
- 本地完整副本：[`LICENSES/TLDRAW_LICENSE.md`](LICENSES/TLDRAW_LICENSE.md)

安装包 `node_modules/tldraw/LICENSE.md` 指向上游仓库的 `LICENSE.md`。本仓库保存了 2026-07-12 从该上游 `main` 分支取得的当前许可证原文，未作翻译或改写。上游许可证最近提交为 [`e455ab838b8f30b3710b75cf340d98f2da086ac8`](https://github.com/tldraw/tldraw/commit/e455ab838b8f30b3710b75cf340d98f2da086ac8)。

**重要：** `tldraw` 和 `@tldraw/editor` 使用 tldraw 自有许可证。该许可证允许开发环境使用，但生产环境使用需要符合试用或商业安排并提供适当、有效的 License Key。AtomFlow 的 `VITE_TLDRAW_LICENSE_KEY` 是生产构建变量；没有适当密钥时，不应把无限画布作为可用生产功能发布。AtomFlow 的 MIT License 不会把 tldraw 重新许可为 MIT，也不会授予绕过其技术措施的权利。

部分 `@tldraw/*` 基础包在其安装包元数据中单独标注 MIT；每个包仍以其自身 `package.json` 和 `LICENSE.md` 为准。

## 运行时服务供应商

以下项目是可配置的外部服务，不是因 MIT License 而获得授权的库。具体部署必须在 [PRIVACY.md](PRIVACY.md) 和功能就地告知中披露实际启用项。

| 服务 | AtomFlow 中的用途 | 公开政策/条款 |
| --- | --- | --- |
| MiMo Token Plan / 小米 OpenAI-compatible API | 默认 AI 原子化与写作 Agent | [小米隐私政策](https://privacy.mi.com/all/en_US)；具体以购买的 MiMo 服务协议为准 |
| OpenAI API 或其他兼容提供商 | 可选 AI 运行时覆盖 | [OpenAI API 数据控制](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)；兼容提供商各自政策 |
| 百度翻译 | 可选文章文本翻译 | [百度翻译开放平台](https://fanyi-api.baidu.com/)；[百度智能云隐私政策](https://cloud.baidu.com/doc/Agreements/s/Plr0fi68q) |
| 火山引擎 ASR | 可选实时语音转文字 | [火山引擎隐私政策](https://www.volcengine.com/docs/6256/64902) |
| Resend / SMTP 服务商 | 验证码和账号邮件 | [Resend 隐私政策](https://resend.com/legal/privacy-policy)；SMTP 实际供应商政策 |
| Railway | 应用和可选 PostgreSQL 托管 | [Railway 隐私政策](https://railway.com/legal/privacy)；[Railway DPA](https://railway.com/legal/dpa) |
| PostgreSQL 托管方 | 用户账号、知识资产、画布、会话等持久化 | 以部署运营者选择的数据库供应商协议为准；PostgreSQL 本身是数据库软件而非必然的独立数据接收方 |

## npm 依赖

AtomFlow 还使用 React、Express、PostgreSQL 客户端、OpenAI Agents SDK、Readability、JSDOM、RSS Parser、Resend SDK、Nodemailer、Multer、Sharp 及其他 npm 软件包。其名称仅用于识别依赖，不表示供应商背书 AtomFlow。

安装和分发者应：

1. 以锁文件安装依赖，并保留包内 `LICENSE`、`NOTICE` 和版权声明。
2. 在升级依赖后重新检查许可证，尤其是 `tldraw` 和带有 `SEE LICENSE IN ...` 标记的包。
3. 不把宽松许可证依赖清单误写成整个分发物都受 MIT License 约束。
4. 对需要署名、提供源码、限制生产使用或另有商业条件的组件单独履行义务。

如发现缺失或错误的第三方声明，请按 [SECURITY.md](SECURITY.md) 中的私密渠道（涉及安全时）或仓库 Issue（不涉及敏感信息时）报告。
