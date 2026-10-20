# 协议行为

对齐 `src/lib/protocol/*`、`src/lib/identity/crs-persona.mjs` 的 `handleProtocol`。Chat 转换小节于 2026-09-24 更新；其余历史运行说明应结合当前源码核对。

进槽前的封控拦截不在本文，见 [RISK.md](RISK.md)。

Claude 槽位上游 hop 使用 `stream:true`；客户端 `stream:false` 仍由 Node 读取上游 SSE、校验终态并聚合成 JSON。原始 SSE、组装后的 Messages JSON 与客户端 Chat JSON 是不同层的数据；内核返回的末尾 metadata 也参与最终校验与用量合并。

## 官方 Claude Code 判定

`isOfficialClaudeCodeTraffic(headers, body)` 四闸：

| 条件 | 实现 |
|------|------|
| UA | `^claude-cli/\d+\.\d+\.\d+`（sub2api 同款前缀；vscode / cowork / desktop 都算） |
| `metadata.user_id` | 合法官方 user id |
| tools | 不能是 OpenAI `{type:function}` / `tool_choice.type=function`。`/v1/messages` 上这种 tools 会先转 Anthropic，但仍判非官方 |
| system | 含 `x-anthropic-billing-header:`、官方 `cc_entrypoint`（`cli` / `sdk-cli` / `vscode` / `cowork` / `desktop`）、或官方身份行（含 `You are Claude Code` / `Claude Agent SDK` 变体）。`local-agent` 仅在 UA 含对应入口和 Agent SDK、平台为 `desktop_app` 且客户端版本有效时继续原有官方校验；OMP 专属特征仍优先排除 |

四闸不全 → 非官方；非 Chat 路径按相应人设处理。Claude Chat 路径不再依赖此分类来清洗或改写 caller system。虚拟机测试入站会先铺 4 块官方 system + 官方 UA，因此分类为 `claude_code_official`。

## 非官方人设

**Claude Chat 特例：** `/v1/chat/completions` 跳过 Node 层人设改写、overlay/search 自动注入和 usage 遮罩，见下方 CPA 小节。槽位 kernel 的人设配置仍然存在，其最终处理不等同于 Node 层保证。

每次请求热读 `routing.compatibility`（改盘无需重启 Node）。仓库配置为：

| 键 | 值 | 含义 |
|----|----|------|
| `persona_preset` | `official_full` | 使用独立的完整官方模板；`official` 保留原有官方提示词 |
| `overlay_preset` | `off` | 不向首条 user 注入 overlay |
| `persona_park` | `false` | 与 `overlay_preset=off` 对齐 |
| `cache_ttl` | `auto` | Node 新增或自产缺失 TTL 标记的默认值按凭证选择：OAuth/Setup Token 1h、API Key 5m；请求头参与首次会话选择，不覆盖 native 透传 caller 的显式或缺失 TTL |

**official 模板**保留 billing + Agent SDK identity + 可选 caller_agent / caller_system，并在 agent 块之后写槽位 `# Environment`（`{{env}}`，只含 `Timezone: <槽位时区>`，不新增缓存断点；agent 块 TTL 跟随缓存策略）；不会自动追加完整 agent prompt。

**official_full 模板**在相同前缀后固定追加完整 `agent_official`，模板只带 ephemeral 标记、不自定 TTL；调用方 system 作为末块追加。zero 也保留 ephemeral 占位块，**0 注入不等于关闭缓存**。已保存模板内的显式 TTL 仍保留；若希望改为自动，请清空该模板块的 TTL 或恢复新默认模板。

**zero 模板**在 agent 槽之后写 `{{env}}` 块（`hide`、`drop_if_empty`、不挂 cache），只含槽位时区。自定义档空模板回落 official，同样带 `{{env}}`。live 已自定义的 zero 模板不会自动多出这一块，需在 system提示词页「恢复预设」。

**agent prompt 常驻约束**：默认不启用。`compatibility.agent_standing` 仍保留内置 distillation / 思维链 / NSFW 四行文本（显式空串 = 不加，上限 2000 字符），只有当前档的 `agent_standing_presets` 显式为 `true` 才经 `{{agent_standing}}` 写成 agent 块第一段：official / 0注入 在 `caller_agent` 之前，official_full 在 `agent_official` 之前（同一块）。关掉后 0注入 无调用方 agent 时回到零宽占位；已有显式开启的配置不被覆盖。

