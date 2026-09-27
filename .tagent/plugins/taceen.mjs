// taceen.mjs — Taceen plugin for tagent: Tool & Capability Resolver (MOCK).
//
// Prep work (Task ID 8-a, Subagent B). See docs/TACEEN.md for the full
// developer doc. This file is the PLUGIN side: it exposes the new tagent
// plugin hooks `beforeToolCall` (gatekeeper) and `onResolve` (resolver).
// It contributes NO tools and NO commands.
//
// Modes (set in taceen.json, next to this file):
//   mock      — pure-JS heuristics (default; zero dependencies, zero subprocess)
//   subprocess — spawn config.pythonPath with config.taceenScript and speak
//                JSON over stdin/stdout (the contract the REAL Taceen model
//                will speak: ~30-50MB Python model)
//
// DESIGN INVARIANT — FALLBACK TO ALLOW:
//   Any Taceen error/timeout must NEVER block the agent. Every hook body is
//   wrapped in try/catch → console.error + return undefined; the subprocess
//   helper never throws (returns null on any failure); null results are
//   normalized to undefined (= neutral/allow).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const name = 'taceen';
export const version = '0.1.0';
export const description = 'Tool & Capability Resolver (mock)';

// ---------------------------------------------------------------------------
// Config — taceen.json located BESIDE this plugin file, read ONCE at module
// level. The tagent loader dynamic-imports plugins with a ?t=<timestamp>
// cache-busting query; fileURLToPath() only uses the pathname, so deriving
// paths from import.meta.url is query-safe.
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'mock', // 'mock' | 'subprocess'
  pythonPath: 'python3',
  taceenScript: '.tagent/taceen/taceen.py',
  timeoutMs: 1500,
};

function pluginFilePath() {
  // Query-safe: strips any ?t=<ts> cache-busting suffix via fileURLToPath.
  return fileURLToPath(import.meta.url);
}

function loadConfig() {
  try {
    const configPath = path.join(path.dirname(pluginFilePath()), 'taceen.json');
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Missing file → silent defaults (normal: plugin works out of the box).
      return { ...DEFAULT_CONFIG };
    }
    // Broken JSON / unreadable file → defaults + ONE warning.
    console.error('[taceen] could not read taceen.json — using defaults:', e?.message ?? e);
    return { ...DEFAULT_CONFIG };
  }
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Hooks — the tagent plugin loader passes the `hooks` object through AS-IS
// and awaits async hooks. Return values follow the core hook contract:
//   onResolve:       undefined | { available, unavailable?, hint? }
//   beforeToolCall:  undefined/null/{action:'allow'} | {action:'block',...}
//                    | {action:'modify', input}
// ---------------------------------------------------------------------------

export const hooks = {
  async onResolve({ query, workspaceRoot, mode } = {}) {
    try {
      if (!config.enabled) return undefined;
      if (config.mode === 'mock') {
        return mockResolve(query, workspaceRoot, mode);
      }
      const r = await callTaceenSubprocess({ intent: 'resolve', query, workspaceRoot, mode });
      return r ?? undefined;
    } catch (e) {
      console.error('[taceen] hook error:', e?.message ?? e);
      return undefined;
    }
  },

  async beforeToolCall({ tool, input, risk, workspaceRoot, sessionId } = {}) {
    try {
      if (!config.enabled) return undefined;
      if (config.mode === 'mock') {
        return mockValidate(tool, input, risk);
      }
      const r = await callTaceenSubprocess({
        intent: 'validate',
        tool,
        input,
        risk,
        workspaceRoot,
        sessionId,
      });
      // null → undefined → ALLOW. Taceen being down must never block the agent.
      return r ?? undefined;
    } catch (e) {
      console.error('[taceen] hook error:', e?.message ?? e);
      return undefined;
    }
  },
};

// ---------------------------------------------------------------------------
// Mock implementations (mode: "mock")
// ---------------------------------------------------------------------------

