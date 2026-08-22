# Tessera Agent Generative UI 成功证明规范

- 状态：**产品验证基线**
- 日期：2026-08-22
- 对象：当前仓库中的完整 Generative UI reference implementation
- 产品范围：只验证 Tessera Agent
- 非目标：在本仓库证明任意行业、任意 Host 或任意 renderer 已经通用化

## 1. 要证明的结论

这次实现必须证明的不是“LLM 能输出一段组件 JSON”，而是下面这条完整产品结论：

> Tessera Agent 能把受治理的真实查询结果生成成有用、可信、响应式、可交互的数据分析界面；生成失败、流式中断、权限变化和动作冲突都不会破坏 last-good，也不会把数据或执行权交给模型。

只有这个结论被固定测试集、真实模型评测和可复现产物共同证明后，才启动独立 Open Generative 项目。

## 2. 当前组件边界

当前只设计 Tessera Agent 真正需要的 12 个正交 Component：

| 类别 | Component | Tessera 中的职责 |
| --- | --- | --- |
| Layout | `layout.stack` | 默认分析阅读流 |
| Layout | `layout.grid` | KPI 与可比较视图 |
| Layout | `layout.section` | 标题、说明和语义分组 |
| Content | `content.text` | 标题、解释和 caption |
| Content | `content.callout` | 洞察、限制、warning |
| Content | `content.empty` | 无数据、不可用和过滤为空 |
| Data | `data.metric` | 单个或紧密相关 KPI |
| Data | `data.table` | Resource-backed 明细和窗口化浏览 |
| Data | `data.chart` | 统一 ChartSpec 和完整 shadcn chart coverage |
| Data | `data.query-details` | SQL、lineage、freshness 与 evidence 检查面板 |
| Control | `control.filter` | Contract 限定的分析 filter state |
| Control | `control.group` | 少量相关 controls 的语义组合 |

这里不增加 Trend、Anomaly、Forecast、Funnel、Cohort 等固定业务大组件。它们只能成为由这 12 个 Component 组合出来的 Tessera recipe 和 eval case。

## 3. 必须覆盖的产品场景

固定 golden set 至少覆盖以下任务族；每个任务都要有输入资源 descriptor、期望信息结构、允许的组件集合、关键断言和失败样本：

| 任务族 | 必须证明的组合能力 | 主要失败风险 |
| --- | --- | --- |
| KPI 概览 | metric + comparison + evidence + compact grid | 伪造指标、单位错误、过度卡片化 |
| 时间趋势 | metric + line/area/bar chart + table equivalent view | 时间列误判、双轴误导、无可访问等价视图 |
| 分类对比 | bar/pie/radar 的受限选择 + ranking table | 类别过多、错误聚合、图表类型不合适 |
| 分布分析 | histogram-like bar/area composition + summary | bucket 语义丢失、把明细误当聚合 |
| 明细检查 | virtualized table + sort/page + query details | rows 进入 Document、越权导出、cursor 伪造 |
| Filter 探索 | filter/control group + resource re-resolve | client 自行 SQL、state precondition 丢失 |
| 空与受限数据 | empty/callout + deterministic reason | 用假数据填空、泄露 denied metadata |
| Query 可审计性 | query details + evidence + freshness | SQL 可见性越权、lineage 与 snapshot 不一致 |
| 流式创建 | progressive layout/content + atomic data nodes | 半截 entity 覆盖 last-good、preview 可交互 |
| 增量编辑 | selection-scoped operations + revision CAS | local ID remap、旧 revision 静默覆盖 |
| HostIntent | export/retry/apply + approval/receipt | renderer 直调工具、重复 effect、审批重放 |
| 恢复与冲突 | resume/ack/snapshot + last-good | gap 猜测、epoch 混用、overlay 残留 |

同一次 governed Query execution 必须能在不同问题中发布同源 typed Resources，并产生不同但合理的组合，证明系统不是隐藏的固定 Query renderer。

## 4. 数据边界证明

以下断言必须全部为 100%，不存在统计容忍：

- Query tool 成功输出只包含 binding/evidence refs 与 model-safe descriptor，不包含 rows。
- Proposal snapshot、Proposal operations、canonical Document、Revision envelope、Surface history 和普通 observability attributes 不包含 rows。
- Resource payload 只通过 actor/tenant/Surface-bound grant 与 server cursor 获取。
- `data.metric`、`data.chart`、`data.table` 和 `data.query-details` 使用满足各自 Contract 的 typed pinned Resources，并共享明确的 evidence/provenance；只有采用相同 Dataset Envelope 与 schema 的 Chart/Table binding 可以引用同一 pinned dataset `resourceVersionId`，任何节点都不复制 payload。
- Filter、projection、sort 和 window 都由 Resource capability 执行，模型不生成 SQL 或 cursor。
- denied、expired、revoked、schema-incompatible 和 unavailable 状态具有不同且确定的投影。
- Evidence 与 claim 永远绑定明确 snapshot/content hash；live resource 不回写历史 claim。

必须提供自动 no-payload 扫描，覆盖 prompt、tool result、wire fixture、history fixture 和日志 fixture。

## 5. 生成质量门槛

评测使用固定 provider/model/catalog profile，记录完整版本和随机性设置。至少包含 100 个 golden prompts，覆盖第 3 节所有任务族、不同数据形状和负面输入。

