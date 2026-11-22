// Cloudflare DNS API v4 实现
// 文档: https://developers.cloudflare.com/api/resources/dns/subresources/records/
import { BaseProvider, fqdnOf } from './base.js';
import { fmtError } from '../logger.js';

export class CloudflareProvider extends BaseProvider {
  constructor(name, cfg) {
    super(name, cfg);
    this.zoneIds = new Map(); // zoneName -> zoneId
  }

  async request(method, apiPath, body) {
    // Token 会放进 Authorization 头,含中文/空格等非 ASCII 字符会直接报
    // "Cannot convert argument to a ByteString" —— 这里提前给出可读的错误
    if (!this.cfg.token || /[^\x21-\x7E]/.test(this.cfg.token)) {
      throw new Error('Cloudflare API Token 未配置或仍是示例占位文本(含中文),请在「服务商」里填入真实 Token');
    }
    const url = `${this.cfg.apiBase}${apiPath}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
      const errs = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
      throw new Error(`Cloudflare ${method} ${apiPath} 失败: HTTP ${resp.status} ${errs || resp.statusText}`);
    }
    return data;
  }

  async verify() {
    const data = await this.request('GET', '/user/tokens/verify');
    const status = data?.result?.status;
    if (status !== 'active') {
      throw new Error(`Cloudflare token 状态异常: ${status}`);
    }
    return `token 有效 (${data.result?.id || ''})`;
  }

  async resolveZone(zoneName) {
    if (this.zoneIds.has(zoneName)) return this.zoneIds.get(zoneName);
    const data = await this.request('GET', `/zones?name=${encodeURIComponent(zoneName)}&per_page=5`);
    const zone = data.result?.[0];
    if (!zone) throw new Error(`Cloudflare 找不到 zone: ${zoneName}(确认该域已添加到账号)`);
    this.zoneIds.set(zoneName, zone.id);
    return zone.id;
  }

  async listRecords(target) {
    const zoneId = await this.resolveZone(target.zone);
    const fqdn = fqdnOf(target);
    const out = [];
    let page = 1;
    for (;;) {
      const data = await this.request(
        'GET',
        `/zones/${zoneId}/dns_records?type=${target.type}&name=${encodeURIComponent(fqdn)}&per_page=100&page=${page}`,
      );
      for (const r of data.result || []) {
        out.push({
          id: r.id,
          type: r.type,
          name: r.name,
          content: r.content,
          ttl: r.ttl,
          proxied: !!r.proxied,
        });
      }
      const total = data.result_info?.total_pages || 1;
      if (page >= total) break;
      page++;
    }
    return out;
  }

  async createRecord(target, rec) {
    const zoneId = await this.resolveZone(target.zone);
    const fqdn = fqdnOf(target);
    const body = {
      type: rec.type,
      name: fqdn,
      content: rec.content,
      ttl: rec.ttl || 1, // CF: ttl=1 表示 Auto
      proxied: !!rec.proxied,
    };
    const data = await this.request('POST', `/zones/${zoneId}/dns_records`, body);
    return { id: data.result?.id };
  }

  async updateRecord(target, rec) {
    const zoneId = await this.resolveZone(target.zone);
    const fqdn = fqdnOf(target);
    const body = {
      type: rec.type,
      name: fqdn,
      content: rec.content,
      ttl: rec.ttl || 1,
      proxied: !!rec.proxied,
    };
    await this.request('PUT', `/zones/${zoneId}/dns_records/${rec.id}`, body);
    return { id: rec.id };
  }

  async deleteRecord(target, rec) {
    const zoneId = await this.resolveZone(target.zone);
    await this.request('DELETE', `/zones/${zoneId}/dns_records/${rec.id}`);
    return { id: rec.id };
  }
}
