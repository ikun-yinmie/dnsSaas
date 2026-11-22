// 优选IP:IP 池获取(手动 + 社区自动源) + TCP 443 连通测速择优
import net from 'node:net';
import { logger, fmtError } from './logger.js';
import { preferredSideCount } from './config.js';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validIPv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every((n) => Number(n) >= 0 && Number(n) <= 255);
}

// TCP 443 连接延迟,测 count 次返回中位数
function tcpPing(ip, port, { count = 3, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const samples = [];
    const attempt = (n) => {
      if (n <= 0) {
        if (samples.length === 0) return resolve({ ip, ms: null, samples: [], ok: false });
        samples.sort((a, b) => a - b);
        const mid = Math.floor(samples.length / 2);
        const median = samples.length % 2 ? samples[mid] : Math.round((samples[mid - 1] + samples[mid]) / 2);
        return resolve({ ip, ms: median, samples, ok: true });
      }
      const start = process.hrtime.bigint();
      const socket = net.connect({ host: ip, port, timeout: timeoutMs });
      const next = () => {
        socket.destroy();
        attempt(n - 1);
      };
      socket.once('connect', () => {
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
        next();
      });
      socket.once('timeout', next);
      socket.once('error', next);
    };
    attempt(count);
  });
}

// 从配置的 sources 拉取 IP 列表
async function fetchSource(source, timeoutMs = 10000) {
  if (typeof source === 'object' && source !== null) {
    source = source.url || '';
  }
  if (!source) return [];
  const resp = await fetch(source, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  const ips = [];
  if (source.includes('gacjie')) {
    // monitor.gacjie.cn: {status, info: {CM: [{ip, delay}], CU: [...], CT: [...]}}
    try {
      const json = JSON.parse(text);
      const info = json.info || {};
      for (const carrier of ['CM', 'CU', 'CT']) {
        for (const item of info[carrier] || []) {
          if (item?.ip && validIPv4(item.ip)) ips.push({ ip: item.ip, ms: item.delay });
        }
      }
    } catch {
      logger.warn(`优选源 ${source} JSON 解析失败`);
    }
  } else {
    // 纯文本:逗号/空白分隔的 IP 列表
    for (const token of text.split(/[\s,;<>"']+/)) {
      const ip = token.trim();
      if (validIPv4(ip)) ips.push({ ip, ms: null });
    }
  }
  return ips;
}

export class IpTester {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.running = false;
    this.timer = null;
  }

  // 刷新池 + 测速 + 更新 store.ips.best;返回最优 IP 列表
  async runOnce() {
    if (this.running) return this.store.ips.best;
    this.running = true;
    try {
      const poolCfg = this.config.ipPool;
      const raw = [];
      for (const src of poolCfg.sources) {
        try {
          const items = await fetchSource(src);
          logger.debug(`优选源 ${src} 获取 ${items.length} 个 IP`);
          raw.push(...items);
        } catch (e) {
          logger.warn(`优选源获取失败 ${src}: ${fmtError(e)}`);
        }
      }
      const pool = new Map();
      for (const item of raw) pool.set(item.ip, item);
      for (const ip of poolCfg.manual) {
        if (validIPv4(ip)) pool.set(ip, { ip, ms: null });
      }
      const list = [...pool.values()].filter((x) => validIPv4(x.ip));
      this.store.ips.poolSize = list.length;
      if (list.length === 0) {
        logger.warn('IP 池为空(所有源都失败?),保留上次优选结果');
        this.store.ips.lastError = 'IP 池为空';
        return this.store.ips.best;
      }

      // 并发测速
      const results = [];
      const queue = [...list];
      const workers = Array.from({ length: Math.min(poolCfg.concurrency, queue.length) }, async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          results.push(await tcpPing(item.ip, 443, { count: poolCfg.testCount, timeoutMs: poolCfg.testTimeoutMs }));
        }
      });
      await Promise.all(workers);

      const okList = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
      this.store.ips.all = results.map((r) => ({ ip: r.ip, ms: r.ms, samples: r.samples })).slice(0, 100);
      this.store.ips.testedAt = Date.now();
      this.store.ips.lastError = '';

      if (okList.length === 0) {
        logger.warn('优选测速:没有任何 IP 能连通 443 端口,保留上次结果');
        this.store.ips.lastError = '全部 IP 测速失败';
        return this.store.ips.best;
      }

      // 迟滞防抖:新最优 IP 需比当前最优快 20% 以上才更换排序,
      // 避免速度接近的 IP 之间来回翻转导致记录频繁变更
      // 保留条数 = max(需要的不同 IP 个数, maxIPs 上限)
      const needed = preferredSideCount(this.config.domains);
      const bestLimit = Math.max(needed, poolCfg.maxIPs || 1, 1);
      let best = okList.slice(0, bestLimit).map((r) => ({ ip: r.ip, ms: Math.round(r.ms) }));
      const prevBest = this.store.ips.best;
      if (prevBest.length > 0) {
        const stillOk = (ip) => okList.some((r) => r.ip === ip);
        const prevAlive = prevBest.filter((b) => stillOk(b.ip)).slice(0, bestLimit);
        if (prevAlive.length > 0) {
          const prevTopMs = okList.find((r) => r.ip === prevAlive[0].ip).ms;
          const newTopMs = okList[0].ms;
          if (!(newTopMs < prevTopMs * 0.8)) {
            best = prevAlive.map((b) => {
              const r = okList.find((x) => x.ip === b.ip);
              return { ip: b.ip, ms: Math.round(r.ms) };
            });
          }
        }
      }

      const prev = prevBest.map((b) => b.ip).join(',');
      const now = best.map((b) => b.ip).join(',');
      this.store.ips.best = best;
      logger.info(`优选IP 更新: [${now}](池 ${list.length} 个,最优 ${best[0].ip} ${best[0].ms}ms)`);
      if (prev !== now && typeof this.onChange === 'function') {
        this.onChange(best); // 通知 scheduler 同步所有 saas 域名
      }
      this.store.save();
      return best;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.config.ipPool.enabled) {
      logger.info('优选IP 测速已禁用(ipPool.enabled=false)');
      return;
    }
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (e) {
        logger.error(`优选IP 测速异常: ${fmtError(e)}`);
      }
      this.timer = setTimeout(tick, this.config.ipPool.intervalSec * 1000);
    };
    // 启动后 3 秒先跑一轮
    this.timer = setTimeout(tick, 3000);
  }

  stop() {
    clearTimeout(this.timer);
  }
}
