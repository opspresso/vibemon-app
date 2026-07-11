/**
 * AI tool hook installer for Vibe Monitor
 *
 * Detects locally installed AI CLI tools (Claude Code, Codex CLI, Kiro IDE,
 * OpenClaw) that are missing the VibeMon hook files, and — after explicit
 * user confirmation — runs the official docs.vibemon.io/install.py installer
 * to set them up. The script is downloaded over HTTPS and piped to
 * `python3 -` via stdin instead of a `curl | python3` shell pipe, so
 * arguments never pass through a shell.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { dialog, shell } = require('electron');
const Store = require('electron-store');
const { DOCS_BASE_URL } = require('../shared/config.cjs');

const SETUP_GUIDE_URL = `${DOCS_BASE_URL}/setup.md`;

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

const TOOLS = [
  {
    name: 'Claude Code',
    flag: '--claude',
    command: 'claude',
    homeDir: homePath('.claude'),
    hookFile: homePath('.claude', 'hooks', 'vibemon.py')
  },
  {
    name: 'Codex CLI',
    flag: '--codex',
    command: 'codex',
    homeDir: homePath('.codex'),
    hookFile: homePath('.codex', 'hooks', 'vibemon.py')
  },
  {
    name: 'Kiro IDE',
    flag: '--kiro',
    command: 'kiro',
    homeDir: homePath('.kiro'),
    hookFile: homePath('.kiro', 'hooks', 'vibemon.py')
  },
  {
    name: 'OpenClaw',
    flag: '--openclaw',
    command: 'openclaw',
    homeDir: homePath('.openclaw'),
    hookFile: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'index.mjs')
  }
];

const WHICH_COMMAND = process.platform === 'win32' ? 'where' : 'which';
const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';

function commandExists(command) {
  const result = spawnSync(WHICH_COMMAND, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function describeFailure(result) {
  switch (result.reason) {
    case 'python-not-found':
      return 'Python3가 설치되어 있지 않습니다';
    case 'download-failed':
      return `설치 스크립트 다운로드 실패 (HTTP ${result.statusCode})`;
    case 'network-error':
      return `네트워크 오류: ${result.error}`;
    case 'spawn-error':
      return `실행 오류: ${result.error}`;
    case 'exit-code':
      return `설치 스크립트 종료 코드 ${result.code}`;
    default:
      return '알 수 없는 오류';
  }
}

class HookInstaller {
  constructor() {
    this.store = new Store({
      name: 'hook-installer-settings',
      defaults: { dismissed: [] }
    });
    this.isRunning = false;
    // In-memory only (cleared on restart): avoids re-prompting every check
    // cycle for an error that won't resolve itself (e.g. missing python3).
    this.sessionSuppressed = new Set();
  }

  isPresent(tool) {
    return commandExists(tool.command) || fs.existsSync(tool.homeDir);
  }

  hasHook(tool) {
    return fs.existsSync(tool.hookFile);
  }

  isDismissed(tool) {
    return this.store.get('dismissed').includes(tool.flag);
  }

  dismiss(tools) {
    const dismissed = new Set(this.store.get('dismissed'));
    for (const tool of tools) {
      dismissed.add(tool.flag);
    }
    this.store.set('dismissed', [...dismissed]);
  }

  /**
   * @returns {Array} status of every known tool: {..., present, hasHook}
   */
  detectTools() {
    return TOOLS.map(tool => ({
      ...tool,
      present: this.isPresent(tool),
      hasHook: this.hasHook(tool)
    }));
  }

  /**
   * @returns {Array} tools that are installed, missing a VibeMon hook, and
   *   not dismissed/suppressed
   */
  getMissingTools() {
    return this.detectTools().filter(tool =>
      tool.present &&
      !tool.hasHook &&
      !this.isDismissed(tool) &&
      !this.sessionSuppressed.has(tool.flag)
    );
  }

  /**
   * Download install.py and run it via `python3 -` with the given flags.
   * @param {string[]} flags - e.g. ['--claude']
   * @param {string|null} token - VibeMon account token
   * @returns {Promise<{ok: boolean, reason?: string, [key: string]: any}>}
   */
  runInstaller(flags, token) {
    return new Promise((resolve) => {
      if (!commandExists(PYTHON_COMMAND)) {
        resolve({ ok: false, reason: 'python-not-found' });
        return;
      }

      https.get(`${DOCS_BASE_URL}/install.py`, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ ok: false, reason: 'download-failed', statusCode: res.statusCode });
          return;
        }

        let script = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { script += chunk; });
        res.on('end', () => {
          const args = ['-', ...flags, '--yes'];
          if (token) {
            args.push('--token', token);
          }

          const child = spawn(PYTHON_COMMAND, args, { stdio: ['pipe', 'pipe', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (chunk) => { stderr += chunk; });
          child.on('error', (err) => resolve({ ok: false, reason: 'spawn-error', error: err.message }));
          child.on('close', (code) => resolve({
            ok: code === 0,
            reason: code === 0 ? null : 'exit-code',
            code,
            stderr
          }));

          child.stdin.write(script);
          child.stdin.end();
        });
      }).on('error', (err) => resolve({ ok: false, reason: 'network-error', error: err.message }));
    });
  }

  /**
   * Install hooks for the given tools one at a time; a failure on one tool
   * does not stop the rest. Shows a result summary dialog when done.
   * @param {Array} tools
   * @param {string|null} token
   */
  async installTools(tools, token) {
    if (this.isRunning) {
      return [];
    }
    this.isRunning = true;

    const results = [];
    try {
      for (const tool of tools) {
        const result = await this.runInstaller([tool.flag], token);
        results.push({ tool, result });
        if (!result.ok && (result.reason === 'python-not-found' || result.reason === 'network-error')) {
          this.sessionSuppressed.add(tool.flag);
        }
      }
    } finally {
      this.isRunning = false;
    }

    this.showResultSummary(results);
    return results;
  }

  /**
   * Detect missing tools and, if any, ask the user for confirmation before
   * installing hooks for them. No-op when nothing is missing or an install
   * is already in progress.
   * @param {string|null} token - VibeMon account token (shared with the WebSocket client)
   */
  async checkAndPrompt(token) {
    if (this.isRunning) {
      return;
    }

    const missing = this.getMissingTools();
    if (missing.length === 0) {
      return;
    }

    const toolNames = missing.map(t => t.name).join(', ');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'VibeMon',
      message: 'VibeMon 훅이 설치되지 않은 AI 툴을 발견했습니다.',
      detail: `${toolNames}\n\n지금 훅을 설치하면 실시간 상태가 VibeMon에 표시됩니다.`,
      buttons: ['Install', 'Skip', "Don't Ask Again"],
      defaultId: 0,
      cancelId: 1
    });

    if (response === 1) {
      return; // Skip - ask again next check
    }
    if (response === 2) {
      this.dismiss(missing);
      return;
    }

    await this.installTools(missing, token);
  }

  /**
   * Manually install hooks for a single tool (e.g. from the tray menu),
   * bypassing the dismissed/suppressed filters used by checkAndPrompt.
   * @param {string} flag - e.g. '--claude'
   * @param {string|null} token
   */
  installByFlag(flag, token) {
    const tool = this.detectTools().find(t => t.flag === flag);
    if (!tool) {
      return Promise.resolve([]);
    }
    return this.installTools([tool], token);
  }

  showResultSummary(results) {
    const succeeded = results.filter(r => r.result.ok).map(r => r.tool.name);
    const failed = results.filter(r => !r.result.ok);

    if (failed.length === 0) {
      dialog.showMessageBox({
        type: 'info',
        title: 'VibeMon',
        message: 'VibeMon 훅 설치 완료',
        detail: succeeded.join(', ')
      });
      return;
    }

    const failedLines = failed.map(r => `${r.tool.name}: ${describeFailure(r.result)}`).join('\n');
    dialog.showMessageBox({
      type: 'warning',
      title: 'VibeMon',
      message: succeeded.length > 0 ? '일부 훅 설치 실패' : 'VibeMon 훅 설치 실패',
      detail: [
        succeeded.length > 0 ? `성공: ${succeeded.join(', ')}` : null,
        failedLines,
        `${SETUP_GUIDE_URL} 에서 수동 설치 방법을 확인할 수 있습니다.`
      ].filter(Boolean).join('\n\n'),
      buttons: ['OK', '설치 가이드 열기']
    }).then(({ response }) => {
      if (response === 1) {
        shell.openExternal(SETUP_GUIDE_URL);
      }
    });
  }
}

module.exports = { HookInstaller, TOOLS };
