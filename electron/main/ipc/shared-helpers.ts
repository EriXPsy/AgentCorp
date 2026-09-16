/**
 * @domain ipc
 * @purpose 设置净化工具（unified-request 与 settings 共用）。
 * @behaviors 按渲染层可写键白名单净化设置对象
 * @dive details: settings.ts / unified-request.ts
 */
import type { AppSettings } from '../../shared/settings';

function sanitizeRendererSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings[K] {
  if (key === 'gatewayToken') {
    return '' as AppSettings[K];
  }
  return value;
}

function sanitizeRendererSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    gatewayToken: '',
  };
}
