# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `VM2API_API_KEY`。协议密钥不能调面板。信封 `{ ok, data }` / `{ ok: false, error }`。调用方应从 `data` 取业务体。

登录：`POST /api/panel/login` `{ username, password }` → token + Cookie `kin_panel_token`（7 天，HttpOnly）。`POST /api/panel/logout` 撤销。`GET /api/panel/me` → `{ user, role, views, capabilities, version }`。

`/admin/*` 仅 master / admin 角色。恢复备份期间协议口 503。

## RBAC

| 角色 | 页面 | 能力 |
|------|------|------|
| `user` | 虚拟机 / 代理池 / 密钥 / 计费 / 日志 | 只管自己的 VM、代理、key；自建配额 `vm_create_quota` 0–100；不能调度平台池 |
| `super` | 总览 / 集群 / 用量 / 日志 + 虚拟机 | 读 VM + 拨调度 / 清冷却 |
| `admin` | 全部（不含用户管理页） | `*`。admin/master **未 pin** 的 `/v1` 只打未分配平台池 |

开源仓 **没有用户管理**。登录只用环境变量 `VM2API_ADMIN_USER` / `VM2API_ADMIN_PASSWORD` 灌进去的第一个 admin。`GET/POST/PATCH/DELETE /users` 返回 `404 not_found`。

`vms/*.json` 的 `owner_user_id` / `origin`（`platform` \| `admin_assigned` \| `user_created`）是属主 SSOT。`PATCH /vms/:id/owner` 仅 admin。自建 VM 不能收回进平台池。

