# 协议行为

对齐 `src/lib/protocol/*`、`src/lib/identity/crs-persona.mjs` 的 `handleProtocol`。Chat 转换小节于 2026-09-24 更新；其余历史运行说明应结合当前源码核对。

Claude 槽位上游 hop 使用 `stream:true`；客户端 `stream:false` 仍由 Node 读取上游 SSE、校验终态并聚合成 JSON。原始 SSE、组装后的 Messages JSON 与客户端 Chat JSON 是不同层的数据；内核返回的末尾 metadata 也参与最终校验与用量合并。

## 官方 Claude Code 判定

`isOfficialClaudeCodeTraffic(headers, body)` 四闸：

| 条件 | 实现 |
|------|------|
| UA | `^claude-cli/\d+\.\d+\.\d+`（sub2api 同款前缀；vscode / cowork / desktop 都算） |
| `metadata.user_id` | 合法官方 user id |
| tools | 不能是 OpenAI `{type:function}` / `tool_choice.type=function`。`/v1/messages` 上这种 tools 会先转 Anthropic，但仍判非官方 |
| system | 含 `x-anthropic-billing-header:`、官方 `cc_entrypoint`（`cli` / `sdk-cli` / `vscode` / `cowork` / `desktop`，不含 `local-agent`）、或官方身份行（含 `You are Claude Code` / `Claude Agent SDK` 变体） |

四闸不全 → 非官方；非 Chat 路径按相应人设处理。Claude Chat 路径不再依赖此分类来清洗或改写 caller system。虚拟机测试 / 能力探针入站会先铺 4 块官方 system + 官方 UA，因此分类为 `claude_code_official`。压测 UA 仍是第三方。

## 非官方人设

**Claude Chat 特例：** `/v1/chat/completions` 跳过 Node 层人设改写、overlay/search 自动注入和 usage 遮罩，见下方 CPA 小节。槽位 kernel 的人设配置仍然存在，其最终处理不等同于 Node 层保证。

每次请求热读 `routing.compatibility`（改盘无需重启 Node）。仓库配置为：

| 键 | 值 | 含义 |
|----|----|------|
| `persona_preset` | `official_full` | 使用独立的完整官方模板；`official` 保留原有官方提示词 |
| `overlay_preset` | `off` | 不向首条 user 注入 overlay |
| `persona_park` | `false` | 与 `overlay_preset=off` 对齐 |
| `cache_ttl` | `auto` | 默认按凭证：OAuth/Setup Token 1h、API Key 5m；显式 5m/1h 或 `x-kin-cache-ttl` 只改变补齐缺失 TTL 的默认值，不覆盖块上的显式 TTL |

**official 模板**保留 billing + Agent SDK identity + 可选 caller_agent / caller_system，并在 agent 块之后写槽位 `# Environment`（`{{env}}`，只含 `Timezone: <槽位时区>`，不新增缓存断点；agent 块 TTL 跟随缓存策略）；不会自动追加完整 agent prompt。

**official_full 模板**在相同前缀后固定追加完整 `agent_official`，模板只带 ephemeral 标记、不自定 TTL；调用方 system 作为末块追加。zero 也保留 ephemeral 占位块，**0 注入不等于关闭缓存**。已保存模板内的显式 TTL 仍保留；若希望改为自动，请清空该模板块的 TTL 或恢复新默认模板。

**zero 模板**在 agent 槽之后写 `{{env}}` 块（`hide`、`drop_if_empty`、不挂 cache），只含槽位时区。自定义档空模板回落 official，同样带 `{{env}}`。live 已自定义的 zero 模板不会自动多出这一块，需在 system提示词页「恢复预设」。

**agent prompt 常驻约束**：默认不启用。`compatibility.agent_standing` 仍保留内置 distillation / 思维链 / NSFW 四行文本（显式空串 = 不加，上限 2000 字符），只有当前档的 `agent_standing_presets` 显式为 `true` 才经 `{{agent_standing}}` 写成 agent 块第一段：official / 0注入 在 `caller_agent` 之前，official_full 在 `agent_official` 之前（同一块）。关掉后 0注入 无调用方 agent 时回到零宽占位；已有显式开启的配置不被覆盖。

