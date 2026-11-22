// 调度器:逐域名独立循环(检查 → 同步 → 互备/回滚/优选IP替换),互不阻塞
import { logger, fmtError } from './logger.js';
import { runCheck } from './checker.js';
import { sideFqdn, preferredSideCount } from './config.js';

const V4_SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com'];
const V6_SOURCES = ['https://api6.ipify.org', 'https://ipv6.icanhazip.com'];

let ipCache = { v4: { value: null, at: 0 }, v6: { value: null, at: 0 } };

function validIp(ip, family) {
  if (family === 4) return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
  return ip.includes(':');
}

async function detectPublicIp(family, timeoutMs = 8000) {
  const cache = family === 4 ? ipCache.v4 : ipCache.v6;
  if (cache.value && Date.now() - cache.at < 60_000) return cache.value;
  const sources = family === 4 ? V4_SOURCES : V6_SOURCES;
  for (const url of sources) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = (await resp.text()).trim().split('\n')[0].trim();
      if (validIp(text, family)) {
        cache.value = text;
        cache.at = Date.now();
        return text;
      }
    } catch { /* 试下一个源 */ }
  }
  return null;
}

// 全局优选IP 分配(纯函数,便于单测):
// 需要的每个"侧"(域名主侧/备侧)各分配一个不同 IP;
// 优先沿用上一轮分配(prev)与当前记录值(current),避免无谓变更;
// 池中 IP 不够时,超出部分返回空数组(该侧本轮不更新)
export function allocatePreferred(domains, bestIPs, opts = {}) {
  const best = [...new Set(bestIPs)];
  const limit = Math.max(1, Math.min(opts.limit || best.length || 1, best.length || 1));
  const bestSet = new Set(best);
  const used = new Set();
  const out = new Map();

  const pick = (...cands) => {
    for (const c of cands) {
      if (c && bestSet.has(c) && !used.has(c) && used.size < limit) {
        used.add(c);
        return [c];
      }
    }
    for (const ip of best) {
      if (!used.has(ip) && used.size < limit) {
        used.add(ip);
        return [ip];
      }
    }
    return [];
  };

  const wanted = (domains || []).filter(
    (d) => d.enabled !== false && d.mode === 'saas' && d.usePreferred !== false,
  );
  for (const d of wanted) {
    const pPrev = opts.prev?.get(d.id)?.primary?.[0];
    const bPrev = opts.prev?.get(d.id)?.backup?.[0];
    const pCur = opts.current?.get(d.id)?.primary?.[0];
    const bCur = opts.current?.get(d.id)?.backup?.[0];
    out.set(d.id, {
      primary: pick(pPrev, pCur),
      backup: d.backup ? pick(bPrev, bCur) : [],
    });
  }
  return out;
}

export class Scheduler {
  constructor(configManager, store, providers, ipTester, failover) {
    this.cm = configManager;
    this.store = store;
    this.providers = providers;
    this.ipTester = ipTester;
    this.failover = failover;
    this.timers = new Map();   // domainId -> timer
    this.busy = new Set();     // domainId -> 防重入
    this.stopped = false;
    this.assignment = new Map(); // domainId -> {primary:[ip], backup:[ip]}
  }

  start() {
    this.stopped = false;
    this.buildAssignment();
    const domains = this.cm.config.domains;
    domains.forEach((d, i) => {
      if (!d.enabled) {
        logger.info(`域名 ${d.id} 已禁用,跳过调度`);
        return;
      }
      // 启动错开,避免全部同时打 API
      this.scheduleLoop(d, 1500 + i * 2000);
    });
  }