## 计费

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/billing` | 计费汇总。`from`/`until`/`group_by=vm|key` |

## 总览 / 槽位

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览：健康、KPI、`proxy_pool`、`ops`（默认近 1h SLA/TTFT）、`billing` |
| GET | `/vms` | 列表（`has_token`、`cred_status`、`proxy_configured`、`can_import_credential`、`account_tier`、`schedule_level`、`schedule_level_mode`、`worker_credential`、Fable 轨） |
| GET | `/vms/:id` | 详情 + 调度等级 + 代理健康 + `billing.today/window_5h/window_7d/by_model` + `account.runtime_window` |
| PATCH | `/vms/:id` | 热改并发、模型白名单、槽策略、`schedule_level` 或 `timezone`（不重启槽）。`timezone` 为任意有效 IANA 名称，会钉住该槽（后续绑定不覆盖）；`timezone_follow_proxy: true` 重新跟随已绑代理的出口时区 |
| POST | `/vms/:id/probe` | 槽 SOCKS5 探官方 `/usage` + Fable（Pro 跳过 Fable） |
| POST | `/vms/:id/schedulable` | `{ schedulable }` 是否入池；不改容器 |
| POST | `/vms/:id/cooldown/clear` | 清账号/模型冷却、粘性钉和 `/usage` 429 旗标，重新入池 |
| POST | `/vms/:id/test-chat` | loopback `POST /v1/messages`，master 可钉槽；官方 CC 入站 + 4 块 system。默认 prompt `hello` |
| POST | `/vms/:id/count-tokens` | Setup Token / Console API Key 经槽 Go worker SOCKS 打官方 `POST /v1/messages/count_tokens`。body `{ model, messages, system?, tools? }`。完整 OAuth 400 `count_tokens_unsupported`。成功 `{ input_tokens, model, credential_mode, vm_id }` |
| POST | `/vms/:id/oauth/refresh` | 只转发 worker `Ensure`，不回 token |
| POST | `/vms/:id/oauth/to-setup-token` | 把当前完整 OAuth 活票改成 Setup Token（保留 refresh/过期）。已是 setup-token 则幂等 |
| POST | `/vms/:id/oauth/generate-auth-url` | PKCE 授权链接；无 SOCKS5 拒绝。`{ flavor: "claude_code" }` 为官方 Claude Code 授权页。`{ flavor: "setup_token" }` 为 inference-only PKCE，不启槽内 CLI |
| POST | `/vms/:id/oauth/exchange-code` | 粘贴授权码，经槽代理换票。完整 OAuth 才排队初装。flavor 以 session 为准 |
| GET/POST | `/vms/:id/official-cc-bootstrap` | 初装进度 / `{ manual:true }` 再跑 |
| GET/PUT | `/vms/:id/seed-settings` | 播种；强制保留 telemetry/bedrock/vertex 等 env |
| POST | `/vms/:id/collect-identity` | guest 采集（locale/tz/`guest_machine_id`） |
| POST | `/vms/:id/reload` | 重载该槽 worker |
| GET | `/wrap-cli` | kernel / wrap 样本 inspect：`ok, dir, kernel_bin, glibc_shim, wrapper, meta, kernel`。`kernel.source` 为 `configured`（仓内 `KIN_KERNEL_BIN` / `bin/kin-kernel`）或 `sample` |
| POST | `/wrap-cli/make` | `{ glibc_vm? }` 重整 share/wrap-cli；叠上仓内最新 kernel；可从指定槽拷 glibc shim |
| POST | `/wrap-cli/kernel` | 原始 `application/octet-stream` linux amd64 ELF。替换仓内 `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`。不自动同步槽位 |
| POST | `/wrap-cli/kernel/release` | `{ ids?, restart?, tag? }` 下载 GitHub Release 的 `kin-kernel`（默认 latest；`tag` 必须是 `vX.Y.Z`）。校验 linux amd64 ELF 后替换仓内二进制，再按 `/wrap-cli/sync` 铺到槽并 bounce dataplane。不 `docker rm`。下载或 ELF 失败不写文件。HTTP 200 表示槽同步也成功 |
| POST | `/wrap-cli/sync` | `{ ids?, restart? }` 铺到槽 `.kin`（cli-node ELF + **最新** kernel.bin + 包装器）。kernel 优先仓内二进制，不被旧母样本盖回。`restart` 默认 true，rust 槽 bounce kernel |
| POST | `/vms/:id/wrap-cli/promote` | 从该槽晋升 wrap 文件，不复制凭证/SOCKS。下次 sync 仍优先仓内最新 kernel |
| POST | `/vms/:id/wrap-cli/repair` | 单槽重装 kernel。`{ wrap, kernel }`；wrap 成功时 HTTP 200 |
| POST | `/vms/:id/start` · `/stop` | 容器生命周期。运行中容器除非显式 recreate，禁止 `docker rm -f` |
| POST | `/vms/:id/activate` | 标 active |
| POST | `/vms/:id/reset` | 销毁容器与家目录，再按原槽位重建（保留 ID/代理/种子；凭证清空） |
| POST | `/vms/:id/reset-fingerprint` | |
| POST | `/vms/:id/allocate-proxy` | 从池分配 SOCKS5 |
| POST | `/vms/:id/update-claude-code` | 410，`claude_cli_removed` |
| DELETE | `/vms/:id` | 不能删 active；只解绑本槽代理 |
| POST | `/vms/create` | 种子 VM + Claude Code home |
| POST | `/vms/import` | sessionKey 导入（必须已有 VM+代理） |
| GET | `/vms/fleet-status` | 全槽更新状态 |
| POST | `/vms/fleet-update` | 全槽 roll / 采集 |
| POST | `/vms/reconcile-fingerprints` | 用官方 `~/.claude.json` 对齐指纹 |
| POST | `/probe` | 全量额度探测 |
| GET/POST | `/health-probe` | 读/跑官方 hello 健康探测缓存 |
| GET | `/usage` | 用量汇总（含缓存 token、官方价；账号行 `credential_mode` = `oauth` / `setup-token` / `apikey`） |
| GET | `/models` | 策略目录（不 hop worker） |
| GET | `/oauth` | 全槽脱敏 credential |

`cred_status`：`无凭证` / `可用` / `5h 警告` / `5h 限制` / `7d 警告` / `7d 限制` / `普通限制` / `不可用` / `被吊销` / `探测失败`。Fable 不可用 / 7d_oi / 家族冷却不抬账号级限制。等级：官方 `/usage` 有 Fable 模型或真实 7d_oi = Max；无 Fable 的 `plan_denied` = Pro。落盘 pro 不能盖掉 usage 里的 Fable。

`account.runtime_window`：`rate_limited_at` / `rate_limit_reset_at` / `overload_until` / `session_window_start|end|status`。

`schedule_level` 是当前有效调度等级，范围 1–10；`schedule_level_mode` 为 `manual` 或 `auto`。`PATCH {"schedule_level": 1..10}` 写入手动等级，`null` 或 `"auto"` 清除手动值。自动模式按 Claude 7D 重置剩余时间滚动分档：不足 24h 为 7，之后每 24h 降一级，144h 及以上或无有效重置时间为 1。`weight` 仍是同等级候选的平滑 WRR 比例，与调度等级无关。

`GET /vms/:id` 的 `kernel.rust_health` 来自 wrap `/internal/health`：`reachable`（进程在且 `ready_slots>=1`）、`process_up`、`provider`（cli-hop 为 `local_cli`）、`ready_slots`、`cli_pid`、`worker_version`。Go hop 没有 slot 字段。`reachable=false` 且 `process_up=true` 表示 kernel 在、CLI 槽未就绪。

### 虚拟机代理字段

| 字段 | 说明 |
|------|------|
| `proxy_configured` | 是否已绑定 SOCKS5 |
| `can_import_credential` | 绑定且代理非 fail/dead 才允许换票 |
| `proxy.status` / `enabled` / `latency_ms` / `last_error` / `last_probe_at` / `has_auth` | 健康快照；**不返回**带账密的 `proxy.url` |

`proxy_pool`：`{ total, free, bound, ok, dead, probing, disconnect_on_error }`。

## 数据库运行态（仅 admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/database/metrics` | `{ sampled_at, database, usage_cache }`；SQLite/WAL 只读快照与官方用量缓存实例统计 |

`database` 只执行 `SELECT 1`、只读 PRAGMA、migration 摘要和文件 stat；不返回数据库路径。单项失败为 `null`，文件明确不存在时大小为 `0`，探针失败只令 `database.ok = false`。当前 `node:sqlite` 不提供 SQLite 页缓存 hit/miss，不得从这些字段推算。

`usage_cache.hit_rate = (success_hits + error_hits) / requests`；`reuse_rate` 再加 `singleflight_joins`。零请求时均为 `null`。`error_hits` 是负缓存命中，不代表业务成功；累计计数随进程或缓存实例重建归零。

该端点只做观测；禁止 SQL 控制台、表浏览、配置修改、checkpoint、VACUUM、`PRAGMA optimize`、完整性检查及业务大表全表计数。

## 版本 / 更新（仅 admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/version` | 当前 `VERSION`、GitHub 最新 Release、是否可更新、一键命令、比当前新的 changelog。GitHub 失败时 `source_error` 有值，不 5xx |
| GET | `/changelog` | 本地 `CHANGELOG.md` 解析结果 `{ current, entries }` |
| POST | `/update` | `{ confirm?: true, version?: "vX.Y.Z" }`。`confirm` 缺省只返回命令。`confirm: true` 且已挂 `docker.sock` 时 202 拉起宿主机升级助手；否则 `409 host_upgrade_required`，`data.command` 是同一条 curl。升级会重建控制面，请求可能中断 |

