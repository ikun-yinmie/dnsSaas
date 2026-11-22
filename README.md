# dnsSaas

类似 [ddns-go](https://github.com/jeessy2/ddns-go) 的多服务商 DNS 守护面板,Node.js 单进程实现。

**核心能力:**

- **绑定多个 DNS 解析站**:Cloudflare(API Token)和 DNSHE(my.dnshe.com,cfsd_ 密钥),支持**页面上添加/编辑/启用禁用**
- **表单化配置**:Web 面板提供域名/服务商的**图形表单**(服务商、记录名、TTL、检测间隔、阈值等),也保留 YAML 高级模式
- **定时健康检查**:DNS 多公共解析器 + 完整 TCP→TLS→HTTP 探测,识别 NXDOMAIN / 污染 / 超时 / 异常状态码
- **逐域名独立更新**:每域名独立调度、独立同步;记录被外部误删自动重建(自愈)
- **全局优选IP 分配**:按"需要的侧数"匹配——每个参与优选的域名主/备侧各拿一个**互不相同**的 IP(池不足时告警并暂不更新)
- **访问不通自动换 IP**:检查连续失败达阈值后,先用优选池里其他未占用 IP 顶替;仍失败则还原并切互备/告警
- **多服务商互备**:主侧恢复后自动回归;所有域名全挂时 webhook 告警
- **DDNS 模式**:跟随本机公网 IPv4/IPv6
- **Web 面板**:Tab 布局(仪表盘/域名/服务商/高级/日志)、一键全部检测、即时 Toast 反馈、YAML 热重载
- **双击控制台**:`控制台.sh` 图形面板(启动/停止/状态/打开面板/日志)

## 快速开始

```bash
npm install
cp config.example.yaml config.yaml   # 首次启动会自动复制,编辑填入密钥
npm start                            # http://127.0.0.1:9877
```

冒烟测试(不调用真实 DNS API):

```bash
npm run dry          # Mock provider 模式
node src/index.js --once   # 跑一轮后退出(适合 cron)
```

## 获取密钥

| 服务商 | 获取方式 | 权限 |
|---|---|---|
| Cloudflare | My Profile → API Tokens → Create Token → **Zone.DNS Edit**(限定到你的 zone) | 管理 DNS 记录 |
| DNSHE | my.dnshe.com → 免费域名管理 → API管理 → 创建 API 密钥(`cfsd_` 前缀,Secret 只显示一次) | 管理子域名记录 |

## 配置说明

见 `config.example.yaml`,三个模式:

| mode | 行为 | 典型用途 |
|---|---|---|
| `saas` | 通配符 `*` 写入优选IP池测速后的最优 IP;**所有参与优选的域名/侧自动分配互不相同的 IP(按需要的侧数匹配),池不足时告警并暂不更新** | Cloudflare SaaS / 优选加速 |
| `ddns` | 检测本机公网 IPv4/IPv6,变化才更新 | 家宽动态 IP |
| `static` | 固定值 | 固定解析 |

### 健康检查与自动恢复链路

检查失败后的处理顺序:

1. **回滚**:刚同步过新值且失败 → 还原到上次可用值
2. **优选IP顶替**:连续失败达 `failThreshold` → 从优选池挑选**未被占用**的 IP 逐个尝试(最多 3 个),替换后立即复查;成功则通知并采用
3. **互备切换**:替换全部无效 → 还原原记录 → 切到备侧(不同服务商)并告警
4. 所有域名全部不可用 → 全局 webhook 告警

### 优选IP 分配规则

- 参与分配的对象 = 所有启用 + `mode: saas` + `usePreferred: true` 的域名,每个域名的**主侧和备侧各算一个**
- 需要的 IP 数 = 侧数;池中按测速结果依次分配,**所有记录 IP 互不相同**
- 池不够时:只分配给前面的侧,其余本轮不更新并告警(日志/面板提示)
- 有 20% 迟滞防抖,速度接近的 IP 不会来回翻转;分配有粘性,不会每次测速都改动记录
- `usePreferred: false` 的域名不参与自动分配(记录保持不变,仅做健康检查)

### 优选IP 来源

- `https://ip.164746.xyz/ipTop.html`(和 `/ipTop10.html`)— 社区纯文本列表,最稳
- `https://monitor.gacjie.cn/api/client/get_ip_address` — 分线路 JSON(部分网络访问不通会自动跳过)
- `manual` — 手动补充;也可用 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 自测后填入
- 建议同时配置 `ipTop.html` + `ipTop10.html` 两个源,保证池里至少有你需要的侧数量

## 双击控制台

- **`控制台.sh`** —— 双击打开图形控制台(zenity):启动 / 停止 / 状态查看 / 打开网页面板 / 查看日志
- **`dnsSaas控制台.desktop`**(已复制一份到 `~/Desktop`)—— 桌面双击启动器,如文件管理器提示"不可信/不允许执行",右键 → 属性勾选"允许执行"
- 也支持命令行:`./控制台.sh start|stop|status|panel|log`
- 守护进程日志写在项目根 `dnsSaas.log`

## 开机自启(systemd user)

```bash
mkdir -p ~/.config/dns-saas && cp config.yaml ~/.config/dns-saas/
cp systemd/dns-saas.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dns-saas
journalctl --user -u dns-saas -f
```

## 注意

- 未设 `server.password` 时面板只监听 `127.0.0.1` 且免密;要局域网访问请设密码 + `host: 0.0.0.0`
- `config.yaml` / `state.json` / `history.jsonl` 含密钥与历史,已在 `.gitignore` 中排除
- DNSHE API 限速约 30~60 次/分钟,默认检测间隔 5 分钟足够安全
- DNSHE 的记录挂在子域名(subdomain)下;`name: "*"` 或 `"@"` 直接操作子域主名,普通子标签会尝试传 `name` 字段,若面板不支持请把该子标签在 DNSHE 面板单独注册成子域名