| 指标 | 通过门槛 |
| --- | --- |
| Provider schema 接受率 | 100% 请求可由目标 provider 接受 |
| 首次 proposal 结构有效率 | 不低于 95% |
| 有界 repair 后 commit 成功率 | 不低于 99% |
| 未提供资源/列/evidence 的虚构引用 | 0 |
| 超出 Catalog slice 的 Component/Action/Resource | 0 |
| 错误图表 encoding 或类型不匹配 | 不高于 1%，且全部在 commit 前拒绝 |
| 无意义重复组件或空装饰 section | 不高于 2% |
| 同输入 snapshot 与等价 operation 的 canonical 差异 | 0 |

“成功 commit”不等于“产品质量合格”。每个 golden case 还必须校验关键信息是否可扫描、是否选对主要视图、是否保留 evidence，以及 table/chart 是否表达同一个资源语义。

## 6. Renderer 与交互门槛

- 12 个 Contract 全部具有 exact renderer registration、resolved-props validator、loading/empty/error/unsupported fixture 和 per-node error boundary。
- `data.chart` 对锁定的 61 chart + 9 tooltip recipes 逐一具有 valid ChartSpec、renderer fixture、accessibility fixture 和 visual regression fixture。
- 所有 chart 有稳定尺寸、responsive container、reduced-motion 行为和同 snapshot 的 table 或 text-summary 等价视图。
- Table 使用 server window 与稳定 row identity；大数据不以内联数组进入 node props。
- Preview node 全部 read-only，不存在 emitter；committed node 的 emitter 只能发送当前 Contract 声明且在该 node 上精确绑定的 event port。任意其他 port 不得误启用 Copy、Export、Apply 或 Reset。
- surface-local transition 在浏览器 Runtime 原子执行；document state 和 HostIntent 必须走 server authority。
- desktop panel、mobile sheet 和 inline placement 共用同一个 SurfaceController 状态，不复制 renderer 链。
- keyboard、screen reader、focus、locale、timezone、density、loading、empty、error、approval 和 conflict matrix 全部通过。

## 7. 流式、持久化与安全门槛

- complete entity operation 是唯一流式应用单位；半截 JSON 永不进入 preview。
- 任意 parse、validation、timeout、abort 或 CAS conflict 保留 last-good。
- 同一 Surface 同时最多一个 active preview overlay；commit 原子 promote，invalidate 完整清除。
- event sequence、eventId、payloadHash、cursor、audience binding、contractSetHash 任一错误都会 fail closed。
- command retry 返回原 command receipt；外部 effect 通过 idempotency identity 保证只执行一次。
- approval token 单次消费，并在执行前重新认证、授权和检查 precondition。
- cursor 过期、epoch 改变、scope mismatch 和 retention gap 都要求 trusted snapshot，不猜测缺失事件。
- browser export closure 不包含 compiler、resources、capabilities、server credential 或 Node-only module。

## 8. 证明产物

每次候选发布必须产生并锁定：

1. Catalog、Contract、renderer capability 和 chart coverage manifests。
2. 100+ golden prompt 的输入、proposal、diagnostics、commit result 和产品质量评分。
3. snapshot/operation parity、replay、resume、conflict 和 security fixtures。
4. no-payload 扫描报告。
5. desktop/mobile/placement visual regression 与 accessibility 报告。
6. exact dependency versions、integrity、source tree hash 和 build provenance。
7. 所有失败 case 的分类、是否 model-correctable、repair 次数与最终状态。

产物必须可在无生产 credential 的 CI 中重放；真实 provider eval 可以作为受控外部 job，但其输入 profile 和输出摘要必须版本化。

当前 Tessera Agent 文档站同时提供一层可执行 reference proof：服务端 API 必须通过真实 Resource Gateway 完成 pinned publication、grant、state-bound projection 与 resolve，再发布携带 `ResourceResolutionIdentity` 的 trusted Surface snapshot；浏览器只允许经 `SurfaceController -> GenerativeSurface -> verified RendererRegistry` 消费。该证明固定覆盖 12 个 Component Contracts、全部 70 个 chart/tooltip recipes 和 Query analysis、Filter-bound breakdown、Workspace health 三个 Data Agent composition，并断言 identity-only refs、统一 Dataset Envelope、manifest integrity、no-payload Document 与逐 event-port 交互门控。它是确定性的协议/渲染证明，不替代第 5 项要求的真实浏览器 visual regression 与 accessibility 产物。

## 9. 与 Tessera Agent 的接入边界

当前仓库实现自包含 reference harness 和 contracts，不直接修改 `/Users/work/data-agent` 中的 Tessera Agent 应用。未来接入只允许发生在这些明确位置：

```text
governed query tool
-> pinned Query Resource + Evidence publication
-> frozen Tessera Catalog slice
-> present_ui proposal
-> transaction/commit
-> trusted SurfaceEventStream
-> one SurfaceController
-> one GenerativeSurface
-> Tessera Data UI RendererRegistry
```

Tessera Agent 的 chat route、Workbench、history 和 Mastra tools 由独立实施任务改造；本仓库通过 fixtures 和 adapters 先证明它们需要的公开边界。

## 10. 未来独立 Open Generative 项目

只有第 4 至第 8 节全部通过后才开始拆分。拆分规则：

- protocol、catalog contract、compiler、runtime、server/client boundary、React binding 与通用 conformance 进入新项目。
- Tessera Query Resource producer、SQL policy、Data Agent prompts、业务 recipes、golden conversations 和 Workbench integration 不进入通用 core。
- 当前 canonical bytes、hash domains、wire unions、ContractRef 和 renderer identity 不改名、不做兼容双轨。
- 新项目必须新增至少一个非数据 Catalog 的 conformance proof，证明底层没有被 Tessera 业务模型反向绑死。
- 拆分前本仓库是架构真相来源；拆分完成后，通用协议真相来源迁移到新项目，本仓库只消费版本化 package。
