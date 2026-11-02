import { Platform } from 'react-native';

// 浏览器直连 Lucky 服务会被 CORS 拦截（Lucky 不返回 Access-Control-Allow-Origin，
// 预检 OPTIONS 直接 403），原生 App 无此限制。web 端统一改走 Metro 开发服务器的
// /proxy 通道由 Node 侧转发，保持同源，见 metro.config.js。
export function toLuckyProxyUrl(url: string): string {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return url;
  if (!/^https?:\/\//i.test(url)) return url;
  if (typeof location !== 'undefined' && url.startsWith(`${location.origin}/`)) return url;
  const parsed = new URL(url);
  return `${window.location.origin}/proxy/${encodeURIComponent(parsed.origin)}${parsed.pathname}${parsed.search}`;
}