**按档开关**（`{official,official_full,zero,custom}: boolean`）：
- `agent_standing_presets`：是否写常驻约束，缺 map 或缺 key 视为关。控制台开关、预览与 Node 出站使用同一缺省语义。
- `agent_standing_hide_presets`：常驻约束是否从客户端 usage 中扣除，缺 map/key 视为开，独立于整档遮罩；未启用约束时不扣约束 token。cli-hop 0注入 同样生效。
- `persona_env_presets`：是否写 `{{env}}`，缺 map/key 视为开。官方完整的 `env_official` 不受此开关影响。
- `persona_hide_presets`：整档 usage 遮罩（billing / identity / agent / Environment 等 `hide:true` 块）。缺 key 时依次回落旧全局 `persona_hides`、该档模板的 `hide` 标记（默认 zero 开、其余关）。槽位单独指定人设时读该槽位档的开关；cli-hop 0注入 关掉后 CLI billing + Environment 计入 usage。

v1.3.82+ 原版 `wrap` 的 kin 分支只组装 `billing →（identity 布局的身份句）→ # Environment\n - Timezone: <kernel.json timezone> → Node/caller leftover`。它剥离重复 billing、身份句、`# Environment` 和 Kin/Crag 自产 persona，不再追加槽内 cwd、Platform、Notes 或默认 agent prompt。leftover 各块原文（包括首尾空白）按原顺序以双换行拼接；调用方真正的 `You are an agent for Claude Code...` 和 `Notes:` 不会被当作自产内容删除。常驻约束若启用，仍在 leftover 的 agent prompt 顶部。billing 的 `isSubagent: true`、`splitSysPromptPrefix` 断点与既有缓存 TTL 策略不因本修复改变。

调用方 `messages[].role=system` 和 tools / `tool_choice` 保留；`overlay_preset=off` 不挂 prompt-leak / identity / no-tools reminder。

四闸通过的官方 Claude Code 原生请求在 persona 入口直接返回：不 rewrite、不重复追加已有官方 system、不 park、不藏 usage。只有 UA 而没有官方 system 的请求不通过四闸，仍按第三方完整模板处理。

遗留 `persona_inject=rewrite|overwrite|append|none` 仍可用，但不是仓库配置默认值。`rewrite` 使用 KIN 短 agent + env；`overwrite` 使用完整 agent_prompt + continuation + Environment。system提示词页保存时三档写回 `official_prompt` / `official_full` / `zero`；自定义才保留旧 inject。

权威开关是 `routing.json` 的 `compatibility.persona_preset`（system提示词）与 `cache_ttl`（设置 → 协议）。`vms/<id>/run/kernel.json` 不是第二套面板：面板保存、槽位「跟随全局」、外部改写 `routing.json`，或虚拟机环境保存时区之后，才把解析结果投影进去（`persona_preset`、`system_layout`、`default_cache_ttl`、`timezone`）。`system_layout` 只有 `zero` 与 `identity`（`official` / `official_full` / `custom` 都是 `identity`）。字节没变不重写。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会在下一次投影时被盖掉。

`wrap-fixed` / `cc-fixed` 仍使用已批准的独立 CLI：caller system 快照按原块追加，不套用新版原版 CLI 的 leftover 拼接/按文本过滤。新版原版仍会过滤 `# Environment` 等文本前缀，不能将其部分保留修复视为等价的完整 caller 块保留。

面板预览表达 Node 给出的模板内容；cli-hop 最终线序以实际选定 CLI 为准，不把 Node 对象预览当成最终 wire 抓包。更新 CLI 二进制后需要替换槽内副本并重启相应 kernel/CLI；配置热读不能让旧进程自动加载新 ELF。删除旧环境文本后首次前缀会冷写，后续 cache_read 数值须实测，不能保证必然不低于旧值。0注入 + 常驻约束关闭 + 无调用方 agent 的真实模型可见输出须单独验收。

Go worker JSON 透传，不必因人设重建 worker。

### 缓存 TTL 与用量（HTTP 对齐 CLIProxy，cli-hop 独立策略）

HTTP 与 cli-hop 分层：以下显式 TTL/顺序/补齐规则用于 Node HTTP 转发。cli-hop 先清除 caller 缓存标记，再按实际选中数据面处理；不承诺保留 caller 的逐块缓存边界，但 caller 文本仍遵守各协议的保留约定。usage 保真与计价规则两条路径共用。

