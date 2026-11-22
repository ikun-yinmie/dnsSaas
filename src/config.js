// 配置加载 / 校验 / 热重载
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { logger, fmtError } from './logger.js';

export class ConfigError extends Error {}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v, dflt, min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return min != null ? Math.max(min, n) : n;
}

// 侧记录的 FQDN:CF 用 zone+name 拼接;dnshe 的子域本身就是主名,name 为 *
export function sideFqdn(side) {
  const name = (side.name || '@').trim();
  const base = side.subdomain || side.zone || '';
  if (!name || name === '@') return base;
  if (name === '*') return base.startsWith('*.') ? base : `*.${base}`;
  if (name.includes('.') || name.includes('*')) return name;
  return `${name}.${base}`;
}

export function normalizeSide(raw, idx, label) {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError(`${label}: 缺少配置对象`);
  }
  if (!raw.provider) throw new ConfigError(`${label}: 缺少 provider(引用 providers[].name)`);
  const side = {
    provider: raw.provider,
    subdomain: raw.subdomain || '',   // dnshe 子域名,如 example.com
    zone: raw.zone || '',             // cloudflare zone,如 example.net
    name: raw.name == null ? '@' : String(raw.name),
    type: (raw.type || 'A').toUpperCase(),
    ttl: num(raw.ttl, 600, 1),
    proxied: !!raw.proxied,
    purge: raw.purge !== false,       // 收敛多余同名记录
    values: asArray(raw.values).map(String),
    extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : {},
  };
  if (!side.subdomain && !side.zone) {
    throw new ConfigError(`${label}: 需要 subdomain(dnshe)或 zone(cloudflare)`);
  }
  if (!['A', 'AAAA', 'CNAME'].includes(side.type)) {
    throw new ConfigError(`${label}: type 仅支持 A/AAAA/CNAME`);
  }
  if (side.type === 'CNAME' && side.values.length > 1) {
    throw new ConfigError(`${label}: CNAME 只允许一个值`);
  }
  return side;
}

export function normalizeDomain(raw, idx) {
  if (!raw || typeof raw !== 'object') throw new ConfigError(`domains[${idx}]: 不是对象`);
  const id = String(raw.id || '').trim() || `domain-${idx + 1}`;
  const d = {
    id,
    mode: ['saas', 'ddns', 'static'].includes(raw.mode) ? raw.mode : 'static',
    primary: normalizeSide(raw.primary, idx, `domains[${id}].primary`),
    backup: raw.backup ? normalizeSide(raw.backup, idx, `domains[${id}].backup`) : null,
    enabled: raw.enabled !== false,
  };
  const c = raw.check && typeof raw.check === 'object' ? raw.check : {};
  const urls = asArray(c.urls);
  if (urls.length === 0) {
    urls.push(`https://${sideFqdn(d.primary)}/`);
    logger.warn(`domains[${id}].check.urls 未配置,默认用 https://${sideFqdn(d.primary)}/`);
  }
  d.check = {
    urls,
    expectStatus: asArray(c.expectStatus).map(Number).filter(Number.isInteger),
    followRedirects: c.followRedirects !== false,
    timeoutMs: num(c.timeoutMs, 8000, 1000),
    intervalSec: num(c.intervalSec, 300, 10),
    failThreshold: num(c.failThreshold, 3, 1),
    method: (c.method || 'GET').toUpperCase(),
  };
  // 是否参与优选IP 分配(saas 模式下生效,关闭后该域名记录不自动分配/更新)
  d.usePreferred = raw.usePreferred !== false;
  if (d.check.expectStatus.length === 0) {
    d.check.expectStatus = [200, 204, 301, 302, 304, 401];
  }
  if (d.mode === 'static' && d.primary.values.length === 0) {
    throw new ConfigError(`domains[${id}]: mode=static 需要 primary.values`);
  }
  return d;
}

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('配置不是对象');
  const server = cfg.server && typeof cfg.server === 'object' ? cfg.server : {};
  cfg.server = {
    host: server.host || '127.0.0.1',
    port: num(server.port, 9877, 1),
    password: server.password ? String(server.password) : '',
  };

  const providers = asArray(cfg.providers);
  const seen = new Set();
  cfg.providers = providers.map((p, i) => {
    if (!p || typeof p !== 'object') throw new ConfigError(`providers[${i}]: 不是对象`);
    const name = String(p.name || '').trim();
    if (!name) throw new ConfigError(`providers[${i}]: 缺少 name`);
    if (seen.has(name)) throw new ConfigError(`providers 名称重复: ${name}`);
    seen.add(name);
    const type = String(p.type || '').toLowerCase();
    if (!['cloudflare', 'dnshe'].includes(type)) {
      throw new ConfigError(`providers[${name}]: type 仅支持 cloudflare / dnshe`);
    }
    const out = { name, type, enabled: p.enabled !== false };
    if (type === 'cloudflare') {
      if (!p.token) throw new ConfigError(`providers[${name}]: cloudflare 需要 token(API Token,Zone.DNS Edit)`);
      if (/[^\x21-\x7E]/.test(String(p.token))) {
        logger.warn(`providers[${name}]: token 看起来还是示例占位文本(含中文),请替换为真实 API Token`);
      }
      out.token = String(p.token);
      out.apiBase = p.apiBase || 'https://api.cloudflare.com/client/v4';
    } else {
      if (!p.apiKey || !p.apiSecret) {
        throw new ConfigError(`providers[${name}]: dnshe 需要 apiKey(X-API-Key)和 apiSecret(X-API-Secret)`);
      }
      if (!String(p.apiKey).startsWith('cfsd_')) {
        logger.warn(`providers[${name}]: apiKey 不是 cfsd_ 开头,请确认填的是面板「API管理」生成的密钥`);
      }
      out.apiKey = String(p.apiKey);
      out.apiSecret = String(p.apiSecret);
      out.apiBase = p.apiBase || 'https://api005.dnshe.com';
    }
    return out;
  });

  const domains = asArray(cfg.domains);
  const ids = new Set();
  cfg.domains = domains.map((d, i) => {
    const nd = normalizeDomain(d, i);
    if (ids.has(nd.id)) throw new ConfigError(`domains id 重复: ${nd.id}`);
    ids.add(nd.id);
    for (const side of [nd.primary, nd.backup]) {
      if (side && !seen.has(side.provider)) {
        throw new ConfigError(`domains[${nd.id}] 引用了不存在的 provider: ${side.provider}`);
      }
    }
    return nd;
  });

  const pool = cfg.ipPool && typeof cfg.ipPool === 'object' ? cfg.ipPool : {};
  cfg.ipPool = {
    sources: asArray(pool.sources).map(String),
    manual: asArray(pool.manual).map(String),
    testCount: num(pool.testCount, 3, 1),
    testTimeoutMs: num(pool.testTimeoutMs, 2000, 200),
    concurrency: num(pool.concurrency, 8, 1),
    maxIPs: num(pool.maxIPs, 8, 1),
    intervalSec: num(pool.intervalSec, 3600, 60),
    enabled: pool.enabled !== false,
  };

  const notify = cfg.notify && typeof cfg.notify === 'object' ? cfg.notify : {};
  cfg.notify = {
    webhook: notify.webhook ? String(notify.webhook) : '',
    cooldownSec: num(notify.cooldownSec, 1800, 60),
  };
  return cfg;
}

