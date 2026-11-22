// Mock provider:--dry-run 模式使用,不产生真实 API 请求
import { BaseProvider, fqdnOf } from './base.js';

export class MockProvider extends BaseProvider {
  constructor(name, cfg) {
    super(name, cfg);
    this.store = new Map(); // `${fqdn}|${type}` -> [{id, content, ttl}]
    this.nextId = 1;
    this.failNext = false; // 测试用:模拟一次 API 故障
  }

  key(target) {
    return `${fqdnOf(target)}|${target.type}`;
  }

  async verify() {
    if (this.failNext) throw new Error('mock: 模拟故障');
    return 'mock provider 连接正常';
  }

  async listRecords(target) {
    return (this.store.get(this.key(target)) || []).map((r) => ({ ...r, name: fqdnOf(target), proxied: !!target.proxied }));
  }

  async createRecord(target, rec) {
    const k = this.key(target);
    const list = this.store.get(k) || [];
    list.push({ id: String(this.nextId++), type: rec.type, content: rec.content, ttl: rec.ttl });
    this.store.set(k, list);
    return { id: String(this.nextId - 1) };
  }

  async updateRecord(target, rec) {
    const k = this.key(target);
    const list = this.store.get(k) || [];
    const r = list.find((x) => String(x.id) === String(rec.id));
    if (r) Object.assign(r, { content: rec.content, ttl: rec.ttl });
    return { id: rec.id };
  }

  async deleteRecord(target, rec) {
    const k = this.key(target);
    this.store.set(k, (this.store.get(k) || []).filter((x) => String(x.id) !== String(rec.id)));
    return { id: rec.id };
  }
}