- 显式 `cache_control.ttl` 保留；OAuth 默认只把无 TTL 标记升级为 1h，API Key 默认保留 5m 语义。确认的原生 Claude Code 不做默认补齐。
- 顺序是 **tools → system → messages**，顶层自动缓存视为末尾边界。`1h → 5m` 合法；仅将 5m 后出现的 1h 降为 5m，不再把全请求降级。
- Node 在 system 覆盖工具前缀时不再额外打 tools 标记；消息填充只针对最后一个可缓存消息，跳过 assistant thinking 尾块。旧 `rewrite` 作为非破坏性填充处理，保留历史锚点；显式 `tail` 模式仍可清理消息锚点后只标记最后一个非 thinking 内容块。CLI hop 不走此 Node 注入器。
- 探测/标题辅助请求，以及未显式要求 1h 的子代理请求，使用不带 TTL 的 5m 标记。普通用户文本不能冒充内部 helper。
- `usage.cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens` 优先于扁平兼容字段；不会按请求配置重新分类。缺失/部分分项保留未知，不伪造 5m/1h token。
- 未分类缓存写入 token 的本地费用按较低的 5m 价格估算（`cache_creation_estimated=true`、`cache_creation_unclassified_tokens`），日志详情明确提示；这是本地标准价估算，不是 Anthropic 账单。已保存的历史分类不能无原始证据反推，本次不回写旧账单。
- 上游 `13222b2` 起，官方流量也解析 TTL；请求头 > 显式块 TTL > 菜单/凭证默认。按账号与出站会话固定首次选择，连续请求刷新空闲窗口，闲置超过对应 TTL 后可重新选择。该状态仅在进程内保存。
- 新原版 `wrap` 与 v186-r1 及后续版本的 `wrap-fixed` / `cc-fixed`：Node 写入尾消息及历史不少于 4 条时倒数第二个 user 的断点，跳过 thinking 块，显式传入选定账号/session 的 TTL（包括 `5m`），并设置 `preserve_cache_breakpoints=true / cache_ttl=null`，避免 kernel 再盖掉断点。CLI 从消息标记解析 TTL，再整理自产 system/tools 标记。HTTP 的非破坏性 `fill/rewrite` 不与该规则混用。
- 原版 `cc` / `crag` 本体未升级，仍清理 Node 标记并使用 `preserve_cache_breakpoints=false / cache_ttl=<选定值>`。两个 v186-r1 fixed 已通过本地源码/打包检查，声明 `node_dual_anchor_v1`：wrap 在新基底保留 caller 独立块；CC 在已验收修复版上合入 system/tools TTL 重定时、thinking 不打点及最多四个 marker，system/初始化修复未撤销。fixed 继续共享原生 kernel，包内不复制 kernel。必须同步新 CLI 并重启，不能仅保存 Node 配置便假定旧进程具备新能力；未宣称 Linux/云端新组合已实测。
- `cache_continuity` 只描述 Node 对象的首差及断点，标明 `wire_observed=false`；它不是云端 wire 抓包。真实新二进制效果需要运行端数据，不能据此承诺缓存命中或短答已根治。

已有部署的 `cache_ttl: 1h/5m` 不自动改成 auto；需要在设置里主动选“自动（按凭证）”。

### usage 遮罩

Claude Chat 不做 Node usage 遮罩，客户端用量来自实际合并的上游观测值。其他适用非官方协议保留原有人设遮罩；官方 CC 不遮罩。缓存用量字段是观测统计，不是订阅额度节省的保证。

自 v189 起 fixed 保留上述缓存与 system 行为，并同步上游 native `max_tokens` 终态修复：触顶仍应返回真实终态和用量，不再被 CLI 的交互式恢复逻辑额外改成 API 错误；不是强制续写或扩张输出预算。原生 kernel 仍共享原版，未私改。

v191 fixed 同步 native 异步 cancel/ping、原始错误和禁止 CLI 隐式重试/fallback。caller snapshot 和缓存代码保持；CC 新 `onError` 桥只传错误对象，不进入最终 API body。Node 每次物理派发有独立 request_id，取消通过已鉴权内部路由点名；取消回包读取失败只记录告警，不可把最佳努力取消变成 Node 进程异常。Node 未提交恢复/换号仍受既有次数限制，显式取消/已输出后禁止重放。故障引起的容器恢复归上游有界 watchdog，保留其 CC/crag 例外，不由请求错误绕过重启预算。