// 参与优选IP 分配的"侧"总数(每个域名主侧 + 有互备时的备侧,各需一个不同 IP)
export function preferredSideCount(domains) {
  return (domains || [])
    .filter((d) => d.enabled !== false && d.mode === 'saas' && d.usePreferred !== false)
    .reduce((n, d) => n + (d.backup ? 2 : 1), 0);
}

export function loadConfigFile(file) {  const text = fs.readFileSync(file, 'utf8');
  const raw = YAML.parse(text);
  return validateConfig(raw || {});
}

export class ConfigManager {
  constructor(file) {
    this.file = path.resolve(file);
    this.config = loadConfigFile(this.file);
    this.reloadListeners = new Set();
    this.watcher = null;
    this.reloadTimer = null;
  }

  get config() {
    return this._config;
  }

  set config(v) {
    this._config = v;
  }

  onReload(fn) {
    this.reloadListeners.add(fn);
    return () => this.reloadListeners.delete(fn);
  }

  startWatching() {
    try {
      this.watcher = fs.watch(this.file, () => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), 500);
      });
    } catch (e) {
      logger.warn(`配置热重载不可用: ${fmtError(e)}`);
    }
  }

  stopWatching() {
    if (this.watcher) this.watcher.close();
    clearTimeout(this.reloadTimer);
  }

  reload() {
    try {
      const next = loadConfigFile(this.file);
      const old = this.config;
      this.config = next;
      logger.info(`配置已热重载: ${this.file}`);
      for (const fn of this.reloadListeners) {
        try { fn(next, old); } catch (e) { logger.error(`reload 回调出错: ${fmtError(e)}`); }
      }
    } catch (e) {
      logger.error(`配置重载失败(保留旧配置): ${fmtError(e)}`);
    }
  }

  toYaml() {
    return YAML.stringify(this.config);
  }

  saveYamlText(text) {
    const raw = YAML.parse(text);
    validateConfig(raw || {}); // 校验通过才落盘
    fs.writeFileSync(this.file, text.endsWith('\n') ? text : text + '\n', 'utf8');
    this.reload();
  }
}