一键脚本：`curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade`。保留 `.env` / `vms/` / `data/`。不要 `docker rm` 槽。

## 模型策略

| 方法 | 路径 |
|------|------|
| GET | `/model-policy` → `{ policy, models, effective }` |
| PUT | `/model-policy` |
| POST | `/model-policy/reset` |
| POST | `/model-policy/sync-worker` | 只同步本地策略缓存，不 hop 烧票 |
| POST | `/model-policy/sync-codex` | 经 GPT OAuth 槽 SOCKS 拉 ChatGPT 模型目录并入矩阵。票过期时用 refresh_token 换一次新 access，写入 `codex-credentials.json`。无 Codex 槽 400 `no_codex_slot`。 |

`catalog_mode`：`policy_only`（默认，控制台 #/models 即目录）/ `worker_intersect_policy` / `worker_only`。矩阵行可改 `betas.pass_context_1m`、thinking 策略、`max_tokens_cap`。

## 路由 / 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/routing` | sticky / pool / failover / 并发 / `tiers` / 额度 / logging / `compatibility` / `official_cc` / `health_probe` |

`PUT` 热更新。`tiers` 必须回传：`PUT` 是整体替换而非 patch，缺字段即置空。保存时按 Pro/Max 把未手动 override 的槽并发写回去。

`compatibility.persona_preset`（`official` / `official_full` / `zero` / `custom`）和 `compatibility.cache_ttl`（`auto` / `5m` / `1h`；auto 按凭证默认，显式块 TTL 不被覆盖）保存后投影到每个 Claude 槽的 `vms/<id>/run/kernel.json`：`persona_preset`、`system_layout`（`zero`→`zero`，其余→`identity`）、`default_cache_ttl`。响应 `kernel_persona.updated` 是本次字节有变化的槽数。`PATCH /vms/:id` 的 `timezone` / `timezone_follow_proxy` 另把 `timezone` 热写进该槽 `kernel.json`，`timezone_sync.kernel_hot` 表示文件有变化。容器 `TZ` 不在这次写入里。Codex 槽不写。

## 蒸馏拦截

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/distill` | 协议入口蒸馏拦截。命中后返回 `error` 里配置的状态和 code（默认 HTTP 403，`code=distill_blocked`，文案 `不允许蒸馏`），不 hop 凭证 |

`PUT` 热更新 `src/config/distill-rules.json`。字段：`enabled`、`skip_official`（官方 Claude Code 放行其它针）、`skip_zero`（`persona_preset/inject=zero` 放行其它针）、`error.{status,type,code,message}`、`needles[]`、`patterns[]`、`fingerprints[]`、`structure.{min_max_tokens,require_no_tools,require_single_turn}`。`patterns` 是正则，和 `Memory-stage-one extractor` / `MUST distill` / `MUST extract durable memory` 一样是硬拦截：官方、0 注入、面板删掉也会补回，命中即 403，不 hop。覆盖蒸馏（knowledge/model distillation，不含化学 distill）和提取思维链（extract/dump chain-of-thought、提取/蒸馏思维链）。**不含**单独的 `Persistable response items`（普通 agent 信封）。仅 admin。

## 拒答缓存

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/refusal-guards` | 仅缓存 `stop_reason=refusal` / refusal 块 / `finalState=content_filter`。命中后 HTTP 500，`code=refusal_guard`，不 hop。wrap `Usage Policy` 文案和信封 JSON 不会入缓存 |
| DELETE | `/refusal-guards/:fingerprint` | 删除一条 64 位 hex 指纹 |
| DELETE | `/refusal-guards` | 须 `{ "confirm": true }` 清空 |

`PUT { enabled }` 写入 SQLite `settings.refusal_guard_enabled`。环境变量 `REFUSAL_GUARD=0` 仍强制关闭。与蒸馏拦截独立：0 注入跳过普通蒸馏针，本缓存仍生效。`count_tokens` 同样在 peek / worker hop 之前拦截。仅 admin。


## 密钥 / 日志

| 方法 | 路径 |
|------|------|
| GET/POST | `/api-keys` |
| PATCH/DELETE | `/api-keys/:id` |
| GET | `/request-logs` |
| GET | `/request-logs/stats` |
| GET | `/request-logs/export` |
| GET | `/request-logs/:request_id` |
| GET | `/request-logs/:request_id/attempts` |

创建密钥只在响应里明文出现一次。存储为 HMAC 索引。

attempts：每次选中的 VM/账号、错误域、cooldown、提交边界、终态。`normal` 摘要；普通 `debug` 另存脱敏 body。`X-Kin-Debug` / `X-Kin-Log` 可单请求覆盖日志级别；不能越过下面的原始正文开关。

### 临时原始非流式诊断（2026-09-24）

在设置 → 日志选择 **Debug** 并开启 **临时原始非流式诊断**，对应：

```json
{"logging":{"mode":"debug","raw_nonstream_debug":true}}
```

默认关闭。只登记已鉴权、原始 Claude Chat `stream:false`（JSON boolean）的请求；stream:true、未写 stream、原始 Codex、无效 JSON、超过入站限制等不登记。显式 server off 不被请求 debug 头越过。before_convert 改到非 Claude/Codex 时丢弃候选；保守地不登记原始 Codex 改到 Claude 的请求。关闭开关不删除已有记录。

登记后的记录仍存于 `request_log_debug.record_json`，没有新表。每个登记请求有新的服务器 request_id（响应 `x-request-id` 和 attempt 关联使用它）；调用方原有 ID 保留为 `caller_request_id`，不是查询键。普通请求保留原有 ID 行为。原始行不会被后来复用该 ID 的普通 debug 写入覆盖。

