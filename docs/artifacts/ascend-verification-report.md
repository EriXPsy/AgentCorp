# 昇腾端点冒烟验证报告

生成时间：2026-08-29T16:58:46.772Z（由 `verify:ascend` 自动生成，勿手改）

端点：(未配置)
模型：(取 /models 首个)

| 步骤 | 结果 | 耗时 | 说明 |
|---|---|---|---|
| ① GET /models 连通性 | ⏭️ SKIP | 0.0s | 未配置 ASCEND_BASE_URL / LLM_BASE_URL |
| ② POST /chat/completions 非流式 | ⏭️ SKIP | 0.0s | 未配置 ASCEND_BASE_URL / LLM_BASE_URL |
| ③ POST /chat/completions 流式（SSE） | ⏭️ SKIP | 0.0s | 未配置 ASCEND_BASE_URL / LLM_BASE_URL |
| ④ 评委链路 ping | ⏭️ SKIP | 0.0s | 未配置 ASCEND_BASE_URL / LLM_BASE_URL |

**总结论：⏭️ SKIP（未配置端点，全部跳过）**
