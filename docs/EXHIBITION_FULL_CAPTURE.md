# 展会全量研究：先采集，后筛选

分支：`feature/exhibition-full-capture`。基线：`b3631395b35aa9fd49cd9d5e69c54f2b8ed8339c`。

## 产品范围

不仅研究电机、风机和驱动同行参加的展会，也包括家电、清洁设备、暖通、医疗/实验室及工业设备等可能应用 Domel 产品的下游企业。企业可能是潜在客户、竞品或合作对象；采集时不依此排除任何条目。应用匹配不证明实际采购或供货关系。

新入口为左侧 **展会全量研究 / Exhibition capture**，原项目、人工审核和报告入口保留。

## 使用流程

1. 输入展会名称、明确届次和公开入口网址：展会首页、展商目录、分类页、公开文件，每行一个。未替团队预选来源。
2. 系统为发现的每个页面创建独立持久任务 `exhibition.capture`：展会 → 目录分页 → 企业详情及目录 → 产品详情 → 参数/公开价格。
3. Agent 对独立采集器已经保存的页面抽取条目，不以与 Domel 的相关性预筛选；所有发现的企业和产品保留。目录分页和分类链接必须在实际保存的 HTML 中出现。
4. 观察已发现、已采集、待处理、失败、企业和产品数量，以及有本届证据的官网总数。可以补充目录/文件入口、重试、暂停；队列恢复支持重启继续。
5. 待采集任务结束后才启用筛选和 `exhibition.analyse`。只有明确接受缺口，才允许分析或提交不完整快照。关系标签为待审核推断，缺少支持事实 ID 的分类保留为未分类。
6. 将事实提交到原有项目审核页。产品事实保留企业/型号名称；短引文会从真实保存正文扩展上下文，以满足原审核接口。无法满足引文要求的事实仍留在原始研究，不自动进入报告。
7. 原有编辑、批准/拒绝及仅含已批准发现的报告快照规则不变。不由 Agent 自动批准。

## 证据与原始资料

- 新数据文件：`.local/exhibition-studies.json`。
- 证据目录：`.local/exhibition-evidence/<study-id>/`。
- 每次捕获保留请求 URL、最终 URL、标题、采集时间、方式、原始 HTML/正文、SHA256。
- 动态页面已有浏览器渲染时，采集模式请求并保存完整页面截图；公开文件保留原始字节。未配置 OCR 或解析失败时，文件仍可下载，状态明确显示待解析，不凭空生成事实。
- 事实关联 evidenceId、sourceUrl、原文引文、定位、来源届次。参数可保存单位和工况；价格可保存币种、数量、税费/运输、渠道/日期等条件。缺失不补造，不自动比较不同工况的数值。
- 公司参展与产品本届展出分开：产品默认标记“企业产品，未确认本届展出”。未知/往届名单不证明本届参展。
- JSON 导出保留原始图谱；可在界面打开对应网址、正文、HTML、截图或文件。筛选不会删除原始记录。

## 实现与接口

`server/exhibition-study.mjs`：持久图谱、证据归档、分页/企业/产品任务、逐页分段抽取、采集后分类。

`server/exhibition-api.mjs`：复用原角色检查和审核存储。

```
GET/POST /api/v1/exhibition-studies
GET      /api/v1/exhibition-studies/:id
POST     /api/v1/exhibition-studies/:id/resume  # 可附 url、stage、parentId
POST     /api/v1/exhibition-studies/:id/cancel
POST     /api/v1/exhibition-studies/:id/analyse # acceptPartial 明确接受缺口
POST     /api/v1/exhibition-studies/:id/publish # 提交为待人工审核的项目
GET      /api/v1/exhibition-studies/:id/export
GET      /api/v1/exhibition-studies/:id/evidence/:evidenceId
```

前端：`src/ExhibitionStudy.tsx`；任务页增加两种新任务类型。

## 运行独立分支（避免和旧网站端口冲突）

检出本分支并运行 `npm ci`。模型 Key 只在服务端环境或设置页填写，不放到前端。

PowerShell 后端窗口：

```powershell
$env:LOCAL_API_PORT='8795'
$env:LOCAL_API_URL='http://127.0.0.1:8795'
$env:APP_ORIGINS='http://127.0.0.1:5195'
npm.cmd run demo:api
```

另一个 PowerShell 前端窗口：

```powershell
$env:VITE_APP_MODE='local'
$env:VITE_BACKEND_URL='http://127.0.0.1:8795'
npm.cmd run dev -- --port 5195 --strictPort
```

打开 `http://127.0.0.1:5195/`，进入展会全量研究。后端/前端必须使用相同 API 地址和允许的 Origin。Linux 可用对应的环境变量命令。Windows 自动寻找 Chrome/Edge，也可设置 `CHROME_PATH`。

## 验收与边界

2026-11-05：74 项针对性测试通过，包括采集器、真实系统 Chrome 渲染测试、目录 20 家企业不预筛、分页、下游企业、参数/价格、原文件/截图、失败/暂停/恢复、网址与引文、API/队列集成、人工批准后报告、原有权限与队列回归。生产构建通过。

浏览器隔离接口测试通过：创建研究、采集阶段禁用筛选、采集后保留下游企业、查看证据和原网址；无 pageerror。HTTP/队列端到端测试使用注入的页面和 Agent 输出；并非付费模型或真实展会全量验收。

“全量”是采集优先和覆盖核对目标，不代表已经抓全互联网。目录、分页、产品链接发现依赖页面结构和模型抽取；JS 隐藏分页、复杂搜索表单、验证码、受限文件、未公开价格、未知总量都可能造成缺口。动态自动化目前复用通用渲染/滚动，并未实现每家网站专用翻页适配器。页面抓取仍遵守 robots、限速、超时和文件大小限制，不绕登录/付费墙/验证码。

没有原先研究流程的全局 5 页上限；长正文分段处理，原始快照不截断。但发现链接穷尽不证明完整性，必须看官网声明总量、缺口和失败。大型企业分析超过单次输入预算时明确保留未分类，不删除原始资料。模型抽取和关系推断仍需人工核验。

同名企业和同名产品仍需人工核实；名称/型号去重不是工商实体认证。数据为单进程 JSON，没有跨进程数据库事务，不支持同一目录多个服务进程。发布审核期间若进程异常，应先检查已有项目再重试；不承诺跨文件 exactly-once 发布。

本分支尚未完成真实展会全目录和全部产品的现场验收，也未引入登录/TLS/多用户。请只在可信本机或内网演示。原默认分支未被覆盖。

## 本机一键启动

Windows 可双击仓库根目录 `START_EXHIBITION.cmd`，或运行 `node scripts/start-exhibition.mjs`。启动器固定 API 8795、前端 5195，并为子进程传入匹配的前端地址和 CORS Origin；后台启动后检查展会研究 API。日志位于 `.runtime/`。它不会停止其他网站；若端口已占用且不是本项目，请先检查占用进程。服务端模型配置仍来自忽略提交的 `.env.host` 或设置页，不将密钥写入启动器。
