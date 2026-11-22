// Web 面板:原生 http + Cookie 会话 + REST API + 静态页
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { logger, fmtError } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class WebServer {
  constructor(configManager, store, scheduler, providers, ipTester) {
    this.cm = configManager;
    this.store = store;
    this.scheduler = scheduler;
    this.providers = providers;
    this.ipTester = ipTester;
    this.sessions = new Set(); // 内存会话 token
    this.server = null;
  }

  // 结构化修改配置:应用后写回 YAML(触发校验与热重载)
  applyConfig(mutator) {
    const cfg = structuredClone(this.cm.config);
    mutator(cfg);
    this.cm.saveYamlText(YAML.stringify(cfg));
  }

  isAuthed(req) {
    if (!this.cm.config.server.password) return true; // 未设密码且默认只监听 127.0.0.1
    const cookies = parseCookies(req);
    return cookies.dnsSaasSid && this.sessions.has(cookies.dnsSaasSid);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        const { password } = JSON.parse(body || '{}');
        if (password && password === this.cm.config.server.password) {
          const sid = crypto.randomBytes(24).toString('hex');
          this.sessions.add(sid);
          res.setHeader('Set-Cookie', `dnsSaasSid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 401, { ok: false, error: '密码错误' });
      }

      if (p.startsWith('/api/')) {
        if (!this.isAuthed(req)) return sendJson(res, 401, { error: '未登录' });
        return await this.handleApi(req, res, p, url);
      }

      return this.serveStatic(p, res);
    } catch (e) {
      logger.error(`web 请求 ${p} 异常: ${fmtError(e)}`);
      return sendJson(res, 500, { error: fmtError(e) });
    }
  }

  async handleApi(req, res, p, url) {
    // GET /api/state — 总览
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ...this.store.snapshot(),
        domainCfgs: this.cm.config.domains.map((d) => ({
          id: d.id,
          mode: d.mode,
          enabled: d.enabled !== false,
          usePreferred: d.usePreferred !== false,
          check: d.check,
          primary: d.primary,
          backup: d.backup,
        })),
        providers: this.cm.config.providers.map((p) => ({
          name: p.name,
          type: p.type,
          enabled: p.enabled !== false,
          apiBase: p.apiBase || '',
          inUse: this.cm.config.domains.some(
            (d) => d.primary?.provider === p.name || d.backup?.provider === p.name,
          ),
          verify: this.store.providers.get(p.name) || null,
        })),
        server: { port: this.cm.config.server.port, host: this.cm.config.server.host, dryRun: !!this.dryRun },
        ipNeeded: (this.cm.config.domains || [])
          .filter((d) => d.enabled !== false && d.mode === 'saas' && d.usePreferred !== false)
          .reduce((n, d) => n + (d.backup ? 2 : 1), 0),
      });
    }

    // GET /api/logs
    if (p === '/api/logs' && req.method === 'GET') {
      const n = Number(url.searchParams.get('n') || 300);
      return sendJson(res, 200, { ok: true, logs: logger.tail(Math.min(2000, n)) });
    }

    // GET /api/config
    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, yaml: this.cm.toYaml() });
    }

    // POST /api/config {yaml}
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const { yaml } = JSON.parse(body || '{}');
      this.cm.saveYamlText(String(yaml || ''));
      return sendJson(res, 200, { ok: true, msg: '配置已保存并热重载' });
    }

    // ---- 服务商 CRUD ----
    if (p === '/api/providers' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: '缺少服务商名称' });
      if (this.cm.config.providers.some((x) => x.name === name)) {
        return sendJson(res, 409, { ok: false, error: `服务商名称已存在: ${name}` });
      }
      const type = body.type === 'dnshe' ? 'dnshe' : 'cloudflare';
      this.applyConfig((cfg) => {
        const prov = { name, type, enabled: body.enabled !== false };
        if (type === 'cloudflare') {
          prov.token = body.token || '';
          prov.apiBase = body.apiBase || 'https://api.cloudflare.com/client/v4';
        } else {
          prov.apiKey = body.apiKey || '';
          prov.apiSecret = body.apiSecret || '';
          prov.apiBase = body.apiBase || 'https://api005.dnshe.com';
        }
        cfg.providers.push(prov);
      });
      return sendJson(res, 200, { ok: true, msg: `服务商 ${name} 已添加` });
    }

    const mProvItem = p.match(/^\/api\/providers\/([^/]+)$/);
    if (mProvItem) {
      const name = decodeURIComponent(mProvItem[1]);
      const prov = this.cm.config.providers.find((x) => x.name === name);
      if (!prov) return sendJson(res, 404, { ok: false, error: '服务商不存在' });
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.name && body.name !== name) {
          return sendJson(res, 400, { ok: false, error: '服务商名称不可修改(请删除后重建)' });
        }
        const newType = body.type === 'dnshe' || body.type === 'cloudflare' ? body.type : prov.type;
        this.applyConfig((cfg) => {
          const target = cfg.providers.find((x) => x.name === name);
          target.enabled = body.enabled !== false;
          if (newType !== target.type) {
            // 切换类型:重建字段
            target.type = newType;
            if (newType === 'cloudflare') {
              delete target.apiKey; delete target.apiSecret;
              target.token = body.token || '';
              target.apiBase = body.apiBase || 'https://api.cloudflare.com/client/v4';
            } else {
              delete target.token;
              target.apiKey = body.apiKey || '';
              target.apiSecret = body.apiSecret || '';
              target.apiBase = body.apiBase || 'https://api005.dnshe.com';
            }
          } else if (newType === 'cloudflare') {
            if (body.token) target.token = body.token;               // 留空=保持不变
            if (body.apiBase) target.apiBase = body.apiBase;
          } else {
            if (body.apiKey) target.apiKey = body.apiKey;
            if (body.apiSecret) target.apiSecret = body.apiSecret;
            if (body.apiBase) target.apiBase = body.apiBase;
          }
        });
        return sendJson(res, 200, { ok: true, msg: `服务商 ${name} 已更新` });
      }
      if (req.method === 'DELETE') {
        const usedBy = this.cm.config.domains.filter(
          (d) => d.primary?.provider === name || d.backup?.provider === name,
        );
        if (usedBy.length > 0) {
          return sendJson(res, 409, {
            ok: false, error: `该服务商正被域名 ${usedBy.map((d) => d.id).join('、')} 使用,请先修改这些域名`,
          });
        }
        this.applyConfig((cfg) => {
          cfg.providers = cfg.providers.filter((x) => x.name !== name);
        });
        return sendJson(res, 200, { ok: true, msg: `服务商 ${name} 已删除` });
      }
    }

    // ---- 域名 CRUD ----
    if (p === '/api/domains' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id || '').trim();
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少域名 id' });
      if (this.cm.config.domains.some((x) => x.id === id)) {
        return sendJson(res, 409, { ok: false, error: `域名 id 已存在: ${id}` });
      }
      this.applyConfig((cfg) => { cfg.domains.push(body); });
      return sendJson(res, 200, { ok: true, msg: `域名 ${id} 已添加` });
    }

    const mDomainItem = p.match(/^\/api\/domains\/([^/]+)$/);
    if (mDomainItem) {
      const id = decodeURIComponent(mDomainItem[1]);
      const domain = this.cm.config.domains.find((x) => x.id === id);
      if (!domain) return sendJson(res, 404, { ok: false, error: '域名不存在' });
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.id && body.id !== id) {
          return sendJson(res, 400, { ok: false, error: '域名 id 不可修改(请删除后重建)' });
        }
        this.applyConfig((cfg) => {
          const idx = cfg.domains.findIndex((x) => x.id === id);
          cfg.domains[idx] = { ...body, id };
        });
        return sendJson(res, 200, { ok: true, msg: `域名 ${id} 已更新` });
      }
      if (req.method === 'DELETE') {
        this.applyConfig((cfg) => {
          cfg.domains = cfg.domains.filter((x) => x.id !== id);
        });
        return sendJson(res, 200, { ok: true, msg: `域名 ${id} 已删除` });
      }
    }

    // POST /api/domain/:id/check — 立即检测+同步,等待完成并返回结果
    const mDomain = p.match(/^\/api\/domain\/([\w.-]+)\/(check|sync)$/);
    if (mDomain && req.method === 'POST') {
      const [, id] = mDomain;
      const okRun = await this.scheduler.trigger(id);
      if (!okRun) return sendJson(res, 409, { ok: false, error: '该域名正在执行中,请稍候' });
      const s = this.store.getDomain(id);
      return sendJson(res, 200, { ok: true, result: s?.lastCheckResult || null });
    }

    // POST /api/ip/test — 立即测速并同步
    if (p === '/api/ip/test' && req.method === 'POST') {
      await this.scheduler.testAndSync();
      return sendJson(res, 200, { ok: true, msg: '测速完成并已同步' });
    }

    // POST /api/provider/:name/verify
    const mProv = p.match(/^\/api\/provider\/([\w.-]+)\/verify$/);
    if (mProv && req.method === 'POST') {
      const name = mProv[1];
      const prov = this.providers.get(name);
      if (!prov) return sendJson(res, 404, { ok: false, error: 'provider 不存在' });
      try {
        const msg = await prov.verify();
        this.store.setProviderStatus(name, prov.cfg.type, true, '');
        return sendJson(res, 200, { ok: true, msg });
      } catch (e) {
        this.store.setProviderStatus(name, prov.cfg.type, false, fmtError(e));
        return sendJson(res, 200, { ok: false, msg: fmtError(e) });
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  serveStatic(p, res) {
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^([/\\])+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(full);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store', // 避免浏览器缓存旧版前端导致与后端不匹配
    });
    fs.createReadStream(full).pipe(res);
  }

  listen() {
    const { host, port } = this.cm.config.server;
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        logger.info(`Web 面板: http://${host}:${port}${this.cm.config.server.password ? '' : '(未设密码,仅本机可访问)'}`);
        resolve();
      });
    });
  }

  close() {
    if (this.server) this.server.close();
  }
}
