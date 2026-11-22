// DNSHE v2 domain_hub API 实现
// 文档: my.dnshe.com 知识库《DNSHE免费域名API使用文档 V2.0》
// Base: {apiBase}/index.php?m=domain_hub,认证头 X-API-Key + X-API-Secret(cfsd_ 前缀密钥)
// 模型: 子域名(subdomain_id) → 记录(dns_records)
import { BaseProvider, fqdnOf } from './base.js';

export class DnsheProvider extends BaseProvider {
  constructor(name, cfg) {
    super(name, cfg);
    this.subdomainIds = new Map(); // 子域名 -> subdomain_id
  }

  url(endpoint, action, query = {}) {
    const base = `${this.cfg.apiBase}/index.php?m=domain_hub`;
    const qs = new URLSearchParams({ endpoint, action, ...query });
    return `${base}&${qs.toString()}`;
  }

  async request(endpoint, action, { method = 'GET', body = null, query = {} } = {}) {
    const resp = await fetch(this.url(endpoint, action, query), {
      method,
      headers: {
        'X-API-Key': this.cfg.apiKey,
        'X-API-Secret': this.cfg.apiSecret,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
      throw new Error(
        `DNSHE ${endpoint}/${action} 失败: HTTP ${resp.status} ${data.error_code || ''} ${data.message || ''}`.trim(),
      );
    }
    return data;
  }

  async verify() {
    const data = await this.request('subdomains', 'list');
    const list = data?.data?.subdomains || data?.subdomains || [];
    return `连接成功,共 ${Array.isArray(list) ? list.length : '?'} 个子域名`;
  }

  // 找到子域名的 subdomain_id(带缓存)
  // 实测返回结构:{success, count, subdomains:[{id, subdomain:"demo", rootdomain:"example.com", full_domain:"demo.example.com", ...}]}
  async resolveSubdomainId(subdomainName) {
    if (this.subdomainIds.has(subdomainName)) return this.subdomainIds.get(subdomainName);
    let page = 1;
    for (;;) {
      const data = await this.request('subdomains', 'list', { query: { page, per_page: 100 } });
      const list = data?.data?.subdomains || data?.subdomains || [];
      const found = list.find((s) => {
        const full = String(s.full_domain || '').toLowerCase();
        const composed = [s.subdomain, s.rootdomain].filter(Boolean).join('.').toLowerCase();
        return full === subdomainName.toLowerCase() || composed === subdomainName.toLowerCase();
      });
      if (found) {
        const id = found.id ?? found.subdomain_id;
        this.subdomainIds.set(subdomainName, id);
        return id;
      }
      const totalPages = data?.data?.total_pages ?? data?.total_pages ?? 1;
      if (page >= totalPages || list.length === 0) {
        const available = list.map((s) => s.full_domain || `${s.subdomain}.${s.rootdomain}`).slice(0, 8).join('、');
        throw new Error(
          `DNSHE 找不到子域名: ${subdomainName}(确认已在面板注册且 API 密钥有权限)${available ? `;当前账号可用: ${available}` : ''}`,
        );
      }
      page++;
    }
  }

  async listRecords(target) {
    const subId = await this.resolveSubdomainId(target.subdomain);
    const out = [];
    let page = 1;
    for (;;) {
      const data = await this.request('dns_records', 'list', {
        query: { subdomain_id: subId, page, per_page: 100 },
      });
      const payload = data?.data || data;
      const list = payload?.records || payload?.list || [];
      for (const r of list) {
        out.push({
          id: r.id ?? r.record_id,
          type: (r.type || '').toUpperCase(),
          name: r.name || '@',
          content: r.content ?? r.value,
          ttl: r.ttl,
          proxied: !!r.proxied,
        });
      }
      const totalPages = payload?.total_pages ?? 1;
      if (page >= totalPages || list.length === 0) break;
      page++;
    }
    return out;
  }

  async createRecord(target, rec) {
    const subId = await this.resolveSubdomainId(target.subdomain);
    const body = { subdomain_id: subId, type: rec.type, content: rec.content, ttl: rec.ttl };
    // 实测:创建时传 name 为"标签"形式,DNSHE 会自动拼成完整域名
    // '*' → *.example.com;'@'/缺省 → 子域主名;子标签 'lsky' → lsky.example.com
    const label = this.toLabel(rec.name, target.subdomain);
    if (label && label !== '@') body.name = label;
    Object.assign(body, target.extra || {});
    const data = await this.request('dns_records', 'create', { method: 'POST', body });
    return { id: data?.id ?? data?.data?.id };
  }

  // 把任意形式的记录名转成 DNSHE 的标签形式
  toLabel(name, subdomain) {
    let label = String(name || '@').trim();
    const base = String(subdomain || '').toLowerCase();
    const lower = label.toLowerCase();
    if (lower === base || lower === `@.${base}` || label === '@') return '@';
    if (lower === `*.${base}`) return '*';
    if (lower.endsWith(`.${base}`)) label = label.slice(0, label.length - base.length - 1);
    return label; // '*' 或 'lsky' 等标签
  }

  async updateRecord(target, rec) {
    const body = { id: rec.id, type: rec.type, content: rec.content };
    if (rec.ttl) body.ttl = rec.ttl;
    const data = await this.request('dns_records', 'update', { method: 'POST', body });
    return { id: data?.id ?? rec.id };
  }

  async deleteRecord(target, rec) {
    await this.request('dns_records', 'delete', { method: 'POST', body: { id: rec.id } });
    return { id: rec.id };
  }

  // 覆盖 base:只按 type 过滤,因为 dnshe 的记录挂在子域名下,
  // 同类型不同标签(* 与 @)都会返回,这里按目标主名过滤
  // 实测记录的 name 是完整域名形式(如 "*.example.com"、"lsky.example.com")
  filterByHost(records, target) {
    const fqdn = fqdnOf(target);
    const base = String(target.subdomain || '').toLowerCase();
    return records.filter((r) => {
      if (r.type !== target.type) return false;
      const n = String(r.name || '').trim().toLowerCase();
      const label = (target.name || '@').trim();
      if (label === '*') {
        return n === `*.${base}` || n === '*' || n === fqdn.toLowerCase();
      }
      if (label === '@') {
        return n === base || n === '@' || n === fqdn.toLowerCase();
      }
      return n === label.toLowerCase() || n === fqdn.toLowerCase();
    });
  }

  async syncRecords(target, values, opts = {}) {
    // 先按主机名过滤再收敛,避免误动同子域名下其它标签的记录
    const fqdn = fqdnOf(target);
    const existingAll = await this.listRecords(target);
    const existing = this.filterByHost(existingAll, target);
    const ops = { created: 0, updated: 0, deleted: 0, kept: 0 };
    const recordValues = [];
    const remaining = [...existing];
    const wanted = [...new Set(values)];

    for (const value of wanted) {
      const idx = remaining.findIndex((r) => r.content === value);
      if (idx >= 0) {
        remaining.splice(idx, 1)[0];
        recordValues.push(value);
        ops.kept++;
      } else if (remaining.length > 0) {
        const rec = remaining.shift();
        await this.updateRecord(target, { ...rec, type: target.type, content: value, ttl: target.ttl });
        recordValues.push(value);
        ops.updated++;
      } else {
        await this.createRecord(target, { type: target.type, content: value, ttl: target.ttl, name: target.name });
        recordValues.push(value);
        ops.created++;
      }
    }
    if (opts.purge !== false && remaining.length > 0) {
      for (const rec of remaining) {
        await this.deleteRecord(target, rec);
        ops.deleted++;
      }
    }
    if (ops.created || ops.updated || ops.deleted) {
      const { logger } = await import('../logger.js');
      logger.info(`[${this.name}] ${fqdn} ${target.type} 同步: 新建${ops.created} 更新${ops.updated} 删除${ops.deleted} 保留${ops.kept} → [${recordValues.join(', ')}]`);
    }
    return { ...ops, values: recordValues };
  }
}
