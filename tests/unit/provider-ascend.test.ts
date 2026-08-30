/**
 * tests/unit/provider-ascend.test.ts
 *
 * 华为昇腾（huawei-ascend）provider 注册回归锁定：
 *  1) 共享 registry（electron/shared/providers）定义完整：
 *     api 协议 openai-completions、baseUrl 占位、apiKeyEnv=ASCEND_API_KEY；
 *  2) PROVIDER_TYPES / BUILTIN_PROVIDER_TYPES（前后端双注册表）均包含 huawei-ascend；
 *  3) 前端 PROVIDER_TYPE_INFO 同步存在且与后端定义一致；
 *  4) key 校验兼容性：provider-validation.ts 的 getValidationProfile 按
 *     providerConfig.api 选择 profile，api=openai-completions 时走
 *     OpenAI 兼容校验（GET /models + chat/completions 兜底探测），
 *     与 vLLM-Ascend / MindIE / 华为云 MaaS 的 OpenAI 兼容端点天然兼容。
 *     这里锁定该校验所需的输入（apiKeyEnv + providerConfig.api + baseUrl），
 *     防回归（不联网探测真实端点）。
 */
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PROVIDER_TYPES as BACKEND_BUILTIN_PROVIDER_TYPES,
  PROVIDER_TYPES as BACKEND_PROVIDER_TYPES,
} from '@electron/shared/providers/types';
import {
  getProviderBackendConfig,
  getProviderDefinition,
  getProviderEnvVar,
} from '@electron/shared/providers/registry';
import {
  BUILTIN_PROVIDER_TYPES as FRONTEND_BUILTIN_PROVIDER_TYPES,
  PROVIDER_TYPE_INFO,
  PROVIDER_TYPES as FRONTEND_PROVIDER_TYPES,
  getProviderIconUrl,
} from '@/lib/providers';

const ASCEND_ID = 'huawei-ascend';

describe('huawei-ascend provider 注册', () => {
  it('后端 PROVIDER_TYPES / BUILTIN_PROVIDER_TYPES 均包含 huawei-ascend', () => {
    expect(BACKEND_PROVIDER_TYPES).toContain(ASCEND_ID);
    expect(BACKEND_BUILTIN_PROVIDER_TYPES).toContain(ASCEND_ID);
  });

  it('前端 PROVIDER_TYPES / BUILTIN_PROVIDER_TYPES 均包含 huawei-ascend', () => {
    expect(FRONTEND_PROVIDER_TYPES).toContain(ASCEND_ID);
    expect(FRONTEND_BUILTIN_PROVIDER_TYPES).toContain(ASCEND_ID);
  });

  it('registry 中 huawei-ascend 定义完整（api/baseUrl/apiKeyEnv）', () => {
    const definition = getProviderDefinition(ASCEND_ID);
    expect(definition).toBeDefined();
    expect(definition?.name).toContain('昇腾');
    expect(definition?.requiresApiKey).toBe(true);
    expect(definition?.envVar).toBe('ASCEND_API_KEY');
    expect(definition?.category).toBe('compatible');

    const backend = getProviderBackendConfig(ASCEND_ID);
    expect(backend).toBeDefined();
    expect(backend?.api).toBe('openai-completions');
    expect(backend?.baseUrl).toBe('http://ascend-host:8000/v1');
    expect(backend?.apiKeyEnv).toBe('ASCEND_API_KEY');

    expect(getProviderEnvVar(ASCEND_ID)).toBe('ASCEND_API_KEY');
  });

  it('前端 PROVIDER_TYPE_INFO 同步存在且与后端定义一致', () => {
    const info = PROVIDER_TYPE_INFO.find((t) => t.id === ASCEND_ID);
    expect(info).toBeDefined();
    expect(info?.name).toContain('昇腾');
    expect(info?.requiresApiKey).toBe(true);
    expect(info?.defaultBaseUrl).toBe('http://ascend-host:8000/v1');
    expect(info?.showBaseUrl).toBe(true);
    expect(info?.showModelId).toBe(true);
    // OpenAI 兼容端点没有官方 logo，用字母徽章 svg
    expect(getProviderIconUrl(ASCEND_ID)).toBeTruthy();
  });

  it('key 校验走默认 openai-completions profile（provider-validation 无需改动）', () => {
    // getValidationProfile() 的依据：providerConfig.api === 'openai-completions'
    // → validateOpenAiCompatibleKey（GET {base}/models，404 时回退
    // POST /chat/completions 探测）。锁定这组输入即锁定校验兼容性。
    const backend = getProviderBackendConfig(ASCEND_ID);
    expect(backend?.api).toBe('openai-completions');
    expect(backend?.apiKeyEnv).toBe('ASCEND_API_KEY');
    expect(backend?.baseUrl.endsWith('/v1')).toBe(true);
  });
});