function mockResolve(query, workspaceRoot, mode) {
  // First line on purpose — this log line is a spec'd verification marker.
  console.log('[MOCK] Taceen resolve:', query);

  const q = String(query ?? '').toLowerCase();
  const available = [];

  // Heuristic, case-insensitive, ACCUMULATE all matches.
  if (q.includes('file')) {
    available.push({ type: 'tool', name: 'read_file', reason: 'filesystem read' });
  }
  if (q.includes('test')) {
    available.push({ type: 'tool', name: 'bash', reason: 'run test commands' });
  }
  if (q.includes('web')) {
    available.push({ type: 'mcp', name: 'mcp_browser_navigate', reason: 'browser automation via MCP' });
  }

  return {
    available, // may be [] when nothing matched
    hint: '[MOCK] heuristic resolver — set mode "subprocess" in .tagent/plugins/taceen.json for the real Taceen',
  };
}

function mockValidate(tool, input, risk) {
  if (tool === 'bash' && String(input?.command ?? '').includes('rm -rf')) {
    return {
      action: 'block',
      reason: '[MOCK] destructive command detected (rm -rf)',
      alternative: 'list the target first (list_files), then remove specific paths one by one',
    };
  }
  return undefined; // allow
}

// ---------------------------------------------------------------------------
// Subprocess bridge (mode: "subprocess") — JSON over stdin/stdout.
//
// Script-resolution strategy (ONE strategy, documented):
//   The workspace root is derived from THIS plugin file's location — the
//   plugin sits at <root>/.tagent/plugins/taceen.mjs, so root is three
//   path.dirname() hops up from the plugin file — and `config.taceenScript`
//   (a root-relative path from taceen.json) is resolved against that root.
//   The req's workspaceRoot, when present, is forwarded to the subprocess as
//   request DATA only; it never affects script resolution (it is runtime
//   input, not a trusted config source, and a global ~/.tagent/plugins
//   install may legitimately point taceenScript at a per-repo checkout
//   anyway).
// ---------------------------------------------------------------------------

function resolveTaceenScript() {
  const pluginFile = pluginFilePath();
  // <root>/.tagent/plugins/taceen.mjs → strip file, "plugins", ".tagent" → <root>.
  // (dirname x3, then resolve the root-relative config path — verified live:
  // a shorter chain pointed at <root>/.tagent/.tagent/... and python exited 2.)
  const root = path.dirname(path.dirname(path.dirname(pluginFile)));
  return path.resolve(root, config.taceenScript);
}

function callTaceenSubprocess(req) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    try {
      const script = resolveTaceenScript();
      const child = spawn(config.pythonPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      const timer = setTimeout(() => {
        console.error(`[taceen] subprocess timeout after ${config.timeoutMs}ms — falling back to allow`);
        child.kill();
        settle(null);
      }, config.timeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d;
      });

      child.on('error', (e) => {
        // Spawn failure (e.g. python3 missing from PATH) → allow.
        clearTimeout(timer);
        console.error('[taceen] subprocess failed to start:', e?.message ?? e);
        settle(null);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return; // outcome already decided (e.g. timeout kill)
        const text = stdout.trim();
        if (!text) {
          console.error(`[taceen] subprocess exited with code ${code} and no output — falling back to allow`);
          return settle(null);
        }
        try {
          settle(JSON.parse(text));
        } catch (e) {
          console.error('[taceen] subprocess returned unparseable JSON:', e?.message ?? e);
          settle(null);
        }
      });

      // The child may die before draining stdin (EPIPE) — swallow it;
      // the close/error handlers above are the authoritative outcome.
      child.stdin.on('error', () => {});

      child.stdin.write(JSON.stringify(req) + '\n');
      child.stdin.end();
    } catch (e) {
      console.error('[taceen] subprocess error:', e?.message ?? e);
      settle(null);
    }
  });
}
