// 运行状态:内存 + state.json 持久化 + history.jsonl 追加
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const HISTORY_MAX = 50; // 每个域名保留最近 N 条检查记录

function newSideState() {
  return {
    ok: null,
    fails: 0,
    lastError: '',
    lastCheck: null,      // 最近一次完整检查结果
    currentValues: [],    // 当前记录内容(listRecords 得到)
  };
}

export function newDomainState(d) {
  return {
    id: d.id,
    mode: d.mode,
    enabled: d.enabled,
    activeSide: 'primary',
    fails: 0,             // 域名级连续检查失败次数
    primary: newSideState(),
    backup: d.backup ? newSideState() : null,
    lastGoodValues: { primary: [], backup: [] }, // 各侧最近一次检查通过时的记录值(用于回滚)
    lastUpdateAt: null,
    lastCheckAt: null,
    nextCheckAt: null,
    alerts: {},           // 告警去重 {key: ts}
    history: [],
  };
}

export class Store {
  constructor(stateFile, historyFile) {
    this.stateFile = stateFile;
    this.historyFile = historyFile;
    this.domains = new Map(); // id -> state
    this.ips = {
      best: [],        // [{ip, ms}]
      all: [],         // [{ip, ms, samples}]
      testedAt: null,
      poolSize: 0,
      lastError: '',
    };
    this.providers = new Map(); // name -> {name, type, ok, lastError, lastVerifyAt}
    this.startedAt = Date.now();
    this.historyFd = null;
  }

  initDomain(d) {
    if (!this.domains.has(d.id)) {
      this.domains.set(d.id, newDomainState(d));
    } else {
      const s = this.domains.get(d.id);
      s.mode = d.mode;
      s.enabled = d.enabled;
      if (d.backup && !s.backup) s.backup = newSideState();
      if (!d.backup) s.backup = null;
    }
  }

  getDomain(id) {
    return this.domains.get(id) || null;
  }

  // 清理已从配置中移除的域名状态(防止旧 state.json 残留导致"幽灵域名")
  pruneDomains(validIds) {
    let removed = 0;
    for (const id of [...this.domains.keys()]) {
      if (!validIds.has(id)) {
        this.domains.delete(id);
        removed++;
      }
    }
    return removed;
  }

  appendHistory(id, entry) {
    const s = this.domains.get(id);
    if (!s) return;
    s.history.push(entry);
    if (s.history.length > HISTORY_MAX) s.history.shift();
    try {
      if (!this.historyFd) {
        this.historyFd = fs.openSync(this.historyFile, 'a');
      }
      fs.writeSync(this.historyFd, JSON.stringify({ id, ...entry }) + '\n');
    } catch (e) {
      logger.debug(`history 写入失败: ${e.message}`);
    }
  }

  setProviderStatus(name, type, ok, lastError = '') {
    this.providers.set(name, { name, type, ok, lastError, lastVerifyAt: Date.now() });
  }

  snapshot() {
    const domains = [];
    for (const s of this.domains.values()) {
      domains.push(JSON.parse(JSON.stringify(s)));
    }
    return {
      startedAt: this.startedAt,
      domains,
      ips: JSON.parse(JSON.stringify(this.ips)),
      providers: [...this.providers.values()],
    };
  }

  save() {
    try {
      const data = {
        savedAt: Date.now(),
        domains: Object.fromEntries(
          [...this.domains.entries()].map(([k, v]) => [k, { ...v, history: v.history.slice(-20) }]),
        ),
        ips: this.ips,
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (e) {
      logger.debug(`state 保存失败: ${e.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [id, s] of Object.entries(data.domains || {})) {
        s.history = s.history || [];
        // 兼容旧格式:lastGoodValues 为数组 → 归档到 primary 侧
        if (Array.isArray(s.lastGoodValues)) {
          s.lastGoodValues = { primary: s.lastGoodValues, backup: [] };
        }
        if (!s.lastGoodValues || typeof s.lastGoodValues !== 'object') {
          s.lastGoodValues = { primary: [], backup: [] };
        }
        if (typeof s.fails !== 'number' || Number.isNaN(s.fails)) {
          s.fails = s.primary?.fails || 0;
        }
        this.domains.set(id, s);
      }
      if (data.ips && Array.isArray(data.ips.best) && data.ips.best.length > 0) {
        this.ips = data.ips;
        logger.info(`已恢复历史状态: ${this.domains.size} 个域名,优选IP ${this.ips.best.length} 个`);
      }
    } catch (e) {
      logger.warn(`state 加载失败(忽略): ${e.message}`);
    }
  }
}

export function dataPaths(configDir) {
  return {
    stateFile: path.join(configDir, 'state.json'),
    historyFile: path.join(configDir, 'history.jsonl'),
  };
}