- `GET /request-logs/:id?include_raw=1`：仅 admin 显式读取完整原始字段。默认详情、两种日志列表、普通 CSV/JSONL 不含原始正文；super/user 不能通过传入参数读取 raw。
- `GET /request-logs/export?include_raw=1&format=jsonl`：仅 admin；沿用筛选条件。`request_id=:id` 可精确导出单条。raw+CSV 返回 400；普通导出不变。
- 导出逐条保留完整存储 JSON，并使用真实 UTF-8 序列化字节数预选。上限 32 MiB / 5000 条；超过上限的记录被省略并报告，不会切碎 JSON。`x-kin-export-count/total/bytes/unavailable/oversized/byte-limited/row-limited/truncated` 报告导出结果，并显式暴露给允许访问的跨域客户端。代理隐藏统计头时，单条下载仍可下载非空成功响应，但显示统计未知提示。
- 日志详情需显式加载原始数据。UI 最多预览 24000 字符，完整数据在有界 JSONL 导出中；预览截短不等于存储截断。

`raw_debug` 的主要结构：

| 字段 | 来源 / 含义 |
|---|---|
| `caller.text` | 单次入站读取中的原始有效 UTF-8 JSON 文本；保留空白、重复键、数字写法，不由解析对象重建 |
| `hops[].request.text` | 最终序列化的 Node→kernel/API-kernel body JSON；不是隐藏的 Anthropic wire |
| `hops[].response.text` / `format` | Node 实际观察到的原始 JSON、SSE 或未知格式文本；`read_complete` 与 `truncated` 分开 |
| `hops[].initial_metadata` / `hops[].trailing_metadata` | 白名单初始头与尾部 metadata 分别保存，不把冲突合并后冒充原始值 |
| `hop_no` / `attempt_no` / `repaired` / `local_connect_attempt` | 实际 Node 发送顺序、外层尝试与恢复；`provider_call: unknown`，不推测内部计费次数 |
| `hops[].derived_message` / `derived.assembled_message` / `derived.client_json` | 明确标记的派生视图，不能当成原始上游 JSON |

客户端非流式并不意味着上游返回单个 JSON：目前槽位/API-kernel 路径通常仍收到 SSE。原始 SSE 保存为文本，Messages/Chat JSON 由 Node 组装。可用证据止于 Node 边界，不能证明原生 CLI 内部没有再次改写提示词。

采集上限为每请求累计 16 MiB 原始/派生文本、16 个保留 hop、4 个活动采集器。超过上限仍正常推理，只保留明确标记的连续前缀/省略计数；不是进程内存上限。状态区分未发送、完整观测、部分采集和并发容量不足；不能将有界记录当成无条件完整证据。`client_response_complete` 仅指 Node writableFinished，不证明客户端应用收到了全部内容。

**敏感数据：** 不额外采集鉴权头或含凭证的 API envelope/proxy URL，但精确正文自身可能包含密钥、图片、提示词和工具结果。原始和未脱敏派生数据都在受保护字段中。沿用日志保留/容量清理；默认摘要 7 天、Debug 3 天，导出与备份副本不会随之删除。调试结束请关闭开关，分享前脱敏。

### 离线 kernel / CLI 全链路验证（2026-09-25）

这是临时诊断模式，**默认关闭**，不是新的真实推理数据面。部署控制面代码及前端后，在设置 → 日志先选择 Debug、开启原始非流式诊断，再开启「离线 kernel / CLI 验证」。

```json
{"logging":{"mode":"debug","raw_nonstream_debug":true,"offline_kernel_probe":false}}
```

- 开关在请求开始时取快照。开启后，新的推理只允许 **master key + Claude `/v1/chat/completions` + 显式 `stream:false` + VM 后端**；其它推理/count_tokens 请求明确拒绝，绝不回退正常推理、账号池或凭证刷新。请求头不能开启此模式。关闭开关不会把已接收的离线请求变成真实推理。
- **不是整个控制面的断网开关**：已开始的请求、后台监测、`/v1/models`/usage 和管理员操作不被自动停止。测试前停止其它业务请求；不要用账号额度变化证明该诊断是否出网。
- 使用当前活动 Claude Docker 槽的本地镜像 ID；可用已有 `x-kin-vm` 指定槽位。镜像必须已存在，包含 Python 3，且能运行 Linux amd64 ELF。不拉镜像、不安装依赖、不重装或重启真实槽。
- `offline_kernel_dataplane`：用户入口只接受 `src/lib/transport/offline-candidate-round.json` 列出的本轮待测项。R3 已完成比对，当前清单为空：CC 获准派生为正式 `cc-fixed`，Crag 尚有请求语义问题且没有新修正版，不要求重复测试旧候选。不再列出原版、已转正版本或历史候选；旧保存值返回 `offline_selection_required`，不会自动换版；清单为空时也不会自动关闭离线开关或恢复真实推理。测试结束后必须由用户明确关闭离线验证。指定离线搭配**不改变** `inference.dataplane`。历史文件及低层回归工具支持保留，但不是当前菜单/API的可选资格。
- 记录选定/已安装 kernel 与 CLI 的 SHA256、镜像 ID、system layout、来源。磁盘文件哈希不等于已验证运行中进程的二进制。探针使用单个新槽、全新 HOME 和假 OAuth 身份，不复刻已有会话、20 槽并发、真实凭证或缓存状态。

每次请求依次执行两段：

