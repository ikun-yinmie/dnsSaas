// DNS 服务商统一接口
// 目标(target)字段约定:
//   cloudflare: { zone: "example.net", name: "*" | "@" | "lsky", type, ttl, proxied }
//   dnshe:      { subdomain: "example.com", name: "*", type, ttl, extra }
import { logger, fmtError } from '../logger.js';

export function fqdnOf(target) {
  const name = (target.name || '@').trim();
  const base = target.zone || target.subdomain || '';
  if (!name || name === '@') return base;
  if (name === '*') return base.startsWith('*.') ? base : `*.${base}`;
  if (name.includes('.') || name.includes('*')) return name;
  return `${name}.${base}`;
}

export class BaseProvider {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
  }

  // 连通性/凭证测试,成功返回描述字符串,失败抛错
  async verify() {
    throw new Error('not implemented');
  }

  // 返回 [{id, type, name, content, ttl, proxied}]
  async listRecords(target) {
    throw new Error('not implemented');
  }

  async createRecord(target, rec) {
    throw new Error('not implemented');
  }

  async updateRecord(target, rec) {
    throw new Error('not implemented');
  }

  async deleteRecord(target, rec) {
    throw new Error('not implemented');
  }

  // 把 name+type 的记录集收敛到 values[](幂等):
  // 已存在且内容一致 → 保留;缺 → 创建;多余 → 删除(purge=false 时不删)
  // 返回 {values, created, updated, deleted, kept, recordValues}
  async syncRecords(target, values, { purge = true } = {}) {
    const fqdn = fqdnOf(target);
    const existing = (await this.listRecords(target)).filter((r) => r.type === target.type);
    const ops = { created: 0, updated: 0, deleted: 0, kept: 0 };
    const recordValues = [];

    const wanted = [...new Set(values)];
    const remaining = [...existing];

    for (const value of wanted) {
      const idx = remaining.findIndex((r) => r.content === value);
      if (idx >= 0) {
        const rec = remaining.splice(idx, 1)[0];
        recordValues.push(rec.content);
        ops.kept++;
      } else if (remaining.length > 0) {
        // 没有内容一致的,就地改一条多余的(减少 API 调用)
        const rec = remaining.shift();
        await this.updateRecord(target, { ...rec, type: target.type, content: value, ttl: target.ttl });
        recordValues.push(value);
        ops.updated++;
      } else {
        await this.createRecord(target, {
          type: target.type, name: target.name, content: value, ttl: target.ttl,
          proxied: target.proxied || false,
        });
        recordValues.push(value);
        ops.created++;
      }
    }

    if (purge && remaining.length > 0) {
      for (const rec of remaining) {
        await this.deleteRecord(target, rec);
        ops.deleted++;
      }
    }

    if (ops.created || ops.updated || ops.deleted) {
      logger.info(`[${this.name}] ${fqdn} ${target.type} 同步: 新建${ops.created} 更新${ops.updated} 删除${ops.deleted} 保留${ops.kept} → [${recordValues.join(', ')}]`);
    }
    return { ...ops, values: recordValues };
  }

  // 读取当前记录值(排序后),用于漂移检测
  async currentValues(target) {
    const fqdn = fqdnOf(target);
    const recs = (await this.listRecords(target)).filter((r) => r.type === target.type);
    return { fqdn, values: recs.map((r) => r.content).sort() };
  }
}

export function fmtProviderError(e) {
  return fmtError(e);
}