## thinking 与 max_tokens

`max_tokens` 是 thinking 与可见输出等共享的**总输出预算**，不是单独的 `thinking.budget_tokens`。调用方有值则不覆盖；缺失时 OAuth 默认 **128000**。绝对上限 128000。仅当超过模型 `max_tokens_cap` 时 `applyMaxTokensCap` 下调。

| 模型 | thinking |
|------|----------|
| Haiku / Claude 4.5 及更早 | 拒绝 `adaptive` → `enabled` + budget |
| Claude 5 / Fable 5 / Mythos / Opus 4.7+ | 保留 `thinking.enabled`；缺省时非官方可补 `adaptive` + `display: omitted` |
| 缺 `context_management` | 补 `clear_thinking_20251015`（需带对应 beta） |

非官方缺省还可补 `output_config.effort=high`，**不覆盖**已有 thinking / max_tokens。最新 main 在 unofficial 缺 `thinking.display` 时补 `omitted`。

### Chat Completions：CPA 转换与 caller system 保留

参考固定为 CLIProxyAPI `c404af96ebacedf8168b3c2bdbf4449a21cd1c1e`，许可见 `src/lib/protocol/CLIProxyAPI-LICENSE.txt`。`test/support/cpa-oracle/` 使用真实 CPA 注册转换器、SDK 摘要处理、thinking 应用器和流式/缓冲响应转换器生成对照样例；不是仅移植辅助函数后宣称最终链路相同。

- 每条 system/developer 字符串对应一个 Messages system text 块；数组中的支持文本块保持顺序、原文和边界，包括空白与空字符串。保留 string/input_text/output_text 扩展；不支持的非文本 system 形状返回 400，不静默删除。Chat 的 system/developer 映射到顶层 system 数组，而非原封不动保留 Chat 的 role 布局。
- Chat 不经过 Node persona/overlay、前缀/指纹/标题匹配删除、system 拼接、`<total_tokens>` 改写或 CCH 文本重写。`# Environment`、`You are Claude Code`、SDK 字样都不是删除 caller 文本的理由。显式配置的 operator intercept 仍有独立权威；不是自动清洗。
- `response_format` 按 CPA 追加独立的 JSON/JSON schema system 指令，不覆盖 caller 块，不再转成 Chat 的 `output_config.format`。输入已解析时，schema 的生成文本使用 JSON.stringify，无法承诺原始 schema JSON 的词法空白；caller 的文本空白不受影响。
- 函数工具、schema、tool_choice/allowed_tools、工具 ID/重复结果、采样和 stop 按 CPA 映射。默认 max_tokens 为 32000；max_tokens 优先于 max_completion_tokens。转换器不自动添加首条 user 或注入 native search。随后会应用 main 新增的 `compatibility.min_max_tokens` 策略：默认开启、下限 128，可在探测设置关闭；关闭后小值原样保留。缓存 helper 分类使用 operator 拦截接受后、提高下限前的 max_tokens，不让提高下限污染普通会话 TTL。CPA 未支持的 speed/service_tier/root thinking/root output_config/stop_sequences 等扩展不在此映射中。
- 已知模型按固定能力快照处理顶层 `reasoning_effort`、摘要可见性与模型后缀，后缀优先于 body；body auto 与 suffix auto 分开处理。强制工具选择移除 thinking/effort，不擅自把选择改成 auto。显式有效 max 不会被默认 high 覆盖。CPA 未列出的 vm 合法模型保留本地能力兼容行为，不能称为 CPA 支持证明。旧模型 budget 与 Haiku 的 CLI 禁用规则分别属于模型映射和 native 兼容边界。
- SSE 使用真实上游 ID、请求模型和固定创建时间；JSON 使用上游声明模型与 SSE 累积结果。客户端工具在 block_stop 完整发出，未知工具索引不污染 tool0，空参数为 `{}`，工具原始 JSON 字符串不由解析后的对象重建。缓存详情为 cached_tokens / cached_creation_tokens / cache_write_tokens。
- 保留比 CPA 更严格的内容与终态保护：初始文本/工具内容不丢；非流式保留多 Message 累积内容；流式重复开始/终态后正文显式失败；错误、负 metadata、取消和已提交禁止重放不退化。真实 length/refusal 不被工具存在掩盖。仅 include_usage=true 提供成功 EOF 的空 choices 最终用量帧，最终 native 用量优先。