1. **真 kernel → 假 CLI**：保留 argv、白名单环境、私有请求文件、stdin 和模拟输出。已知 `native_messages` / 常见 stream-JSON 帧可回复；未知握手只捕获并标明未完成，不伪造兼容成功。
2. **真 kernel → 记录代理 → 真实 CLI 副本 → 本地假 Anthropic**：记录 CLI 实际输入/输出、最终 HTTP 请求 JSON、生成的 mock Message JSON、实际写出的 JSON/SSE 和 kernel 回包。假服务只处理支持的本地 API，不转发外网。

隔离容器为 `network=none`、非 root、只读根文件系统、去掉 capabilities、不挂载生产 HOME/凭证/工作目录或 Docker socket。上传使用新建匿名卷；输入在运行用户视角不可写，脚本会在启动 kernel 前检查权限和仅 loopback 的网络接口。匿名卷随临时容器删除；正常结束、错误、取消均执行清理。单实例、内存上限 1 GiB，每段约 30 秒（镜像检查/上传/清理另计）。异常退出仍可能留下已创建但尚未运行的临时容器；只应清理带 `vm2api.offline_probe=true` 标签且名称为 `kin-offline-*` 的已确认诊断实例，不要清理真实槽。

通过入站鉴权/JSON 读取的诊断调用使用 **HTTP 422 的诊断回执**（鉴权/读取失败保留既有状态码），不是应追加到对话中的模型正文；`offline_probe_captured` 表示捕获/正文校验完成，`offline_probe_incomplete` 或其它 `offline_*` 表示缺失、差异或运行失败。模拟 usage 不写成真实用量，不调用真实账号池/凭证刷新/粘滞绑定；日志仍会有这条诊断记录。

原始数据仍在同一条受保护的日志中，使用原有的管理员「完整 JSONL 下载」：

- `raw_debug.caller.text`：原始 caller JSON。
- `raw_debug.offline_probe.details.text`：再解析一次 JSON，即完整诊断报告。`meta` 标明文件/配置来源；`node_envelope` 为诊断用 Node 对象（身份是合成值，未经过正常账号选择/TTL pin/远程媒体获取）。
- `stages[].captures`：`node_to_kernel_envelope` 是实际提交给 kernel 的序列化 JSON；`cli_argv`/`cli_environment`/`cli_stdin`/`cli_request_file`/`cli_stdout` 是 CLI 边界记录；`anthropic_request` 是 CLI 发往本地假服务的实际 body；`mock_anthropic_message` 是生成夹具；`anthropic_response` 标明实际成功写出的字节及完整性。假 CLI 输出预写记录有单独 observation 标记。
- `stages[].kernel_reply`：实际 kernel 响应头、尾部 metadata、`body_text`、原始字节 `body_b64` 和 SHA256。
- `stages[].node`：把捕获字节送入私有本地 socket，调用**同一套生产 Node 读流/非流式组装/Chat 转换**得到的 Message 和 Chat；这是明确的 decoder replay，不是第二次模型请求。`raw_debug.derived.client_json` 则是实际 HTTP 422 诊断回执。
- `stages[].request_checks`：已识别 JSON 中的 system 数量、文本出现位置/role，以及 thinking、output_config、max_tokens。匹配不到或角色变化不自动等同于模型不遵守；未知/截断形状不参与判断。
- `stages[].checks`：固定长正文的预期/实得字符数、SHA256 与相等性。夹具含长中文、emoji、格式标签，usage 故意很小，以检查计数是否错误控制正文长度。夹具不按 caller 提示词生成，不能据此判断模型格式服从能力。

**采集完成不代表 caller system 已保留。** `offline_probe_captured` 的长正文校验只检查模拟回包的传输；请求语义应另外核对 `request_checks` 和实际 CLI/API 捕获。2026-09-26 收到的 v1.3.55 数据已证实：该版 wrap 原生 CLI 在 zero 路径替换 caller system，cc-node 的 native/crag 入口存在 `Config accessed before allowed.` 初始化错误；这些不是增加诊断超时能修好的问题。假 CLI 的 stream-JSON 回包现按输入会话 ID（缺失时用 `--session-id`）关联并带上 `stop_reason`；此探针修正不修改真实原生组件。

历史轮次曾使用同一份请求对照 wrap、cc、crag。当前不再列出这些旧项；仅在有新的待测修改时更新共享清单。即使采集显示成功，也必须核对请求语义；缺失阶段、丢失历史或 role 改变均不能算通过。

入站原文与诊断 envelope 各限制 1 MiB，容器每阶段捕获有 4 MiB/4096 条界限，最终仍受原始日志累计 16 MiB 和完整记录导出 32 MiB 限制；超限明确标记，不声称无条件完整。导出可能含私有正文；分享前脱敏，测试结束关闭离线开关，不再需要正文采集时另关原始日志开关。

### 正式修复数据面 `wrap-fixed`（2026-09-26 用户批准）

原版 `wrap` 仍为默认。用户已批准将通过其离线样例验证的 CLI 修复转为**可选择的正常数据面**；没有自动修改现有全局/单槽配置。数据面页面新增「cli-node 修复版 + kernel」。建议暂停业务请求，勾选目标 Claude 槽并保持“切换后重启 kernel”开启。

```json
{"dataplane":"wrap-fixed","ids":["vm-01"],"restart":true}
```

沿用 `POST /api/panel/dataplane`。不传 `ids`／`all:true` 修改全局默认，仅同步继承默认的 Claude 槽；显式单槽覆盖及 Codex 保留。设置页和 `/admin/routing` 的默认数据面修改也会同步对应的继承槽。同步前检查资产；运行同步失败会明确返回失败报告，不能把“配置已保存”当成所有槽已生效。`restart:false` 仍会写入匹配的磁盘配置，但要稍后重启才实际启用新程序。

