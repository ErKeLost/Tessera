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

当前官方 Catalog 只设计 Tessera Agent 当前真正需要的一个 Component：`data.chart`。它只接收严格 ChartSpec 和一个 Resource-backed Dataset binding，不接收内联 rows、样式、renderer props 或可执行内容。

当前锁定 17 个 `spec.recipe`：`steps-bars`、`pipeline-stage-bars`、`sleep-score`、`revenue-per-account-scatter`、`tracked-time-sankey`、`visitors-radial`、`visitors-radar`、`activity-calendar`、`revenue-smooth-area`、`active-users-heatmap`、`sign-up-funnel`、`earned-so-far-bars`、`contributions-heatmap`、`sessions-conversion-combo`、`devices-bars`、`visitors-stacked-area`、`activity-rings`。

这些名称是一个 Contract 内的严格判别联合，不是 17 个 Component，也不是隐藏的固定 Query renderer。未来增加 Component 只扩展 Catalog，不修改底层协议或渲染链。

## 3. 必须覆盖的产品场景

固定 golden set 至少覆盖以下任务族；每个任务都要有输入资源 descriptor、期望信息结构、允许的组件集合、关键断言和失败样本：

| 任务族 | 必须证明的组合能力 | 主要失败风险 |
| --- | --- | --- |
| 目标与阶段 | steps、pipeline、funnel、devices、earned bars | 阶段乱序、错误 aggregate、标签溢出 |
| 单值与完成度 | sleep score、radial visitors、activity rings | domain 错误、环形编码误导、中心值伪造 |
| 时间趋势 | smooth area、stacked area、sessions + conversion | 时间列误判、双指标比例失真、无等价摘要 |
| 分布与多维比较 | scatter、radar | 数值列角色错误、点数过多、维度不可比 |
| 流向 | tracked-time Sankey | source/target/value 不完整、空 SVG wrapper |
| 日期与二维强度 | activity calendar、active users、contributions | bucket 错位、缺失值与零值混淆 |
| 空与受限数据 | Host-owned deterministic fallback | 用假数据填空、泄露 denied metadata |
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
- `data.chart` 只使用满足 Contract 的 typed pinned Dataset，绑定明确的 evidence/provenance；任何 recipe 都不复制 payload。
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

“成功 commit”不等于“产品质量合格”。每个 golden case 还必须校验关键信息是否可扫描、是否选择正确 recipe、列角色与 aggregate 是否正确，以及是否保留 evidence。

## 6. Renderer 与交互门槛

- 唯一 `data.chart` Contract 具有 exact renderer registration、resolved-props validator、loading/empty/error/unsupported fixture 和 per-node error boundary。
- 17 个 recipe 逐一具有 valid ChartSpec、真实 renderer fixture、accessibility fixture 和 visual regression fixture；Sankey/Funnel/Heatmap/Calendar 等不能用空 Recharts wrapper 冒充实现。
- 所有 chart 有稳定尺寸、responsive constraints、reduced-motion 行为和同 Resource snapshot 的 table 等价视图。
- 大数据使用 server window、聚合或降采样，不以内联数组进入 node props。
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

当前 Tessera Agent 文档站同时提供一层可执行 reference proof：服务端 API 必须通过真实 Resource Gateway 完成 pinned publication、grant、projection 与 resolve，再发布携带 `ResourceResolutionIdentity` 的 trusted Surface snapshot；浏览器只允许经 `SurfaceController -> GenerativeSurface -> verified RendererRegistry` 消费。该证明固定覆盖唯一 `data.chart` Contract 与全部 17 个 recipe，并断言 identity-only refs、统一 Dataset Envelope、manifest integrity 和 no-payload Document。它是确定性的协议/渲染证明，不替代第 5 项要求的真实浏览器 visual regression 与 accessibility 产物。

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