system 提示词页的模板/预览属于 Node 人设层：上面的 Chat 特例仍跳过这些注入和遮罩，不把预览冒充 fixed CC 的实际出站请求。新增 Messages 预热拦截也不应用于 `/v1/chat/completions`。

**边界：** Node 发给 worker 的 caller 文本/块可检验；native kernel/CLI 仍负责最终身份、提示词与缓存布局。Node 继续清除 cli-hop 的 cache_control 并单独传 TTL，不能承诺原样逐块 TTL 或最终 Anthropic wire。metadata 身份仍按选定账号/会话构建，Haiku 的 CLI 兼容策略保留。`max` 不保证长答或格式服从；真实 end_turn 不自动续写。非 Chat 转换保留各自现有策略。

压测默认预算 32000。虚拟机测试未传 `max_tokens` 时用模型策略 `max_tokens_default`，再不行用 64（健康探测 hello 同口径）。

## beta 与 1M

- 存盘的 `kin-cc-headers.json` **只**留 `anthropic-version` / `anthropic-beta`。UA、stainless、session、accept-language 只出槽位指纹 + 代码 pin。
- 出站 UA 锁 `claude-cli/2.1.284 (external, sdk-cli)`。Stainless 仍是 `js` / `Linux` / `x64` / `node` / `v26.3.0` / `0.112.1`，`retry-count=0`，`timeout=600`。
- 非官方裸模型 **不注入、不重放** `context-1m-2025-08-07`。入站末尾 `[1m]`（如 `claude-sonnet-5[1m]`）在矩阵允许时注入该 beta（官方/非官方都算）。
- 官方 CC：矩阵 `betas.pass_context_1m` 决定透传/剥离；未入库时回退 `defaults.context_1m_whitelist`（seed：`sonnet-5*`）。同一 `[1m]` 后缀在允许时也会注入。
- 出站 `model` 去掉 `[1m]` 后缀。
- 缺 `context-management` beta 时剥掉 body 同名字段。
- 缺 beta 时不带对应高级字段；短 beta 按 mimicry 集合补齐（官方路径）。

模型目录权威是面板 `model_policy`（`GET/PUT /api/panel/model-policy`）。`GET /v1/models` 与 `validateOfficialModel` 读这份集合，**禁止** hop 槽位 `/internal/v1/models`。

## web_search

Claude Chat 采用 CPA function-tools 映射，不自动映射或注入 native web_search。下述是其他适用协议/人设与显式 helper 的行为。

五种人设方案只在末轮 user 提示词出现「搜索」/`search`/`web search` 时注入 `{type: web_search_20250305, name: web_search}`。调用方已声明则原样转发。`web_search=false` / `x-kin-web-search: false` / `tool_choice=none` 不补。官方 Claude Code 入站不注入。

Rikka / 客户端 `search_web`、`scrape_web` **不是** Anthropic 自带搜索：出站保持 `{name,description,input_schema}`，模型 `tool_use search_web` 由 App 执行。已有 `search_web` 时 `ensureClaudeWebSearch` 不再叠原生 `web_search`。

出站只有 `{type,name}` 存根（约 18 token），但 schema 在 Anthropic 侧，**实际计费约 2794 token**（vm-05 zero 基线实测：同形状请求带工具 2837、不带 43，两次复测一致）。因此客户端 usage 按 `SERVER_TOOL_INPUT_TOKENS` 里的真实 schema 成本扣，而不是按出站字节估算，否则第三方能从 `input_tokens` 看出网关注入了搜索工具。调用方自己声明的 `web_search` 不扣，照常可见。


## 清洗与整流

`sanitizeInboundBody` / `request-rectifier`：

- 非法 Anthropic `role` 按 Sub2API 清洗
- 非官方补 tool 对、短签名预过滤
- Claude Chat 的 `response_format` → 独立生成的 system 指令；其他适用转换保留自身结构化输出策略；`refusal` → `content_filter`
- 空 refusal 记 `content_filter_refusal`

## thinking 历史与签名