**按档开关**（`{official,official_full,zero,custom}: boolean`）：
- `agent_standing_presets`：是否写常驻约束，缺 map 或缺 key 视为关。控制台开关、预览与 Node 出站使用同一缺省语义。
- `agent_standing_hide_presets`：常驻约束是否从客户端 usage 中扣除，缺 map/key 视为开，独立于整档遮罩；未启用约束时不扣约束 token。cli-hop 0注入 同样生效。
- `persona_env_presets`：是否写生成的 `{{env}}` / `{{env_timezone_only}}` / `{{env_official}}` 及槽位 `{{timezone}}`，缺 map/key 视为开。关闭时删除生成的整个环境块（含官方完整档 continuation 环境块），不留下带 cache 的零宽环境占位；调用方或自定义模板字面写入的 Environment / 时区保留，不用槽位时区覆盖。控制台预览与最终出站一致，各档独立。
- `persona_hide_presets`：整档 usage 遮罩（billing / identity / agent / Environment 等 `hide:true` 块）。缺 key 时依次回落旧全局 `persona_hides`、该档模板的 `hide` 标记（默认 zero 开、其余关）。槽位单独指定人设时读该槽位档的开关；cli-hop 0注入 关掉后 CLI billing + Environment 计入 usage。

native cli-hop 优先完整保留 Node 已组装、带 billing 的 wire system，不在后面重加槽内 Environment。Node 关闭当前档 Environment 时，CLI 预处理保留调用方环境原文，HTTP 出站也跳过槽位时区刷新；没有调用方环境就不发送 Environment 块。启用时沿用原有槽位环境规则。调用方真正的 `You are an agent for Claude Code...` 和 `Notes:` 不会被当作自产内容删除。原版 CLI 无 Node billed wire system 时仍沿用自己的布局；fixed 另保留 caller 独立快照。槽位必须使用支持这些合同的 CLI 产物，旧 ELF 不会因修改控制面配置而自动更新。

调用方 `messages[].role=system` 和 tools / `tool_choice` 保留；`overlay_preset=off` 不挂 prompt-leak / identity / no-tools reminder。

四闸通过的官方 Claude Code 原生请求在 persona 入口直接返回：不 rewrite、不重复追加已有官方 system、不 park、不藏 usage。只有 UA 而没有官方 system 的请求不通过四闸，仍按第三方完整模板处理。

遗留 `persona_inject=rewrite|overwrite|append|none` 仍可用，但不是仓库配置默认值。`rewrite` 使用 KIN 短 agent + env；`overwrite` 使用完整 agent_prompt + continuation + Environment。system提示词页保存时三档写回 `official_prompt` / `official_full` / `zero`；自定义才保留旧 inject。

权威开关是 `routing.json` 的 `compatibility.persona_preset`（system提示词）与 `cache_ttl`（设置 → 协议 → 提示词缓存 → 默认缓存写入 TTL，可选 `auto` / `5m` / `1h`，本 fork 缺省 `auto`，点击「保存」生效）。该值仅是默认值，不覆盖请求头、请求显式 TTL、已有会话锁定值或 system 模板显式 TTL；官方透传的调用方 marker 及缺失 TTL 保持原样。`vms/<id>/run/kernel.json` 不是第二套面板：面板保存、槽位「跟随全局」、外部改写 `routing.json`，或虚拟机环境保存时区之后，才把解析结果投影进去（`persona_preset`、`system_layout`、`default_cache_ttl`、`timezone`）。`system_layout` 只有 `zero` 与 `identity`（`official` / `official_full` / `custom` 都是 `identity`）。字节没变不重写。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会在下一次投影时被盖掉。

`wrap-fixed` / `cc-fixed` 仍使用已批准的独立 CLI：caller system 快照按原块追加，不套用新版原版 CLI 的 leftover 拼接/按文本过滤。新版原版仍会过滤 `# Environment` 等文本前缀，不能将其部分保留修复视为等价的完整 caller 块保留。