- 独立分发目录：`share/wrap-fixed/v155-r1/`，含固定 kernel、CLI 和审批/哈希 manifest；Docker fallback 为 `image-wrap-fixed/v155-r1/`。
- 安装为 `.kin/cli-node-fixed` 和配套 `.kin/kin-kernel.bin`。原 `.kin/cli-node` 与原版分发文件不覆盖。kernel 配置仍使用已知的 `wrap` ABI，`claude_bin` 指向修复版文件。
- 普通“更新原版 release”和同步会尊重已选数据面，不把原版新文件覆盖到固定搭配中。重启/缺文件恢复/repair/重置保持选择；固定槽不能通过旧“收成母本”操作覆盖原始 wrap 模板。
- 转正版相对已验证的 r1 CLI，只恢复了原来的入口代码（去掉离线限制），两处 system 修复逐字节保留。manifest 说明这是原样例的派生转正版；本地没有执行新的 Linux ELF 或真实上游请求，广泛模型/工具/并发/额度表现不因此自动认证。
- 开始正常推理前关闭 `logging.offline_kernel_probe`。原始非流式日志可按需保留，但包含敏感正文。本轮离线选择器不再列出已转正的 `wrap-fixed`／`current`；如后续确有复测需要，应明确纳入那一轮的清单，而不是长期堆在候选列表。

### R3 验收与正式 `cc-fixed`（2026-09-26）

用户提供的两份 R3 Linux 隔离捕获均完整，固定长回复在 CLI、kernel 和 Node 间没有截断，但请求语义并不等价：

- **CC + wrap kernel 通过本次样例检查**：caller system 原文 99,926 字符及 245 条历史逐字段保留；Opus4.6、128000、adaptive+summarized、effort=max 不变。相对已验收 CLI，额外带有原生 `context_management` 的 clear_thinking/keep=all 配置；metadata 的 device/session ID 为新值。billing 另保留 CC 原生的版本指纹后缀、`cc_is_subagent=true`、`cc_turn_origin=sdk`，其生成代码与原 CC 相同；不宣称与 cli-node 完全等价或真实额度效果已验证。CCH 重算匹配，kernel 回包字节和 Message 与参考一致，Chat 只有 created 时间变化。
- **Crag 不转正**：caller system 被包入 user；245 条历史仅余最后一条 user 内容，max_tokens 为64000，缺少 effort=max。模拟回复完整不能弥补请求丢失。

新增正式数据面 `cc-fixed`（「cc-node 修复版 + kernel」），使用 `share/cc-fixed/v155-r3/` 固定组合，Docker fallback 为 `image-cc-fixed/v155-r3/`。沿用 `POST /api/panel/dataplane`，例如：

```json
{"dataplane":"cc-fixed","ids":["vm-01"],"restart":true}
```

它安装 `.kin/cc-node-fixed` 与配套 `.kin/kin-kernel.bin`，native family 仍是 `cc`。默认 `wrap`、已批准 `wrap-fixed` 和原版文件不变，不自动切槽。安装/恢复/同步/重置复用同一固定搭配路径；缺文件、审批或哈希失败不回退原版。切换前暂停业务请求，并明确关闭离线开关；暂不重启时要稍后重启才能生效。

派生转正版只将已测 R3 入口的183字节离线 guard 替换为空白，其余解包字节保持不变，尤其保留了 CC 必需的初始化修复。完整 JS/ELF/UPX 和入口控制通过，但本地未执行新 Linux ELF，也不认证真实鉴权、额度、全模型/工具或并发。最新 main v1.3.58 已回滚此前内核实验，原生净字节与该已测组合一致，不据版本号另换未测试内核。

本轮清单已关闭，不再要求重复测试 CC/Crag r3。历史目录 README 和日志是当时的记录，不代表当前可选资格。

### CC / Crag r2（历史修复记录）

新增 `candidate-cc-r2` 与 `candidate-crag-r2`，对应独立 `share/offline-candidates/native-v155-r2/cc-node`。r1 文件和选择值均保持原意，不会悄悄指向 r2。两种 r2 **仅用于离线截获，不能通过正常数据面接口启用**。

r2 复用 CC 包内已有的 `getWorkload2()`／`runWithWorkload()` 异步上下文，修正 User-Agent 对不存在的 `getWorkload()` 的引用并补依赖初始化；不添加另一套状态或常量 stub。Crag 的 assistant API 错误会保留具体正文，不再全变成 `api_error`。原有 system/入口初始化修复不变，Crag kernel 的请求包装未修改。

R2 当时使用 Debug/原始日志/离线开关进行测试；记录显示两种组合均在 API 前遇到日志函数错名，随后由 R3 修复。旧文件保留，但这些选择值不再是当前测试入口。

### r1 重打包候选的原始离线验收记录（2026-09-26）

用户明确授权的实验候选 `native-v155-r1` 位于 `share/offline-candidates/native-v155-r1/`，与正式 `share/wrap-cli/` 分开。Docker 镜像将候选放入 `image-offline-candidates`，普通启动/同步脚本不会把它安装到生产槽。该目录保留首次分发时的历史 manifest，不回写其验证标记。后续用户已提交 r1 的 Linux 截获：CLI 样例通过并批准派生为上面的 `wrap-fixed`；CC/Crag 的真实 API 阶段失败，后续测试使用 r2。r1 文件本身仍受离线启动限制，不能直接当成转正版安装。

沿用上述 Debug + 原始日志 + 离线开关，在「离线验证搭配」新增三个选择：

