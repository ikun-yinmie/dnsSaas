#!/usr/bin/env node
// dnsSaas 入口:node src/index.js [--config <path>] [--port <n>] [--dry-run] [--once]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, fmtError } from './logger.js';
import { ConfigManager } from './config.js';
import { Store, dataPaths } from './store.js';
import { createProviders } from './providers/index.js';
import { IpTester } from './iptest.js';
import { Failover } from './failover.js';
import { Scheduler } from './scheduler.js';
import { WebServer } from './web/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { config: path.join(__dirname, '..', 'config.yaml'), port: null, dryRun: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--once') args.once = true;
    else if (a === '--help' || a === '-h') {
      console.log(`dnsSaas — 多服务商 DNS 守护面板

用法:
  node src/index.js [选项]

选项:
  -c, --config <path>   配置文件路径(默认项目根 config.yaml,不存在会自动从 example 生成)
  -p, --port <n>        覆盖 Web 端口
      --dry-run         Mock 模式:不调用真实 DNS API
      --once            跑一轮(测速 + 全部域名周期)后退出
  -h, --help            帮助`);
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) logger.warn('DRY-RUN 模式:所有 DNS API 调用使用 Mock,不产生真实变更');

  // 配置文件不存在 → 从 example 复制
  if (!fs.existsSync(args.config)) {
    const example = path.join(__dirname, '..', 'config.example.yaml');
    if (fs.existsSync(example) && args.config === path.join(__dirname, '..', 'config.yaml')) {
      fs.copyFileSync(example, args.config);
      logger.warn(`未找到配置,已从 config.example.yaml 生成 ${args.config},请编辑后重启(或直接在 Web UI 中编辑)`);
    } else {
      logger.error(`配置文件不存在: ${args.config}`);
      process.exit(1);
    }
  }

  const cm = new ConfigManager(args.config);
  if (args.port) cm.config.server.port = args.port;

  logger.setLevel(process.env.DNS_SAAS_LOG || 'info');
  const configDir = path.dirname(args.config);
  const { stateFile, historyFile } = dataPaths(configDir);
  const store = new Store(stateFile, historyFile);
  store.load();

  // 域名注册进 store(热重载后补齐新域名、清理已移除的)
  const registerDomains = (cfg) => {
    const ids = new Set(cfg.domains.map((d) => d.id));
    const removed = store.pruneDomains(ids);
    if (removed > 0) logger.info(`已清理 ${removed} 个已从配置移除的域名状态`);
    for (const d of cfg.domains) store.initDomain(d);
  };
  registerDomains(cm.config);

  const providers = createProviders(cm.config, { dryRun: args.dryRun });
  const failover = new Failover(cm.config, store);
  const ipTester = new IpTester(cm.config, store);
  const scheduler = new Scheduler(cm, store, providers, ipTester, failover);
  ipTester.onChange = () => {
    scheduler.syncAllSaas('优选IP更新').catch((e) => logger.error(`优选IP同步异常: ${fmtError(e)}`));
  };

  // 热重载:重建 providers、刷新各模块配置、重排调度
  cm.onReload((next) => {
    registerDomains(next);
    providers.clear();
    for (const [name, inst] of createProviders(next, { dryRun: args.dryRun })) {
      providers.set(name, inst);
    }
    ipTester.config = next;
    failover.config = next;
    if (!args.once) scheduler.restart();
  });
  cm.startWatching();

  const web = new WebServer(cm, store, scheduler, providers, ipTester);
  web.dryRun = args.dryRun;
  await web.listen();

  if (args.once) {
    // 单轮模式:测速 → 等 onChange 触发的同步收敛 → 每个域名跑一轮 → 退出
    try {
      await ipTester.runOnce();
      await scheduler.waitIdle();
      for (const d of cm.config.domains) {
        if (d.enabled) await scheduler.safeCycle(d);
      }
      await scheduler.waitIdle();
      logger.info('--once 单轮完成');
    } finally {
      store.save();
      web.close();
      process.exit(0);
    }
    return;
  }

  // 首次启动先验证各 provider(后台执行,不阻塞)
  for (const [name, prov] of providers) {
    prov.verify().then((msg) => {
      store.setProviderStatus(name, prov.cfg.type, true, '');
      logger.info(`provider ${name} 连通正常: ${msg}`);
    }).catch((e) => {
      store.setProviderStatus(name, prov.cfg.type, false, fmtError(e));
      logger.error(`provider ${name} 连通失败: ${fmtError(e)}`);
    });
  }

  scheduler.start();
  ipTester.start();
  logger.info(`dnsSaas 启动完成: ${cm.config.domains.length} 个域名(${cm.config.domains.filter((d) => d.enabled).length} 个启用)`);

  const shutdown = () => {
    logger.info('正在退出…');
    scheduler.stop();
    ipTester.stop();
    cm.stopWatching();
    store.save();
    web.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error(`启动失败: ${fmtError(e)}`);
  process.exit(1);
});