面板预览表达 Node 给出的模板内容；cli-hop 最终线序以实际选定 CLI 为准，不把 Node 对象预览当成最终 wire 抓包。更新 CLI 二进制后需要替换槽内副本并重启相应 kernel/CLI；配置热读不能让旧进程自动加载新 ELF。删除旧环境文本后首次前缀会冷写，后续 cache_read 数值须实测，不能保证必然不低于旧值。0注入 + 常驻约束关闭 + 无调用方 agent 的真实模型可见输出须单独验收。

Go worker JSON 透传，不必因人设重建 worker。

### 缓存 TTL 与用量（HTTP 对齐 CLIProxy，cli-hop 独立策略）

HTTP 与 cli-hop 分层：以下显式 TTL/顺序/补齐规则用于 Node HTTP 转发。官方 native 透传和公开 CPA Chat 的 caller 缓存标记按原位置、显式或缺失 TTL 保留并校验；非透传 native 请求仍清理并按选中数据面写入 Node 断点。caller 文本遵守各协议的保留约定，usage 保真与计价规则两条路径共用。

- HTTP 非透传路径保留显式 `cache_control.ttl`；OAuth 默认只把无 TTL 标记升级为 1h，API Key 默认保留 5m 语义。官方 native 透传和公开 CPA Chat 不采用此补齐规则：caller 缺失 TTL 保持缺失，不被菜单或请求头改写。
- 顺序是 **tools → system → messages**，顶层自动缓存视为末尾边界。`1h → 5m` 合法；仅将 5m 后出现的 1h 降为 5m，不再把全请求降级。
- Node 在 system 覆盖工具前缀时不再额外打 tools 标记；消息填充只针对最后一个可缓存消息，跳过 assistant thinking 尾块。旧 `rewrite` 作为非破坏性填充处理，保留历史锚点；显式 `tail` 模式仍可清理消息锚点后只标记最后一个非 thinking 内容块。CLI hop 不走此 Node 注入器。
- 探测/标题辅助请求，以及未显式要求 1h 的子代理请求，使用不带 TTL 的 5m 标记。普通用户文本不能冒充内部 helper。
- `usage.cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens` 优先于扁平兼容字段；不会按请求配置重新分类。缺失/部分分项保留未知，不伪造 5m/1h token。
- 未分类缓存写入 token 的本地费用按较低的 5m 价格估算（`cache_creation_estimated=true`、`cache_creation_unclassified_tokens`），日志详情明确提示；这是本地标准价估算，不是 Anthropic 账单。已保存的历史分类不能无原始证据反推，本次不回写旧账单。
- 上游 `13222b2` 起，官方流量也解析 TTL；请求头 > 显式块 TTL > 菜单/凭证默认。按账号与出站会话固定首次选择，连续请求刷新空闲窗口，闲置超过对应 TTL 后可重新选择。该状态仅在进程内保存。
- 当前原版 `wrap` 与两个 `v1201-r1` fixed：公开 CPA Chat 已有 caller marker 时，Node 保留原位置、显式或缺失 TTL，不添点或覆盖；没有任何 marker 时才生成尾消息及历史不少于 4 条时倒数第二个 user 的双断点，跳过 thinking，使用选定账号/session TTL。官方 native 透传也保留 caller 标记。kernel hint 为空时不能反推请求为 5m；日志另记所选策略，计费仍看实际用量。关闭透传的非 Chat 请求沿用 Node rewrite。HTTP 的非破坏性整流与 native 所有权规则分开。
- 两个 fixed 声明 `caller_markers_owned_v2`：保留 caller system 尾块、tools 前缀和 wire messages 中的 marker，仅为自产点补 TTL、按剩余容量裁剪自产点。caller 原文、空白、空块和独立边界不被过滤或拼接。原版 CC / Crag 本体没有本轮兼容更新，不能据控制面字段承诺其最终 wire 等价；不会因此将 fixed 静默换成原版。此前 v186 的统一双断点/TTL 行为属于历史规则，不能套到当前有 caller marker 的请求。fixed 继续共享原生 kernel，包内不复制 kernel；部署须同步同一 fixed 并重启，旧进程不会因保存配置自动换 ELF。本地源码/打包控制不等于 Linux/云端验收。
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
- 已知模型按固定能力快照处理顶层 `reasoning_effort`、摘要可见性与模型后缀，后缀优先于 body；body auto 与 suffix auto 分开处理。强制工具选择移除 thinking/effort，不擅自把选择改成 auto。显式有效 max 不会被默认 high 覆盖。OAuth 槽和 managed API 后端均先解析数字后缀为 thinking 参数，再以基础模型校验/选择端点；后缀不进入最终 API model，日志仍保留 caller 模型名。CPA 未列出的 vm 合法模型保留本地能力兼容行为，不能称为 CPA 支持证明。旧模型 budget 与 Haiku 的 CLI 禁用规则分别属于模型映射和 native 兼容边界。
- SSE 使用真实上游 ID、请求模型和固定创建时间；JSON 使用上游声明模型与 SSE 累积结果。客户端工具在 block_stop 完整发出，未知工具索引不污染 tool0，空参数为 `{}`，工具原始 JSON 字符串不由解析后的对象重建。缓存详情为 cached_tokens / cached_creation_tokens / cache_write_tokens。
- 保留比 CPA 更严格的内容与终态保护：初始文本/工具内容不丢；非流式保留多 Message 累积内容；流式重复开始/终态后正文显式失败；错误、负 metadata、取消和已提交禁止重放不退化。真实 length/refusal 不被工具存在掩盖。仅 include_usage=true 提供成功 EOF 的空 choices 最终用量帧，最终 native 用量优先。