| 设置值 | 本次隔离运行 |
|---|---|
| `candidate-wrap` | v1.3.55 wrap kernel + 候选 cli-node |
| `candidate-cc` | v1.3.55 wrap kernel + 候选 cc-node |
| `candidate-crag` | 原 crag kernel + 候选 cc-node |

发送同一份真实 caller JSON，仍使用 master key 和显式 `stream:false`。候选流程只调用本地假 Anthropic，HTTP422仍是诊断回执。无须、更不应把候选手工复制进生产 `.kin` 目录。未选择候选、关闭离线开关或正常推理时，候选均不会被使用；普通槽位数据面接口明确拒绝候选选择值。

候选只覆盖已确认的原生问题：

- 在 native 查询选项中保留 caller system 的独立字符串快照，在最终 API 构造中追加原文块，不经过 leftover 清洗/合并；原生生成的头信息和环境说明仍单独保留。最后一个非 global 的原生 system 缓存标记延伸到最后 caller 块，标记数和 TTL 不增加，global 标记不移到私有 caller 文本。真实命中率仍需另行验证。
- cc-node 的 native/crag 入口先执行既有初始化，再开始处理任务；不删除配置保护检查。
- crag kernel 的 user-role 包装和参数传递本轮没有改动，第三种组合仍可能暴露其它差异，不能当作已达成完整 CPA 等价。

候选的基础正式 CLI、kernel、layout 和文件 SHA256 均校验；基础版本更新、文件缺失、校验不符时直接拒绝，**不退回正式版本**。进入容器后会再次核对上传 kernel/CLI 字节哈希，未通过不会启动 native。候选程序自身也要求探针专用标识和字面 `127.0.0.1` 的假 API 地址。这些限制不是生产启用开关，不要通过改 manifest 或设置环境变量绕过。

下载三份完整原始 JSONL，建议命名 `candidate-cli.jsonl`、`candidate-cc.jsonl`、`candidate-crag.jsonl`。报告新增：

- `meta.candidate`：候选 ID、待验收状态、基础/候选 CLI 哈希、manifest 哈希、预期 kernel 哈希、补丁 ID 和本地检查范围。
- `binary_inputs_verified` / `observed_binary_hashes`：隔离容器执行前对实际上传文件的核对；不是生产进程 inode 的证明。
- `stages[].captures[kind=effective_mock_environment]`：该阶段真实 CLI 的候选标识/本地地址；第一段仍是假 CLI，不代表已执行候选。

`local_validation.native_execution:false` 表示本地构建阶段没有执行 Linux CLI；用户这次是否真正运行了候选，应看阶段中的 `real_cli_executed`、实际捕获和哈希。`user_capture_accepted:false` 和 `production_approved:false` 不会因 HTTP422/长正文校验通过而自动改变。拿到日志后须人工核对最终 API 中的 caller 块数/顺序/原文、thinking/effort/max_tokens、返回正文和所有缺失阶段，再决定下一步；模拟验收本身不认证真实提供方鉴权、额度或模型行为。

### 协议字段（对齐 Sub2API usage_logs）

| 字段 | 说明 |
|------|------|
| `cache_read_tokens` / `cache_creation_tokens` | 提示缓存读 / 写 |
| `cache_creation_5m_tokens` / `cache_creation_1h_tokens` | 上游 TTL 分项，缺失为 null；不会按请求配置重分类 |
| `cache_creation_unclassified_tokens` / `cache_creation_estimated` | 未分类写入 token / 是否包含 5m 价格估算，由已有总量与分项推导；不伪造 TTL 分项 |
| `requested_model` / `upstream_model` / `model_mismatch` | 三态；null = 上游未声明 |
| `first_token_ms` | 首个业务事件（worker 回传） |
| `stop_reason` | 来自上游终态；非流式 Chat 会合并可信 native 结束 metadata，原始差异见 raw 记录 |
| 费用列 | 官方价 input/output/cache 5m·1h·read；上海日切 |

`GET /request-logs/stats` 另返回 `window`：SLA、错误率、429/503、QPS/TPS、耗时与 TTFT 分位、按模型 `avg_first_token_ms`、`error_collection`。`GET /dashboard.ops` 默认近 1 小时同一形状。

筛选：`status=error`、`error_class=` = auth / request / signature / rate_limit / quota / overloaded / timeout / credential / proxy / upstream / other。每行带 `error_class` / `error_label` / `error_owner`。5h/7d/限流计入 SLA 成功。

流式 usage 由 worker SSE 校验器合并后经 trailer 回传，终态 attempt 只记一次。

