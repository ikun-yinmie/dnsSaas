// 健康检查:DNS 多公共解析器 + 完整 TCP→TLS→HTTP 探测
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export const PUBLIC_RESOLVERS = ['223.5.5.5', '119.29.29.29', '1.1.1.1'];

// 对单个域名做多解析器 DNS 检查
export async function checkDns(hostname, { timeoutMs = 5000, resolvers = PUBLIC_RESOLVERS } = {}) {
  const results = await Promise.all(resolvers.map(async (server) => {
    const r = new Resolver({ timeout: timeoutMs, tries: 1 });
    r.setServers([server]);
    const item = { server, ok: false, ips: [], error: '' };
    let v4 = [];
    let v4Err = null;
    let v6 = [];
    let v6Err = null;
    try { v4 = await r.resolve4(hostname); } catch (e) { v4Err = e; }
    if (v4.length === 0) {
      try { v6 = await r.resolve6(hostname); } catch (e) { v6Err = e; }
    }
    item.ips = [...v4, ...v6];
    item.ok = item.ips.length > 0;
    if (!item.ok) {
      const err = v4Err || v6Err;
      const code = err?.code || '';
      item.error = code === 'ENOTFOUND' ? 'NXDOMAIN(域名不存在)'
        : code === 'ENODATA' ? '无记录'
        : code === 'ETIMEDOUT' ? '查询超时'
        : code || err?.message || '无记录';
    }
    return item;
  }));
  const ok = results.some((r) => r.ok);
  const ips = [...new Set(results.flatMap((r) => r.ips))];
  return { ok, ips, servers: results };
}

// 单个 URL 的 HTTP 探测,记录 TCP/TLS/响应耗时与 Location
function probeOnce(urlStr, { method = 'GET', timeoutMs = 8000, maxBody = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return resolve({ ok: false, error: `URL 无效: ${urlStr}` });
    }
    const mod = url.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();
    const result = {
      ok: false, code: 0, tcpMs: null, tlsMs: null, ttfbMs: null, totalMs: null,
      serverIp: null, location: null, error: '',
    };

    let settled = false;
    const done = (patch = {}) => {
      if (settled) return;
      settled = true;
      Object.assign(result, patch);
      result.totalMs = result.totalMs ?? Number(process.hrtime.bigint() - start) / 1e6;
      try { req.destroy(); } catch { /* noop */ }
      resolve(result);
    };

    const req = mod.request(url, {
      method,
      timeout: timeoutMs,
      // 每次探测强制新建连接:避免 keep-alive 复用导致 TCP/TLS 计时缺失
      agent: false,
      headers: { 'user-agent': 'dnsSaas/0.1 health-check', connection: 'close' },
    }, (res) => {
      result.code = res.statusCode;
      result.location = res.headers.location || null;
      result.ttfbMs = Number(process.hrtime.bigint() - start) / 1e6;
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size >= maxBody) res.destroy();
      });
      res.on('end', () => done({ totalMs: Number(process.hrtime.bigint() - start) / 1e6 }));
      res.on('error', () => done({}));
      // close 在 end/error/destroy(如截断超大响应体)后都会触发,兜底防 promise 悬挂
      res.on('close', () => done({ totalMs: Number(process.hrtime.bigint() - start) / 1e6 }));
    });
    req.on('close', () => done({}));

    req.on('socket', (socket) => {
      result.serverIp = socket.remoteAddress || null;
      socket.once('connect', () => {
        result.tcpMs = Number(process.hrtime.bigint() - start) / 1e6;
      });
      socket.once('secureConnect', () => {
        result.tlsMs = Number(process.hrtime.bigint() - start) / 1e6;
      });
    });
    req.on('timeout', () => done({ error: `超时(${timeoutMs}ms)` }));
    req.on('error', (e) => done({ error: e.code ? `${e.code} ${e.message}` : e.message }));
    req.end();
  });
}

// 带重定向的探测:30x 时直接跟随 location,不对中间跳计失败
export async function probeUrl(urlStr, { method = 'GET', timeoutMs = 8000, followRedirects = true, expectStatus = [], maxRedirects = 5 } = {}) {
  let current = urlStr;
  let redirects = 0;
  let last = null;
  const chain = [];
  for (;;) {
    last = await probeOnce(current, { method, timeoutMs });
    chain.push({ url: current, code: last.code, ms: last.totalMs != null ? Math.round(last.totalMs) : null, error: last.error || undefined });
    const redirectable = followRedirects && last.code >= 300 && last.code < 400 && last.code !== 304 && last.location;
    if (redirectable && redirects < maxRedirects) {
      current = new URL(last.location, current).href;
      redirects++;
      continue;
    }
    last.ok = last.code > 0 && (expectStatus.length === 0 || expectStatus.includes(last.code));
    if (!last.ok && !last.error) {
      last.error = `HTTP ${last.code || 0} 不在期望列表 [${expectStatus.join(',')}]`;
    }
    break;
  }
  last.redirects = redirects;
  last.chain = chain;
  return last;
}

// 一个域名的一轮完整检查(所有 check.urls 全部通过才算 ok)
export async function runCheck(domain, { timeoutMs, expectStatus, followRedirects, method } = {}) {
  const cfg = domain.check;
  const opt = {
    timeoutMs: timeoutMs ?? cfg.timeoutMs,
    expectStatus: expectStatus ?? cfg.expectStatus,
    followRedirects: followRedirects ?? cfg.followRedirects,
    method: method ?? cfg.method,
  };
  const startedAt = Date.now();
  const perUrl = [];
  for (const u of cfg.urls) {
    let host = '';
    try { host = new URL(u).hostname; } catch { /* probeUrl 会报错 */ }
    const dns = host ? await checkDns(host, { timeoutMs: opt.timeoutMs }) : { ok: false, ips: [], servers: [], error: 'URL 无效' };
    const http = await probeUrl(u, opt);
    perUrl.push({ url: u, dns, http });
  }
  const ok = perUrl.every((p) => p.dns.ok && p.http.ok);
  const firstHttp = perUrl[0]?.http || {};
  const dnsDesc = perUrl.map((p) => p.dns.servers.map((s) => `${s.server}:${s.ok ? s.ips[0] || 'ok' : s.error}`).join(' / ')).join(' | ');
  return {
    ts: startedAt,
    ok,
    totalMs: Date.now() - startedAt,
    urls: perUrl,
    code: firstHttp.code || 0,
    ms: firstHttp.totalMs != null ? Math.round(firstHttp.totalMs) : null,
    tcpMs: firstHttp.tcpMs != null ? Math.round(firstHttp.tcpMs) : null,
    tlsMs: firstHttp.tlsMs != null ? Math.round(firstHttp.tlsMs) : null,
    serverIp: firstHttp.serverIp || null,
    dnsDesc,
    error: ok ? '' : perUrl.map((p) => (!p.dns.ok ? `DNS: ${p.dns.servers.map((s) => `${s.server}=${s.error || 'ok'}`).join('; ')}` : p.http.error)).filter(Boolean).join(' | '),
  };
}
