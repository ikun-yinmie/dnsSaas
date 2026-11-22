// 互备切换 / 回滚决策 / 告警
// handleDomainResult 只做判断并返回动作,真正执行(回滚/替换/切换)由调度器完成
import { logger, fmtError } from './logger.js';

export class Failover {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.lastWebhookAt = 0;
    this.lastAlerts = new Map(); // key -> ts(独立于域名状态,global 等键也能限频)
  }

  // 限频 webhook 告警
  async notify(key, msg, { force = false } = {}) {
    const now = Date.now();
    const cooldown = this.config.notify.cooldownSec * 1000;
    const last = this.lastAlerts.get(key) || 0;
    if (!force && last && now - last < cooldown) return false;
    this.lastAlerts.set(key, now);
    logger.warn(`告警[${key}]: ${msg}`);
    const hook = this.config.notify.webhook;
    if (!hook) return true;
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'dnsSaas 告警', msg, key, level: 'warning', ts: Date.now() }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      logger.error(`webhook 发送失败: ${fmtError(e)}`);
    }
    return true;
  }

  // 处理一次域名的检查结果,返回 { actions, shouldRemediate, switchToBackup }
  // actions: [{type:'rollback', valuesBySide}]
  // ctx: { synced, prevValuesBySide: {}, newValues: [] }
  handleDomainResult(domain, state, check, ctx = {}) {
    const actions = [];
    let shouldRemediate = false;
    let switchToBackup = false;
    const sideKey = state.activeSide === 'backup' && state.backup ? 'backup' : 'primary';
    const side = state[sideKey];

    if (check.ok) {
      if (state.fails > 0) {
        logger.info(`域名 ${domain.id} 恢复正常(此前连续失败 ${state.fails} 次)`);
      }
      state.fails = 0;
      side.ok = true;
      side.lastError = '';
      // 记录各侧可用值用于回滚
      for (const k of ['primary', 'backup']) {
        const st = state[k];
        if (st && st.currentValues.length > 0) state.lastGoodValues[k] = [...st.currentValues];
      }
      // 主侧恢复后回归主侧
      if (state.activeSide === 'backup') {
        const primarySide = state.primary;
        if (primarySide.lastCheck && primarySide.lastCheck.dnsOk !== false) {
          state.activeSide = 'primary';
          primarySide.ok = true;
          logger.info(`域名 ${domain.id} 主侧已恢复,回归主侧`);
        }
      }
    } else {
      state.fails += 1;
      side.ok = false;
      side.lastError = check.error;
      const threshold = domain.check.failThreshold;
      logger.warn(`域名 ${domain.id} 检查失败(${state.fails}/${threshold}): ${check.error}`);

      // 1) 刚同步过新值且失败 → 回滚到上一个可用值(按侧恢复)
      if (ctx.synced) {
        const prev = ctx.prevValuesBySide || {};
        const valuesBySide = {};
        for (const k of Object.keys(prev)) {
          const good = state.lastGoodValues[k] || [];
          if (good.length > 0 && JSON.stringify(prev[k]) !== JSON.stringify(good)) {
            valuesBySide[k] = good;
          }
        }
        if (Object.keys(valuesBySide).length > 0) {
          actions.push({ type: 'rollback', valuesBySide });
          const desc = Object.entries(valuesBySide).map(([k, v]) => `${k}→[${v.join(',')}]`).join(' ');
          this.notify(`rollback:${domain.id}`, `域名 ${domain.id}: 新记录值 [${(ctx.newValues || []).join(',')}] 检查失败,已回滚: ${desc}`);
        }
      }

      // 2) 连续失败达阈值 → 由调度器先尝试优选IP替换,失败再切互备/告警
      if (state.fails >= threshold) {
        shouldRemediate = domain.mode === 'saas' && domain.usePreferred !== false;
        switchToBackup = !!(state.backup && state.activeSide === 'primary');
      }
    }

    side.lastCheck = { ...check, dnsOk: check.urls?.[0]?.dns?.ok ?? null };
    return { actions, shouldRemediate, switchToBackup };
  }

  // 全局评估:所有启用域名都挂了才告警
  evaluateGlobal() {
    const enabled = [...this.store.domains.values()].filter((s) => s.enabled !== false);
    if (enabled.length === 0) return;
    const allDown = enabled.every((s) => s.fails > 0);
    if (allDown) {
      this.notify('global', `所有 ${enabled.length} 个域名均不可用!请立即检查。`);
    }
  }
}