system 提示词页的模板/预览属于 Node 人设层：上面的 Chat 特例仍跳过这些注入和遮罩，不把预览冒充 fixed CC 的实际出站请求。新增 Messages 预热拦截也不应用于 `/v1/chat/completions`。

**边界：** Node 发给 worker 的 caller 文本/块可检验；native kernel/CLI 仍负责最终身份、提示词与缓存布局。公开 CPA Chat 有 caller marker 时在 Node 保留标记，无标记的 wrap/fixed 请求才生成双锚点；v1201 fixed 保留 caller 缓存所有权，不能把 Node 对象当作最终 Anthropic wire 证据。非透传非 Chat 仍清理并重写自产点。metadata 身份按选定账号/会话构建，Haiku 的 CLI 兼容策略保留。`max` 不保证长答或格式服从；真实 end_turn 不自动续写。非 Chat 转换保留各自现有策略。

虚拟机测试未传 `max_tokens` 时用模型策略 `max_tokens_default`，再不行用 64（健康探测 hello 同口径）。

## beta 与 1M

- 存盘的 `kin-cc-headers.json` **只**留 `anthropic-version` / `anthropic-beta`。UA、stainless、session、accept-language 只出槽位指纹 + 代码 pin。
- Node 出站 UA 锁 `claude-cli/2.1.296 (external, sdk-cli)`；fixed CC 本体仍是自身运行时，不能把 Node 指纹升级说成整个 CC SDK 已替换。Stainless 仍是 `js` / `Linux` / `x64` / `node` / `v26.3.0` / `0.112.1`，`retry-count=0`，`timeout=600`。
- 非官方裸模型 **不注入、不重放** `context-1m-2025-08-07`。入站末尾 `[1m]`（如 `claude-sonnet-5[1m]`）在矩阵允许时注入该 beta（官方/非官方都算）。
- 官方 CC：矩阵 `betas.pass_context_1m` 决定透传/剥离；未入库时回退 `defaults.context_1m_whitelist`（seed：`sonnet-5*`）。同一 `[1m]` 后缀在允许时也会注入。
- 出站 `model` 去掉 `[1m]` 后缀。
- 缺 `context-management` beta 时剥掉 body 同名字段。
- 缺 beta 时不带对应高级字段；短 beta 按 mimicry 集合补齐（官方路径）。

模型目录权威是面板 `model_policy`（`GET/PUT /api/panel/model-policy`）。`GET /v1/models` 与 `validateOfficialModel` 读这份集合，**禁止** hop 槽位 `/internal/v1/models`。`GET /v1/models` 只列出该 key 的 `group_type` 能调度的模型：`openai` 只列 GPT，`anthropic` 只列 Claude，`all` 与 master 两者都列。

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

