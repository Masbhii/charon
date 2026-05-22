/**
 * Jalankan graduate screening collector/watch di background (tetap hidup setelah terminal/SSH ditutup).
 *
 * Penyebab proses mati saat tutup terminal: node yang dijalankan langsung di foreground
 * menerima SIGHUP dari shell dan dihentikan. Script ini spawn proses detached + PID file.
 *
 * Usage:
 *   node scripts/graduate-screening-daemon.mjs start
 *   node scripts/graduate-screening-daemon.mjs start -- --interval 5000 --verbose --confirm-pass --telegram
 *   node scripts/graduate-screening-daemon.mjs start --watch -- --interval 5000
 *   node scripts/graduate-screening-daemon.mjs status
 *   node scripts/graduate-screening-daemon.mjs stop
 *   node scripts/graduate-screening-daemon.mjs restart -- --interval 5000 --verbose --confirm-pass
 *   node scripts/graduate-screening-daemon.mjs log
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

function splitDaemonArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0) return { daemonArgs: argv, scriptArgs: [] };
  return { daemonArgs: argv.slice(0, sep), scriptArgs: argv.slice(sep + 1) };
}

const { daemonArgs: rest, scriptArgs: forwarded } = splitDaemonArgs(args.slice(1));
const watchMode = rest.includes('--watch');
const runDir = path.join(repoRoot, 'data', 'graduate-screening');
const pidFile = path.join(runDir, watchMode ? 'watch.pid' : 'collector.pid');
const logFile = path.join(runDir, watchMode ? 'watch.log' : 'collector.log');
const scriptRel = watchMode ? 'scripts/watch-graduate-screening.mjs' : 'scripts/collect-graduate-screening.mjs';

function ensureRunDir() {
  fs.mkdirSync(runDir, { recursive: true });
}

function readPid() {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function defaultScriptArgs() {
  if (watchMode) return ['--interval', '5000'];
  return ['--interval', '5000', '--verbose', '--confirm-pass'];
}

function buildScriptArgs() {
  return forwarded.length ? forwarded : defaultScriptArgs();
}

function start() {
  ensureRunDir();
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.error(`[daemon] already running (pid ${existing}). Use: node scripts/graduate-screening-daemon.mjs stop`);
    process.exit(1);
  }

  const scriptArgs = buildScriptArgs();
  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [scriptRel, ...scriptArgs], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env },
  });

  child.unref();
  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

  console.log(`[daemon] started ${watchMode ? 'watch' : 'collector'} pid=${child.pid}`);
  console.log(`[daemon] log: ${logFile}`);
  console.log(`[daemon] pid file: ${pidFile}`);
  console.log(`[daemon] args: ${scriptRel} ${scriptArgs.join(' ')}`);
  console.log('[daemon] safe to close SSH/terminal — process runs detached');
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log('[daemon] not running (no pid file)');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    return;
  }
  if (!isRunning(pid)) {
    console.log(`[daemon] stale pid file (pid ${pid} not running), cleaned up`);
    fs.unlinkSync(pidFile);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[daemon] sent SIGTERM to pid ${pid}`);
  } catch (err) {
    console.error(`[daemon] stop failed: ${err.message}`);
    process.exit(1);
  }
  fs.unlinkSync(pidFile);
}

function status() {
  const pid = readPid();
  const running = pid && isRunning(pid);
  console.log(JSON.stringify({
    mode: watchMode ? 'watch' : 'collector',
    running: Boolean(running),
    pid: running ? pid : null,
    pid_file: pidFile,
    log_file: logFile,
    script: scriptRel,
  }, null, 2));
  process.exit(running ? 0 : 1);
}

function tailHint() {
  ensureRunDir();
  console.log(`[daemon] log file: ${logFile}`);
  console.log(`[daemon] tail: tail -f ${logFile}`);
  if (!fs.existsSync(logFile)) {
    console.log('[daemon] (log empty or not created yet)');
  }
}

function help() {
  console.log(`graduate-screening-daemon — keep screening alive after terminal close

Commands:
  start [--watch] [-- <collector/watch args>]
  stop [--watch]
  restart [--watch] [-- <args>]
  status [--watch]
  log [--watch]

Examples:
  node scripts/graduate-screening-daemon.mjs start -- --interval 5000 --verbose --confirm-pass --telegram
  node scripts/graduate-screening-daemon.mjs status
  node scripts/graduate-screening-daemon.mjs stop
`);
}

switch (cmd) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    start();
    break;
  case 'status':
    status();
    break;
  case 'log':
    tailHint();
    break;
  default:
    help();
    process.exit(cmd === 'help' ? 0 : 1);
}
