# Tessera 的 Vercel AI Gateway 配置

普通聊天与 Jev evaluation 共用 Gateway API key，但模型接口不同。普通聊天由 Mastra 执行；Jev 通过 AI SDK `experimental_evaluate()` 执行。

## 1. 创建并配置密钥

在已登录的 Vercel CLI 中执行（也可在 Vercel 控制台创建）：

```bash
vercel ai-gateway api-keys create --name tessera
```

把得到的 key 写进服务端 `.env`，或填入 Studio 的 API key 字段：

```dotenv
AI_GATEWAY_API_KEY=你的密钥
```

Studio 本地运行即可，不需要部署到 Vercel。此项目的本地配置使用 API key；Vercel 文档中的 OIDC 属于部署环境的另一种认证方式。

## 2. 普通聊天 Gateway

设置页进入 **Model**，选择 **Vercel AI Gateway**，再选择模型。Base URL 留空，让 Mastra 使用原生 Vercel 适配器。

项目配置 `tessera.config.ts`：

```ts
import { defineTesseraConfig } from "@open-tessera/studio";

export default defineTesseraConfig({
  database: { url: process.env.DATABASE_URL! },
  llm: {
    model: "vercel/openai/gpt-4.1-mini",
    temperature: 0.1,
    maxOutputTokens: 4096,
    maxSteps: 12,
    maxRetries: 2,
    providerOptions: {
      gateway: {
        order: ["openai"],
        models: ["google/gemini-2.5-flash"],
      },
    },
  },
});
```

`providerOptions` 已在服务端配置与 Agent 请求之间接通，不出现在浏览器公开快照中。当前高级路由选项通过配置文件设置。切换 gateway 时不会沿用上一个 gateway 的密钥、请求头或高级选项。

| 参数 | 含义 |
| --- | --- |
| `model` | Mastra 配置中用 `vercel/厂商/模型`；Studio 模型字段、AI SDK 与 Gateway API 中用 `厂商/模型` |
| `temperature` | 采样温度；是否接受取决于模型 |
| `maxOutputTokens` | 每次模型调用的最大输出 token 数 |
| `maxSteps` | Tessera Agent 的最大模型/工具迭代次数，当前允许 3–50 |
| `maxRetries` | 请求重试次数，与 Gateway 的模型回退是不同机制 |
| `providerOptions.gateway.order` | 优先尝试哪些推理服务商及其顺序；不是严格白名单 |
| `providerOptions.gateway.only` | 限制允许使用的推理服务商 |
| `providerOptions.gateway.models` | 主模型失败后的备用模型，使用 `厂商/模型`，不加 `vercel/` |
| `providerOptions.gateway.sort` | 按 `cost`、`ttft` 或 `tps` 排序 |
| `providerOptions.gateway.caching` | `"auto"` 让 Gateway 为支持的模型自动设置缓存 |

模型厂商和推理服务商是两个概念。例如 Anthropic 模型可以由 `anthropic` 或 `bedrock` 托管。`order` / `only` 中填写模型详情页提供的 provider slug，不能随便填写模型 ID。没有明确路由需求时可省略整个 `providerOptions`，使用 Gateway 默认路由。

如果使用 `only`，需要确保备用模型也有被允许的服务商。模型可用性与工具支持以实时模型目录为准。

自定义 `baseUrl` 会选择 OpenAI-compatible 协议。Vercel 的兼容地址是 `https://ai-gateway.vercel.sh/v1`，但默认建议留空。不同协议对高级参数的支持可能不同，本文路由参数配置以默认原生适配器为准。

## 3. Jev 结构化评估

同一设置页选择 Vercel 后，下面会出现 **Jev evaluation**。填入 State 与 Questions JSON，点击 **Run Jev evaluation**。这个操作使用表单中的 Vercel key（或已保存的 Vercel key / 服务端环境变量），不保存表单，也不替换聊天模型。

State 可以是文本、JSON 对象或 JSON 数组。Questions 示例：

```json
{
  "refunded": {
    "type": "boolean",
    "instructions": "Was a refund issued?"
  },
  "route": {
    "type": "choice",
    "instructions": "Which team should handle this?",
    "criteria": {
      "billing": "Payment or refund problems",
      "support": "Other support problems"
    }
  },
  "quality": {
    "type": "score",
    "instructions": "Rate how completely the issue was resolved.",
    "criteria": ["unresolved", "partially resolved", "fully resolved"]
  }
}
```

- `boolean` 返回 `probability`，范围 0–1；它是模型对 true 的概率，不是直接返回 true/false。
- `choice` 返回 `choice`，并可附每个选项的 `probabilities`。
- `score` 根据从低到高排列的 `criteria` 返回插值 `score`，并可附每个等级的概率。

本项目的试用入口支持一次 1–20 个问题，State 最多 32,000 个序列化字符，调用超时 30 秒且不自动重试。返回值仅包含模型、答案与 token 用量。

底层调用方式：

```ts
import { createGateway, experimental_evaluate as evaluate } from "ai";

const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
const result = await evaluate({
  model: gateway.evaluationModel("typesafe-ai/jev"),
  state: "The support agent issued a full refund to the customer.",
  questions: {
    refunded: { type: "boolean", instructions: "Was a refund issued?" },
  },
  maxRetries: 0,
  abortSignal: AbortSignal.timeout(30_000),
});
console.log(result.answers, result.usage);
```

Jev 必须使用 evaluation 接口，官方不支持通过 OpenAI-compatible Chat Completions 调用。这里没有 `temperature`、`maxSteps` 等聊天参数。Jev 始终使用 Vercel 原生 endpoint，不沿用聊天自定义 Base URL。AI SDK 已升级到具有该 API 的 `7.0.105`。

## 官方资料

- [Gateway 总览](https://vercel.com/docs/ai-gateway)
- [API key 创建](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys)
- [AI SDK 接入](https://vercel.com/docs/ai-gateway/sdks-and-apis/ai-sdk)
- [Provider 路由参数](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
- [Provider 排序与筛选](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)
- [模型回退](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks)
- [Jev / Evaluation 参数](https://vercel.com/docs/ai-gateway/modalities/evaluation)
