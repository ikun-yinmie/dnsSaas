// provider 注册表
import { CloudflareProvider } from './cloudflare.js';
import { DnsheProvider } from './dnshe.js';
import { MockProvider } from './mock.js';

export function createProviders(config, { dryRun = false } = {}) {
  const map = new Map(); // name -> instance
  for (const p of config.providers) {
    if (p.enabled === false) continue; // 已禁用的服务商不注册
    if (dryRun) {
      map.set(p.name, new MockProvider(p.name, p));
      continue;
    }
    if (p.type === 'cloudflare') {
      map.set(p.name, new CloudflareProvider(p.name, p));
    } else if (p.type === 'dnshe') {
      map.set(p.name, new DnsheProvider(p.name, p));
    }
  }
  return map;
}
