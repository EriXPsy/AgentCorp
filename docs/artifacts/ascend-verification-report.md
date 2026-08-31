# 昇腾端点冒烟验证报告

生成时间：2026-08-31T09:25:58.293Z（由 `verify:ascend` 自动生成，勿手改）

端点：http://127.0.0.1:1/v1
模型：(取 /models 首个)

| 步骤 | 结果 | 耗时 | 说明 |
|---|---|---|---|
| ① GET /models 连通性 | ❌ FAIL | 0.0s | fetch failed |
| ② POST /chat/completions 非流式 | ❌ FAIL | 0.0s | 无可用模型（①失败且未配置 ASCEND_MODEL） |
| ③ POST /chat/completions 流式（SSE） | ❌ FAIL | 0.0s | 无可用模型（①失败且未配置 ASCEND_MODEL） |
| ④ 评委链路 ping | ⏭️ SKIP | 0.0s | 未配置 JUDGE_BASE_URL，跳过 |

**总结论：❌ FAIL（存在失败步骤）**