## 搜索历史重放

旧 `server_tool_use` / `web_search_tool_result` / 加密 `search_result` 被当前上游拒绝时，`search_repairable` 仍只在该请求内做一次纯文本修复重试；这不是 `slot_busy`，每个执行 lease 都在 hop 的 `finally` 释放，不清除原会话 pin。

若同一 VM / 账号 / 模型 / 凭据代际的修复跳确认成功，`FailoverRunner` 在进程内记录该入站会话的精确搜索历史和工具契约指纹。后续回合仅追加普通消息、指纹不变时，首跳直接复用既有修复，不再重复发送已知失败的历史。首次遇到、内容改变、新增搜索、不同会话或执行上下文均原样尝试；修复失败不记录。已知修复后来仍被拒绝时，返回真实错误并丢弃记录，不重发同一份展开体。

记录只保留指纹，不保存历史正文；最多 512 项，空闲 1 小时失效，与 Anthropic cache TTL 无关。Node 重启后重新学习，因此首个携带旧历史的请求仍可能经历一次 400 → 修复 → 200。无需数据库迁移，不修改生产 persona、凭据、容器或 kernel/CLI。

## thinking 历史与签名

非 Chat 通用路径出站前 `stripInvalidThinkingBlocks` 保留可回放的历史思维块；公开 Chat 使用上方独立 CPA 转换，不凭文本长度删除有效签名块，也不把无签名 reasoning_content 冒充可回放的 thinking：

1. `thinking` 即使文本为空，只要有完整签名也保留；这是 `display: omitted` 的正常响应形态。
2. Opus / Sonnet / Haiku 5.5 按 sub2api：非空且非 dummy 的签名都算有效，不看长度；`redacted_thinking` 有 `data` 就留，没有 `data` 时再看签名。历史里只要有一块无效，整段 thinking / `redacted_thinking` 都拆掉，只留正文；拆完没有内容的轮删掉。全部有效时不拆。
3. 更早的型号仍逐块过滤：签名短于 24、空签名、dummy 签名删掉，合法签名块留下。`redacted_thinking` 不看 `data`，只在签名达到 24 字符时留。
4. 保留路径（cli-hop 首跳，以及默认 HTTP hop）不走上面的拆链，只在 `stripInvalidThinkingBlocks` 的这一支里处理：`redacted_thinking` 不看 `data` 和签名，原样留。`thinking` 只有签名可用（非空、不少于 24、非 dummy）才留，空正文也留；缺失、空、短于 24、dummy 的删掉，不再补 `signature: ""`。不走保留路径时，`redacted_thinking` 仍按上面第 2、3 条删。当前没有按账号归属过滤签名的步骤。

非 Chat HTTP hop 与 cli-hop（`prepareCliHopBody`）共用内容预过滤，但缓存职责不同。cli-hop 首跳保留签名可用的 thinking 指纹，没有可用签名的删掉；签名修复重试才清除其余块。官方家族开启 `official_cc_passthrough` 时，Node 保留 system/tools/messages 的 caller marker、显式 TTL、缺失 TTL 和位置，不添点、不裁剪；超过四点、thinking marker、非法 TTL 或 5m（含缺失）后出现 1h，在调度前返回 `400 invalid_cache_control`。公开 CPA Chat 不执行通用内容清洗；HTTP 保留独立的非破坏性 TTL 整流。Node 出站 JSON 不是最终 wire，native CLI 的最终请求需真实跟踪验证；两条路径均不按请求 TTL 重分类上游 usage。

关闭透传或非官方请求仍走 Node rewrite：清除 caller marker，生成最后消息及 `messages.length>=4` 时倒数第二 user 的点，TTL 用入站会话 pin 值。应用 persona 后，模板显式 TTL 保留，只补自产缺失 TTL；超额时优先删 tools、system 尾部的自产点。非法模板返回 request-scoped 400，零上游执行，不换号、不冷却。

