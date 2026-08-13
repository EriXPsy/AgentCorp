# GOAI 复赛自动化验证报告（SP-14）

- 生成时间（UTC）：2026-08-13T06:02:51.969Z
- 门禁总判定：**门禁=PASS**

## 门禁汇总

| 门禁 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 1a 类型检查(root) | `tsc --noEmit` | ✅ | 退出码 0 |
| 1b 类型检查(node) | `tsc --noEmit -p tsconfig.node.json` | ✅ | 退出码 0 |
| 2 单元测试 | `vitest run --pool=threads`（6 文件） | ✅ | 绿 16 / 红 0（要求 ≥7 绿） |
| 3 隐私门禁 | `bash scripts/privacy-grep.sh` | ✅ | 退出码 0 |

## 测试用例统计（门禁 2）

- 覆盖测试文件（6 个）：
  - `tests/unit/agentteams-adapter.test.ts`
  - `tests/unit/closedLoop.test.ts`
  - `tests/unit/demo-adapter.test.ts`
  - `tests/unit/skills-experience.test.ts`
  - `tests/unit/otel-genai.test.ts`
  - `tests/unit/trace-sink.test.ts`
- 通过（绿）用例数：**16**
- 失败（红）用例数：**0**
- 验收结论：✅ 满足 ≥7 绿

## 门禁 1a · tsc --noEmit（root）

退出码：0（PASS）

```
(无输出)
```

## 门禁 1b · tsc --noEmit -p tsconfig.node.json

退出码：0（PASS）

```
(无输出)
```

## 门禁 2 · vitest run --pool=threads

结果：绿 16 / 红 0（PASS）

```

[1m[46m RUN [49m[22m [36mv4.0.18 [39m[90magentcorp-fresh[39m

 [32m✓[39m tests/unit/otel-genai.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 6[2mms[22m[39m
 [32m✓[39m tests/unit/trace-sink.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 27[2mms[22m[39m
 [32m✓[39m tests/unit/closedLoop.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 6[2mms[22m[39m
 [32m✓[39m tests/unit/skills-experience.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 5[2mms[22m[39m
[90mstdout[2m | tests/unit/agentteams-adapter.test.ts[2m > [22m[2mAgentTeams 薄适配（决策 X 实证）[2m > [22m[2mrunTask 端到端产出 AgentTeams Run（状态追踪 + 结果）
[22m[39m[ui-metric] api.request_error {"requestId":"8a45ec02-919a-47ac-9df9-fa9723ea6f81","channel":"hostapi:token","transport":"ipc","attempt":1,"durationMs":0,"message":"window is not defined","count":1,"ts":"2026-08-13T06:02:50.499Z"}

[90mstdout[2m | tests/unit/demo-adapter.test.ts[2m > [22m[2mDemo 接 AgentTeams 薄适配（SP-05）[2m > [22m[2mrunTask 产出带 Skill 标签的执行轨迹（Agent + Skill 标注）
[22m[39m[ui-metric] api.request_error {"requestId":"b3d984ea-3553-4a04-ab3d-729c522ae0e1","channel":"hostapi:token","transport":"ipc","attempt":1,"durationMs":0,"message":"window is not defined","count":1,"ts":"2026-08-13T06:02:50.505Z"}

[90mstdout[2m | tests/unit/agentteams-adapter.test.ts[2m > [22m[2mAgentTeams 薄适配（决策 X 实证）[2m > [22m[2mrunTask 端到端产出 AgentTeams Run（状态追踪 + 结果）
[22m[39m[ui-metric] api.request_error {"requestId":"f551946b-409d-4c5e-8583-e44223bf2085","channel":"hostapi:token","transport":"ipc","attempt":1,"durationMs":0,"message":"window is not defined","count":2,"ts":"2026-08-13T06:02:50.536Z"}

[90mstdout[2m | tests/unit/agentteams-adapter.test.ts[2m > [22m[2mAgentTeams 薄适配（决策 X 实证）[2m > [22m[2mrunTask 端到端产出 AgentTeams Run（状态追踪 + 结果）
[22m[39m[ui-metric] api.request_error {"requestId":"06782ab4-eb3a-48da-b81a-e97f20cc1bca","channel":"hostapi:token","transport":"ipc","attempt":1,"durationMs":0,"message":"window is not defined","count":3,"ts":"2026-08-13T06:02:50.538Z"}

 [32m✓[39m tests/unit/agentteams-adapter.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 55[2mms[22m[39m
[90mstdout[2m | tests/unit/demo-adapter.test.ts[2m > [22m[2mDemo 接 AgentTeams 薄适配（SP-05）[2m > [22m[2mrunTask 产出带 Skill 标签的执行轨迹（Agent + Skill 标注）
[22m[39m[ui-metric] api.request_error {"requestId":"e7d183b2-637e-402f-81fb-02d70173cc3b","channel":"hostapi:token","transport":"ipc","attempt":1,"durationMs":0,"message":"window is not defined","count":2,"ts":"2026-08-13T06:02:50.542Z"}

[90mstdout[2m | tests/unit/demo-adapter.test.ts[2m > [22m[2mDemo 接 AgentTeams 薄适配（SP-05）[2m > [22m[2mrunTask 产出带 Skill 标签的执行轨迹（Agent + Skill 标注）
[22m[39m[ui-metric] api.request_error {"requestId":"d7397be3-fef4-4e67-8c4b-26fb7d2a2225","channel":"hostapi:token","transport":"ipc","attempt":1,"durationMs":0,"message":"window is not defined","count":3,"ts":"2026-08-13T06:02:50.546Z"}

 [32m✓[39m tests/unit/demo-adapter.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 65[2mms[22m[39m

[2m Test Files [22m [1m[32m6 passed[39m[22m[90m (6)[39m
[2m      Tests [22m [1m[32m16 passed[39m[22m[90m (16)[39m
[2m   Start at [22m 14:02:49
[2m   Duration [22m 661ms[2m (transform 734ms, setup 0ms, import 1.20s, tests 164ms, environment 1ms)[22m


```

## 门禁 3 · 隐私门禁（privacy:check）

退出码：0（PASS）

```
privacy:check: 扫描 src/demo docs/artifacts 中的隐私 token ...
✅ privacy:check PASSED —— 未发现隐私 token。

```

## 结论

**门禁=PASS** —— tsc（root/node）、vitest（≥7 绿）、隐私门禁全部通过，复赛代码包可交付。

---
*本报告由 `scripts/qa/goai-verify.mjs` 自动生成（SP-14）。*