非 Chat 通用路径出站前 `stripInvalidThinkingBlocks` 丢两类历史 thinking 块，**顺序是先文本后签名**（Chat 使用上方独立转换，不回放无签名 reasoning_content）：

1. `thinking` 文本为空的（非官方被补 `display: omitted` 后 haiku 只回签名不回文本，这类块出站前就没了）
2. 签名短于 24 字符或是 dummy 的（`hasUsableThinkingSignature`，兜第三方截断的 SSE 签名）

HTTP hop 保留 CLIProxy 风格的显式 TTL 与合法混合顺序；cli-hop 的缓存断点按实际数据面选择，见上节。公开 CPA Chat 不执行通用内容清洗，不因文本特征删除 caller system 或 thinking 历史。Node 出站 JSON 不是最终 wire，native CLI 的最终请求需真实跟踪验证；两条路径均不按请求 TTL 重分类上游 usage。

长度够的签名原样转发，由 Anthropic 验。上游**严格验签名自身完整性**：乱码签名回 400 `Invalid \`signature\` in \`thinking\` block`。但签名**不与 thinking 文本绑定、也不与模型绑定** —— 真签名配改写过的文本、或 sonnet 的签名打到 opus / haiku，上游都 200（2026-08-28 实测，见 `测试结果/2026-08-28-thinking-signature/`）。

HTTP hop 那个 400 默认原样透传。`routing.failover.signature_repair=true`（设置页「探测 → 签名修复」）才走 `signature_repairable` 的 `repair-and-retry`（剥 thinking 历史 + 删 `body.thinking` 后重试一次），客户端只看到 200。**cli-hop / rust 槽始终走这一次同槽降级重试**（预过滤挡不住换票或长乱码签）；重试不得再补 `thinking.adaptive`。

## 健康探测缓存

`routing.health_probe`：

- **`enabled` 默认 `false`**：不开就没有定时探测、也没有缓存回放，第三方探活按普通推理落到真实槽位
- 开启后才做定时真实 Messages（默认 10min）。hello 通过 `personaMode=overwrite` 生成完整 agent_prompt + continuation + Environment，并携带官方 UA / metadata 经站点 `/v1/messages` 官方通道钉槽发送
- 匹配的第三方短请求（`hi`/`hello`/`ping`/`test`/`健康`，无 system/tools、小 `max_tokens`）在占并发前回放缓存的官方 Messages 体（真实 `id` / `content` / `usage`），不本地合成 `msg_health_*`
- `cache_ttl_sec` 默认 900；`cache_models` 空=拦全部入站模型
- 无有效缓存且 `fail_closed` 时 503
- 设置页「探测」可热改；`GET/POST /api/panel/health-probe`

## 身份出站

选槽之后：

- `device_id`：64 hex 原样出站（创建生成值或官方 `machineID`）。遗留 UUID 槽仍 sha256。官方初装成功后存储值被 `~/.claude.json` `machineID` 覆盖
- `session_id`：官方 CC 保留调用方原值；非官方用 CRS hash
- `metadata.user_id`：官方 `userID` + 凭证 email（不读残留 `.claude/.claude.json`）
- guest locale / tz 进 fingerprint；`/etc/machine-id` 是 `guest_machine_id`（systemd 32 hex）；出站 hostname 是 `<distro>-<4hex>`

## 相关头

| 头 | 作用 |
|----|------|
| `x-kin-delivery: verified` | 缓冲到终态 |
| `x-kin-cache-ttl: 1h` | 出站 cache 升 1h |
| `x-kin-vm` | 仅 master：钉槽（虚拟机测试 loopback） |
| `x-session-id` 等 | sticky 键，见 `routing.sticky` |
| `x-kin-debug` / `x-kin-log` | 单请求日志模式覆盖 |
| `X-Request-ID` | 普通请求回写；原始诊断请求改用唯一服务器 ID，原值另存 caller_request_id |

Go worker 用 trailer `X-Kin-Usage` / `X-Kin-Model` / `X-Kin-Stop-Reason` 回传合并 usage，与非流同一终态记账。

临时原始日志只支持明确 `stream:false` 的 Claude Chat；启用方式、Node 捕获边界、权限、保留/导出限制及原始/派生字段见 [PANEL_API.md](PANEL_API.md#临时原始非流式诊断2026-09-24)。
