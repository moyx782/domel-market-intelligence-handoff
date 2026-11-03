# 前端自动化测试与体验改进

目标：每次改动后，用一个命令覆盖**所有页面、语言、角色、视口、异常/空状态**，同时检查
可访问性与交互体验，产出可复查的截图 + 报告；发现的体验问题直接修复。

## 一条命令

```bash
npm run test:frontend
```

它做四件事（`scripts/run-frontend-quality.mjs`）：

1. 在临时目录准备隔离数据（`scripts/acceptance-api.mjs --prepare --fixtures`，不碰 `.local/`）；
2. 启动本地 API（默认 `127.0.0.1:8793`）与 Vite（默认 `127.0.0.1:5178`）；
3. 运行 `scripts/frontend-quality.mjs` 的 Playwright 质量矩阵；
4. 结束后清理进程与临时数据。

结果写入：

- `evidence/frontend-quality/REPORT.md`（通过/失败、内容矩阵表、覆盖率说明）
- `evidence/frontend-quality/*.png`（每个页面 × 语言 × 视口，以及角色/异常/键盘截图）

只跑矩阵（已有服务时）：

```bash
BASE=http://127.0.0.1:5178 API_BASE=http://127.0.0.1:8793 \
  ACCEPTANCE_DATA_DIR=/tmp/domel-quality npm run test:frontend:raw
```

端口可用 `QUALITY_API_PORT` / `QUALITY_UI_PORT` 覆盖；`QUALITY_SHOTS=0` 跳过截图；
`QUALITY_KEEP_DATA=1` 保留临时数据；`CHROME_PATH=/path/to/chrome` 指定浏览器。

## 覆盖内容

### 1. 内容矩阵：6 页面 × 2 语言 × 2 视口 = 24 个场景

Events / Tasks / Sources / Projects / Agent / Settings，英文 + 中文，桌面 1440×900 +
移动 390×844。每个场景断言：

- 页面标题（`main h1`）与页面语义标题；
- 浏览器标签页 `document.title`（如 `展会日历 · Domel Market Intelligence`）；
- `<html lang>` 与所选语言一致（`en-GB` / `zh-CN`）；
- 可访问结构：header/nav/main 地标、唯一 `h1`、标题层级不跳级、所有可交互元素有可访问名称、
  `img` 有 alt、无重复 id、skip link 指向 `#main-content`；
- 移动端无页面级横向溢出；
- 0 console error / 0 page error。

### 2. 角色：admin / user / viewer

- admin：全功能；
- user：设置页可切换但无完整管理权限；
- viewer：无「New research」、设置页只读提示、AI 模型输入禁用、Agent 只读说明。
- 测试最后自动恢复 admin（viewer 无法通过 API 提升自己，脚本写本地 `agent-config.json`）。

### 3. 后端异常与空状态

- workspace 500 → 顶部 error alert + **Retry** 按钮，页面无运行时崩溃；
- 空 workspace → Projects 空状态；
- 空 event library → Events 空状态。

### 4. 键盘与对话框

- 第一次 `Tab` 聚焦 **Skip to main content**，`Enter` 跳到 `main`；
- 「流程指南」打开后焦点进入 dialog；
- `Escape` 关闭 dialog，焦点返回触发按钮。

### 5. 语言切换

中文/EN 切换后 `html lang`、`document.title`、导航文字同步更新。

### 6. 静态内容检查（在 `npm test` 中）

`tests/i18n-coverage.test.mjs` 扫描所有 `t('...')` 字面量，确保：
- 每个字面量键都有中文翻译；
- 中文翻译非空。

## 当前结果

```text
Frontend quality: 168 passed / 0 failed / 0 warnings
Duration: ~43s
```

（24 个内容场景 + 角色/异常/空状态/键盘/语言，共 168 项断言；截图 29 张。）

## 这轮根据测试修复的人类体验问题

| 问题 | 改进 |
|---|---|
| 页面切换后浏览器标签页仍是一个静态标题 | 每个页面/语言独立的 `document.title` |
| 键盘用户要 Tab 穿过整个侧栏才能到内容 | 新增 skip link，焦点目标 `#main-content` |
| 流程指南弹窗无法用键盘关闭、打开后焦点还在背景 | dialog 焦点管理：自动聚焦、Tab 循环、Escape 关闭、焦点返回 |
| 工作区加载失败只有一个错误条，无法恢复 | 错误条新增 **Retry**，同时保留 dismiss |
| 某个页面渲染异常会整页空白 | 全局 `ErrorBoundary` 恢复页（错误详情 + Reload） |
| 当前导航项没有语义标记 | 侧栏导航 `aria-current="page"` |
| 移动端菜单按钮状态不可感知 | `aria-expanded` / `aria-controls` + 关闭按钮翻译 |
| viewer 看到禁用的研究按钮但不知道为什么 | 项目页显示角色只读说明 |
| 语言切换只影响文案，不更新 `lang` | 切换语言同步 `<html lang>`（provider 统一处理） |
| 静态检查无法阻止漏翻译 | `npm test` 增加 i18n 字面量覆盖测试 |

## 局限与后续

- 当前是**结构/内容/可达性/交互**自动化，不做像素级视觉回归（字体/渲染差异会引入 flaky；
  可后续加 Playwright `toHaveScreenshot` 基线，只对关键页面、固定字体/动画关闭）。
- 可访问性检查不包含颜色对比度算法（可引入 axe-core 作为增强，不影响现有 CI）。
- 外部网络/AI 调用不在此套件内：API/任务/采集由 `npm run test:api`、`npm test`
  与浏览器验收覆盖；前端质量矩阵使用隔离数据与路由 mock。
- 需要本机 Chrome（`CHROME_PATH` 或 `channel: 'chrome'`）；CI 用 setup-chrome 提供。

## CI 示例

`.github/workflows/frontend-quality.yml` 已提供：Node 22 → `npm ci` → `npm test` →
setup Chrome → `npm run test:frontend` → 上传 `evidence/frontend-quality` artifact。
本地没有 GitHub runner，工作流本身未在本地执行；命令与本地一致。