native CLI `2.1.296` 保留带 billing 的 wire system（含官方 CLI / 子代理布局）、wire tools 和 wire messages，不自动给最后一个 tool 加点；caller tool 的缺失 TTL 也保持缺失。仅对 CLI 自有 marker 补 TTL，优先请求显式 TTL（混合时 5m）→ slot `kernel.json.default_cache_ttl` → 1h，并按保留内容占用后的剩余预算裁剪。Rust kernel 不增删 marker、不重打 last、不自动降级 TTL。Node native envelope 不用菜单 TTL 重分类上游 usage，日志/计费保留真实 5m/1h 分桶。Node 对象不等于最终 wire；HTTP hop 原有独立缓存整流不变。

长度够的签名原样转发，由 Anthropic 验。5.5 的非 dummy 签名在非保留路径原样转发，不按 24 字符预过滤；保留路径仍要求不少于 24。签名是 opaque 加密内容，当前模型 / 账户 / 会话前缀不匹配时可能被丢弃或返回 400 `Invalid \`signature\` in \`thinking\` block`。网关不伪造真实签名，也不给缺签名的块补空字段。切换账号时不改写已有签名；`cli-node` 仍按现有登录 / fallback 逻辑清理签名块。

`routing.failover.signature_repair=true`（设置页「探测 → 签名修复」）才走 `signature_repairable` 的 `repair-and-retry`（剥 thinking 历史 + 删 `body.thinking` 后重试一次），客户端只看到 200。关闭时包括 cli-hop 在内都原样透传 400；`cli-node` 自身行为不受该面板开关改变。

`routing.compatibility.thinking_display` 默认 `summarized`（设置 → 协议 → thinking 显示；缺省即开，显式 `passthrough` 关闭）。只改已经打开的 thinking（`adaptive` / `enabled`）：`omitted`、`updates`，以及 Opus 4.7+、5 系列、Haiku 5.5、Fable、Mythos 上没写 display 的请求，出站改成 `summarized`。其它值、`disabled`、没开 thinking 不动。改写在 beta 计算之前，所以被改掉的 `updates` 不再带 `thinking-display-updates-2026-08-18`。`passthrough` 时 `updates` 仍只在出站 beta 声明该 token 时保留，否则降成 `omitted`。公开 CPA Chat 与分类器请求不经过这条通用出站改写；Chat 仍由其已验证的 reasoning_effort/后缀转换决定 display，不用面板摘要偏好覆盖 caller 意图。

## 健康探测缓存

`routing.health_probe`：

- **`enabled` 默认 `false`**：不开就没有定时探测、也没有缓存回放，第三方探活按普通推理落到真实槽位
- **`probe_all_slots` 默认 `false`**：关闭时定时探测在首个成功槽后停止（early-stop）；开启后每个间隔对所有可调度槽各探一次（`concurrency` 上限、工作时段、冷却、凭证排除仍生效），列表顺序中首个成功仍写入缓存
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
- guest locale / tz 进 fingerprint；`/etc/machine-id` 是 `guest_machine_id`（systemd 32 hex）。新槽主机名与 machine-id 来自私有 `kin-computer`，不再限定 `<distro>-<4hex>`；已有容器启动时保留原身份。本机新建容器发布计算机身份挂载，远端槽位仍使用原有身份传输路径。

## 相关头

| 头 | 作用 |
|----|------|
| `x-kin-delivery: verified` | 缓冲到终态 |
| `x-kin-cache-ttl: 1h` | Node 重写模式的首次会话 TTL 选择；不覆盖 native 透传 caller / 模板显式 TTL |
| `x-kin-vm` | 仅 master：钉槽（虚拟机测试 loopback） |
| `x-session-id` 等 | sticky 键，见 `routing.sticky` |
| `x-kin-debug` / `x-kin-log` | 单请求日志模式覆盖 |
| `X-Request-ID` | 普通请求回写；原始诊断请求改用唯一服务器 ID，原值另存 caller_request_id |

Go worker 用 trailer `X-Kin-Usage` / `X-Kin-Model` / `X-Kin-Stop-Reason` 回传合并 usage，与非流同一终态记账。

临时原始日志只支持明确 `stream:false` 的 Claude Chat；启用方式、Node 捕获边界、权限、保留/导出限制及原始/派生字段见 [PANEL_API.md](PANEL_API.md#临时原始非流式诊断2026-09-24)。