## 压测 / 探针

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/test-models` | 可测模型。`vm_id` 按槽位平台过滤：GPT/Codex 只返回 `gpt-*`/`codex-*`，Claude 槽不含 GPT。`platform=openai|anthropic` 无 `vm_id` 时同样过滤。GPT 槽 `refresh=1` 经该槽 SOCKS 拉 ChatGPT `/backend-api/models` 并入矩阵，401 不换票。回包带 `platform`、`protocol`（`openai.responses` / `anthropic.messages`）、`inbound_path`。 |
| POST/GET | `/concurrent-test` | 研报压测；默认并发 10、2 轮、Opus5/Sonnet5/Fable5、预算 32000。走 `/v1` |
| GET | `/concurrent-tests` · `/concurrent-test-reports` | 历史与落盘报告（`data/loadtests/reports/`） |
| GET | `/probe-test/catalog` | 能力 / 答题用例 |
| POST/GET | `/probe-test` · `/probe-tests` | 与研报互斥 |

Claude 槽测试与能力探针走官方 CC 入站（`/v1/messages`）。GPT/Codex 槽测试走 `/v1/responses`。研报保持第三方 UA。

## 备份 / 代理

| 方法 | 路径 |
|------|------|
| GET/POST | `/backups` |
| GET/PUT | `/backups/config` |
| GET | `/backups/:id/download` |
| POST | `/backups/:id/restore` 须 `{ "confirm": true }` |
| GET | `/proxies` |
| POST | `/proxies/import` · `/proxies/probe` · `/proxies/geo` |
| GET/PUT | `/proxies/config` |
| PUT | `/proxies/:id` 改 host/port/账密 |
| POST | `/proxies/:id/enable` · `/disable` · `/bind` · `/unbind` · `/reveal` · `/geo` |
| DELETE | `/proxies/:id` |

恢复期间协议口 503。每个槽位必须绑定 SOCKS5。`PUT /proxies/config` 的 `disconnect_on_error`（默认 false）：运行时 SOCKS 错误立刻停该槽调度、回写失败并重建 worker；其它健康槽仍可 failover。

`PUT /proxies/config` 的 `follow_proxy_timezone`（默认 true）：绑定一条代理后，该槽采用出口节点的 IANA 时区（persona `# Environment`、指纹、容器 `TZ`）。操作者在创建时或 `PATCH /vms/:id` 手动指定过时区的槽不受影响。

`PUT /proxies/config` 的 `dns_primary`（默认 `auto`）：远程 SOCKS5 透明出口优先使用的 DNS 上游，可选 `auto`、`https://1.1.1.1/dns-query`、`https://8.8.8.8/dns-query`、`8.8.8.8:53`、`1.1.1.1:53`。所选上游排第一，其余内置上游按默认顺序排在其后作为自动 fallback；`auto` 直接用 kin-egress 内置顺序。`IP:53` 为经 SOCKS 转发的 DNS-over-TCP，出口到 DNS 服务器之间明文。变更后重载已绑定的 `kin-egress`，不重建槽位，响应 `egress` 数组报告各出口重载结果。

### `POST /proxies/geo` · `POST /proxies/:id/geo`

经该代理本身去查出口 IP 的国家 / 城市 / 时区（本地出口走宿主机默认路由）。结果落在 `proxies.geo_*` 列，列表响应的 `geo` 字段回显。单条成功后，已绑槽位在 `follow_proxy_timezone` 开启且未被手动钉住时会改用该时区。

响应 `{ proxy, geo, cached, timezones }`（单条）或 `{ total, results }`（批量）。错误：`404 proxy_not_found`、`502 geo_lookup_failed`。`force: true` 忽略缓存重查。

### `PUT /proxies/:id`

可改 `host` / `port` / `username` / `password`，**按键是否存在**判定语义：不传该键 = 保持原值；传空串 = 清除（`username: ""` 会连带清掉密码）。合并后走 import 同一套 `socks5Record()` 校验。同时把该行的 `raw` 重写为 `host:port`，清掉导入时可能残留的明文密码。

代理凭据在系统里存三份（池 → `vms/<id>.json` → `worker.json`），所以本端点会对每个已绑槽位回写槽位文件并重载 worker（停调度 → reload → 恢复），reason 记为 `proxy_edit_worker_reload`。单个槽位重载失败不会让请求失败——池已经改了，回滚更乱；失败信息逐槽位放在响应里由运维决定是否重试。

响应 `{ proxy, workers: [{ vm_id, ok, error }] }`。错误：`404 proxy_not_found`、`400 invalid_proxy`、`400 no_editable_fields`、`400 password_without_username`（SOCKS5 没有只有密码的认证方式，`socks5Record()` 见用户名为空就丢弃密码，所以这个组合直接拒掉而不是静默存成「仍无账密」）。

**路由顺序**：该路由必须排在 `PUT /proxies/config` 之后（`[^/]+` 也会匹配 `config`，且两者方法相同）。实现里另加了 `(?!config$)` 负向前瞻，把这个顺序依赖写成显式约束。

### `POST /proxies/:id/reveal`

**唯一允许返回代理凭据的端点。** 响应 `{ ok, id, uri }`，`uri` 形如 `socks5://user:pass@host:port`（无账密时不带 `user:pass@`）。

只给拼好的 URI、不给分立的 username/password 字段——调用方唯一的正当用途是复制，拆开只会增加它被渲染到界面上的机会。调用方侧的对应约束：只允许写入剪贴板，不得渲染、不得存入前端状态、不得记日志。

形态对齐既有的 `POST /api-keys/:id/reveal`：POST 而非 GET（不进浏览器历史与缓存）、无请求体、无二次确认、不记审计（网关目前没有审计机制，为单个端点首创属于越界）。

与 `getProxyForVm()` 不同，本端点**不过滤** `enabled`/`status`——被禁用或已失效的代理恰恰是运维最需要读回来排查的。

> 除此之外，任何 `/api/panel/*` 响应都不得包含代理账密；`GET /proxies` 永不返回（`publicProxy()` 只吐 `has_auth` 布尔）。

sessionKey / 授权码导入必须走该槽 SOCKS5。

## 管理口（master）

常用：`GET/PUT /admin/routing`、`GET /admin/vms`、`POST /admin/vms/probe-all`、`GET /admin/usage/summary`、`GET /admin/vm/oauth`、`POST /admin/vm/oauth/refresh`、`GET/PUT/DELETE /admin/intercept/rules`。`POST /admin/models/refresh` 与 `GET /v1/models` 一样只读本地策略目录，不 hop 槽位。`GET/POST /admin/vm/claude-code/*` 返回 410。
