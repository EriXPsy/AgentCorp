# 昇腾端点冒烟验证报告

生成时间：2026-08-31T06:36:04.512Z（由 `verify:ascend` 自动生成，勿手改）

端点：https://api.deepseek.com/v1
模型：deepseek-chat

| 步骤 | 结果 | 耗时 | 说明 |
|---|---|---|---|
| ① GET /models 连通性 | ✅ PASS | 0.6s | 模型列表 3 个，使用模型：deepseek-chat |
| ② POST /chat/completions 非流式 | ✅ PASS | 0.9s | content 长度 18 |
| ③ POST /chat/completions 流式（SSE） | ✅ PASS | 0.7s | 收到 10 个 SSE 分片 |
| ④ 评委链路 ping | ⏭️ SKIP | 0.0s | 未配置 JUDGE_BASE_URL，跳过 |

**总结论：✅ PASS（全部冒烟通过）**