  // 配置热重载/域名增删后重建调度(简单可靠:清空重排)
  restart() {
    this.stop();
    this.start();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  scheduleLoop(domain, delayMs) {
    const timer = setTimeout(async () => {
      await this.safeCycle(domain);
      if (this.stopped) return;
      const current = this.cm.config.domains.find((x) => x.id === domain.id);
      if (!current || current.enabled === false) {
        this.timers.delete(domain.id);
        return;
      }
      const interval = (current.check.intervalSec ?? 300) * 1000;
      const jitter = Math.floor(Math.random() * 5000);
      this.scheduleLoop(current, interval + jitter);
    }, delayMs);
    this.timers.set(domain.id, timer);
  }

  // 全局分配:按需要更新的"侧"数量,从优选池给每侧一个不同 IP
  buildAssignment() {
    const cfg = this.cm.config;
    const best = this.store.ips.best.map((b) => b.ip);
    const current = new Map();
    for (const [id, s] of this.store.domains) {
      current.set(id, {
        primary: s.primary?.currentValues || [],
        backup: s.backup?.currentValues || [],
      });
    }
    this.assignment = allocatePreferred(cfg.domains, best, {
      limit: cfg.ipPool.maxIPs,
      prev: this.assignment,
      current,
    });
    const wanted = cfg.domains.filter(
      (d) => d.enabled !== false && d.mode === 'saas' && d.usePreferred !== false,
    );
    const shortage = wanted.filter((d) => {
      const a = this.assignment.get(d.id);
      return !a || a.primary.length === 0 || (d.backup && a.backup.length === 0);
    });
    if (wanted.length > 0 && shortage.length > 0) {
      const need = preferredSideCount(cfg.domains);
      const have = Math.min(best.length, cfg.ipPool.maxIPs);
      logger.warn(`优选IP 不足:共需 ${need} 个不同 IP,当前可用 ${have} 个;${shortage.map((d) => d.id).join('、')} 本轮不更新记录(建议扩充 IP 池)`);
    }
    return this.assignment;
  }

  async safeCycle(domain, opts = {}) {
    if (this.busy.has(domain.id)) return false;
    this.busy.add(domain.id);
    try {
      await this.cycle(domain, opts);
      return true;
    } catch (e) {
      logger.error(`域名 ${domain.id} 周期异常: ${fmtError(e)}`);
      return false;
    } finally {
      this.busy.delete(domain.id);
    }
  }

  // 单个域名的一轮:计算期望值 → 同步(主+备) → 健康检查 → 故障处理
  async cycle(domain, opts = {}) {
    const s = this.store.getDomain(domain.id);
    if (!s) return;

    // 1. 按侧计算期望记录值(全局分配,各侧 IP 互不相同)
    const sideValues = await this.computeSideValues(domain);

    // 2. 逐侧同步(主侧;配置了备侧则备侧也同步)— 两侧互相独立
    const ctx = { synced: false, prevValuesBySide: {}, newValues: [] };
    for (const sideKey of ['primary', 'backup']) {
      const sideCfg = domain[sideKey];
      if (!sideCfg) continue;
      const want = (sideValues?.[sideKey] || []).map((v) => v).sort();
      if (want.length === 0) {
        if (sideKey === 'primary' && domain.mode === 'saas' && domain.usePreferred !== false) {
          logger.debug(`域名 ${domain.id}: 优选IP 尚未就绪/不足,本轮跳过同步`);
        }
        continue;
      }
      const provider = this.providers.get(sideCfg.provider);
      if (!provider) {
        logger.debug(`域名 ${domain.id}.${sideKey}: provider ${sideCfg.provider} 未启用或不存在,跳过同步`);
        continue;
      }
      try {
        const target = sideTargetOf(sideCfg);
        const cur = await provider.currentValues(target);
        s[sideKey].currentValues = cur.values;
        s[sideKey].lastError = ''; // 本次读取成功,清除该侧历史同步错误
        if (JSON.stringify(cur.values) !== JSON.stringify(want)) {
          ctx.prevValuesBySide[sideKey] = cur.values;
          const res = await provider.syncRecords(target, want, { purge: sideCfg.purge });
          s[sideKey].currentValues = res.values.sort();
          ctx.synced = true;
          ctx.newValues = [...new Set([...ctx.newValues, ...want])];
          s.lastUpdateAt = Date.now();
        }
      } catch (e) {
        s[sideKey].lastError = fmtError(e);
        logger.error(`域名 ${domain.id}.${sideKey} 同步失败: ${fmtError(e)}`);
      }
    }

    // 3. 健康检查(全部 check.urls)
    const check = await runCheck(domain);
    s.lastCheckAt = check.ts;
    s.lastCheckResult = checkSummary(check);
    this.store.appendHistory(domain.id, {
      ts: check.ts, ok: check.ok, code: check.code, ms: check.ms,
      tcpMs: check.tcpMs, error: check.error || undefined, synced: ctx.synced || undefined,
    });

    // 4. 故障处理:回滚 → 优选IP顶替 → 互备切换 / 告警
    const res = this.failover.handleDomainResult(domain, s, check, ctx);
    let stillFailing = !check.ok;

    for (const action of res.actions) {
      if (action.type === 'rollback') {
        await this.rollback(domain, action.valuesBySide);
        const recheck = await runCheck(domain);
        logger.info(`域名 ${domain.id} 回滚后复查: ${recheck.ok ? '恢复正常' : `仍失败: ${recheck.error}`}`);
        s.lastCheckAt = recheck.ts;
        s.lastCheckResult = checkSummary(recheck);
        if (recheck.ok) {
          stillFailing = false;
          s.fails = 0;
          s.primary.ok = true;
          for (const k of ['primary', 'backup']) {
            if (s[k] && s[k].currentValues.length) s.lastGoodValues[k] = [...s[k].currentValues];
          }
        }
      }
    }

    // 访问不通且达到阈值:先用优选池里其他 IP 顶替
    if (stillFailing && res.shouldRemediate) {
      const replaced = await this.tryRemediate(domain, s);
      if (!replaced) {
        if (res.switchToBackup) {
          s.activeSide = 'backup';
          this.failover.notify(`failover:${domain.id}`, `域名 ${domain.id}: 连续 ${s.fails} 次检查失败且优选IP替换无效,已切换到互备侧。错误: ${check.error}`);
        } else if (!s.backup) {
          this.failover.notify(`fail:${domain.id}`, `域名 ${domain.id}: 连续 ${s.fails} 次检查失败且无可用替换IP。错误: ${check.error}`);
        }
      }
    }

    this.failover.evaluateGlobal();
    this.store.save();
  }

  // 用优选池中的其他 IP 顶替不可用记录(排除被任何一侧占用的 IP)
  async tryRemediate(domain, s) {
    if (domain.mode !== 'saas' || domain.usePreferred === false) return false;
    const sideKey = s.activeSide === 'backup' && s.backup ? 'backup' : 'primary';
    const sideCfg = domain[sideKey];
    if (!sideCfg) return false;
    const provider = this.providers.get(sideCfg.provider);
    if (!provider) return false;

    const used = this.collectUsedIps();
    const ordered = [...new Set([
      ...this.store.ips.best.map((b) => b.ip),
      ...(this.store.ips.all || []).filter((r) => r.ms != null).map((r) => r.ip),
    ])];
    const candidates = ordered.filter((ip) => !used.has(ip)).slice(0, 3);
    if (candidates.length === 0) {
      logger.warn(`域名 ${domain.id}: 优选池中没有未被占用的可替换 IP`);
      return false;
    }

    const original = [...(s[sideKey].currentValues || [])];
    for (const ip of candidates) {
      try {
        await provider.syncRecords(sideTargetOf(sideCfg), [ip], { purge: sideCfg.purge });
        s[sideKey].currentValues = [ip];
        logger.info(`域名 ${domain.id}.${sideKey}: 尝试替换为优选 IP ${ip}`);
        const recheck = await runCheck(domain);
        this.store.appendHistory(domain.id, {
          ts: recheck.ts, ok: recheck.ok, code: recheck.code, ms: recheck.ms,
          replacedTo: ip, error: recheck.ok ? undefined : recheck.error,
        });
        if (recheck.ok) {
          s.lastCheckAt = recheck.ts;
          s.lastCheckResult = checkSummary(recheck);
          s.fails = 0;
          s[sideKey].ok = true;
          s[sideKey].lastError = '';
          s.lastGoodValues[sideKey] = [ip];
          s.lastUpdateAt = Date.now();
          const a = this.assignment.get(domain.id);
          if (a) a[sideKey] = [ip];
          await this.failover.notify(`replace:${domain.id}`, `域名 ${domain.id}: 原 IP 不通,已自动替换为优选 IP ${ip}(${recheck.ms}ms)`);
          return true;
        }
      } catch (e) {
        logger.error(`域名 ${domain.id}.${sideKey}: 替换为 ${ip} 失败: ${fmtError(e)}`);
      }
    }

    // 全部失败 → 还原原记录,交给互备切换/告警
    if (original.length > 0) {
      try {
        await provider.syncRecords(sideTargetOf(sideCfg), original, { purge: sideCfg.purge });
        s[sideKey].currentValues = original;
        logger.warn(`域名 ${domain.id}.${sideKey}: 优选IP 替换全部无效,已还原原记录 [${original.join(',')}]`);
      } catch (e) {
        logger.error(`域名 ${domain.id}.${sideKey} 还原失败: ${fmtError(e)}`);
      }
    }
    return false;
  }

  // 当前所有侧占用的 IP(用于保证各记录 IP 不重复)
  collectUsedIps() {
    const used = new Set();
    for (const s of this.store.domains.values()) {
      for (const k of ['primary', 'backup']) {
        for (const ip of s[k]?.currentValues || []) used.add(ip);
      }
    }
    return used;
  }

  async rollback(domain, valuesBySide) {
    for (const [sideKey, values] of Object.entries(valuesBySide)) {
      const sideCfg = domain[sideKey];
      if (!sideCfg) continue;
      const provider = this.providers.get(sideCfg.provider);
      if (!provider) continue;
      try {
        const res = await provider.syncRecords(sideTargetOf(sideCfg), [...values].sort(), { purge: sideCfg.purge });
        const s = this.store.getDomain(domain.id);
        s[sideKey].currentValues = res.values.sort();
        logger.warn(`域名 ${domain.id}.${sideKey} 已回滚到: [${res.values.join(', ')}]`);
      } catch (e) {
        logger.error(`域名 ${domain.id}.${sideKey} 回滚失败: ${fmtError(e)}`);
      }
    }
  }

  // 按侧计算期望记录值 {primary: [], backup: []};null 表示本轮无值可写
  async computeSideValues(domain) {
    if (domain.mode === 'saas') {
      if (domain.usePreferred === false) return { primary: [], backup: [] }; // 不参与优选分配
      if (this.assignment.size === 0) this.buildAssignment();
      const a = this.assignment.get(domain.id);
      return {
        primary: [...(a?.primary || [])],
        backup: domain.backup ? [...(a?.backup || [])] : [],
      };
    }
    if (domain.mode === 'static') {
      return {
        primary: [...domain.primary.values],
        backup: domain.backup
          ? (domain.backup.values.length > 0 ? [...domain.backup.values] : [...domain.primary.values])
          : [],
      };
    }
    if (domain.mode === 'ddns') {
      const family = domain.primary.type === 'AAAA' ? 6 : 4;
      const ip = await detectPublicIp(family);
      if (!ip) {
        logger.warn(`域名 ${domain.id}: 公网 IPv${family} 检测失败,本轮跳过`);
        return null;
      }
      return { primary: [ip], backup: domain.backup ? [ip] : [] };
    }
    return null;
  }

  // UI 按钮:立即检测/同步
  trigger(domainId) {
    const domain = this.cm.config.domains.find((d) => d.id === domainId);
    if (!domain) return Promise.resolve(false);
    return this.safeCycle(domain, { manual: true });
  }

  // 等待所有在途域名周期结束(--once 退出前用)
  async waitIdle(timeoutMs = 30000) {
    const start = Date.now();
    while (this.busy.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // 优选IP 变化后,重建分配并同步所有参与的 saas 域名
  async syncAllSaas(reason = '') {
    this.buildAssignment();
    const domains = this.cm.config.domains.filter(
      (d) => d.mode === 'saas' && d.enabled && d.usePreferred !== false,
    );
    logger.info(`优选IP 变化,同步 ${domains.length} 个 saas 域名 ${reason}`);
    for (const d of domains) {
      await this.safeCycle(d, { reason: 'ip-changed' });
    }
  }

  // 立即测速一轮并同步(--once / UI 按钮用)
  async testAndSync() {
    await this.ipTester.runOnce();
    await this.syncAllSaas('手动触发');
  }
}

function checkSummary(check) {
  return {
    ok: check.ok, code: check.code, ms: check.ms, tcpMs: check.tcpMs, tlsMs: check.tlsMs,
    error: check.error, serverIp: check.serverIp, dnsDesc: check.dnsDesc,
  };
}

export function sideTargetOf(sideCfg) {
  return {
    zone: sideCfg.zone || undefined,
    subdomain: sideCfg.subdomain || undefined,
    name: sideCfg.name,
    type: sideCfg.type,
    ttl: sideCfg.ttl,
    proxied: sideCfg.proxied,
    extra: sideCfg.extra,
  };
}

export { sideFqdn };
