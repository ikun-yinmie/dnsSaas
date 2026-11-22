// 全局日志:终端输出 + 环形缓冲(供 Web UI 查看)
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export class Logger {
  constructor(maxBuffer = 3000) {
    this.maxBuffer = maxBuffer;
    this.buffer = []; // {ts, level, msg}
    this.level = LEVELS.info;
    this.useColor = process.stdout.isTTY;
  }

  setLevel(level) {
    if (LEVELS[level]) this.level = LEVELS[level];
  }

  write(level, msg) {
    const entry = { ts: Date.now(), time: ts(), level, msg: String(msg) };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    const tag = `[${entry.time}] [${level.toUpperCase().padEnd(5)}] `;
    if (this.useColor && this.level <= LEVELS[level]) {
      process.stdout.write(tag + COLORS[level] + entry.msg + RESET + '\n');
    } else if (this.level <= LEVELS[level]) {
      process.stdout.write(tag + entry.msg + '\n');
    }
    if (level === 'error') {
      process.stderr.write(tag + entry.msg + '\n');
    }
  }

  debug(msg) { this.write('debug', msg); }
  info(msg) { this.write('info', msg); }
  warn(msg) { this.write('warn', msg); }
  error(msg) { this.write('error', msg); }

  tail(n = 300) {
    return this.buffer.slice(-n);
  }
}

export const logger = new Logger();

export function fmtError(e) {
  if (!e) return '未知错误';
  if (e.message) return e.message;
  return String(e);
}
