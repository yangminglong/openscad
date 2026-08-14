#!/usr/bin/env node
/**
 * OpenSCAD Server-Side Rendering Demo
 *
 * Wraps the `openscad` CLI binary in a lightweight HTTP API.
 * The browser sends SCAD source → the server spawns openscad → returns
 * rendered geometry / preview image. No SCAD execution in the browser.
 *
 * Usage:
 *   OPENSCAD_BIN=/path/to/openscad node server.js
 *   Default: ../build-cli/openscad   (relative to this file)
 */

import http from 'node:http';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, rm as fsRm, mkdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// ── Configuration ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const OPENSCAD_BIN = process.env.OPENSCAD_BIN || join(__dirname, '../../build-cli/openscad');
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT || '60000', 10);  // 60s
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || `${2 * 1024 * 1024}`, 10); // 2MB
const ENABLE_GZIP = process.env.ENABLE_GZIP !== '0';  // 响应 gzip 压缩（按 Accept-Encoding 协商）
const CLIENT_DIR = join(__dirname, 'client');
const WORK_DIR = join(tmpdir(), 'openscad-server-demo');

// ── MIME ──────────────────────────────────────────────────────────────────

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json',
  '.png':   'image/png',
  '.stl':   'model/stl',
  '.binmesh': 'application/octet-stream',
  '.3mf':   'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  '.svg':   'image/svg+xml',
  '.off':   'text/plain',
  '.csv':   'text/csv',
  '.scad':  'text/plain; charset=utf-8',
};

// ── Concurrency Limiter ───────────────────────────────────────────────────

let running = 0;
const queue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (running < MAX_CONCURRENT) {
      running++;
      resolve();
    } else {
      queue.push(resolve);
    }
  });
}

function releaseSlot() {
  running--;
  if (queue.length > 0) {
    const next = queue.shift();
    running++;
    next();
  }
}

// ── OpenSCAD CLI wrapper ──────────────────────────────────────────────────

/**
 * Execute openscad CLI with the given arguments.
 * @param {string[]} args
 * @param {string} [stdin] - optional SCAD source on stdin
 * @param {number} timeoutMs
 * @returns {Promise<{stdout: Buffer, stderr: string}>}
 */
function runOpenSCAD(args, stdin = null, timeoutMs = RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cp = spawn(OPENSCAD_BIN, args, {
      stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      cp.kill('SIGKILL');
      reject(new Error('Render timed out'));
    }, timeoutMs);

    cp.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    cp.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    cp.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
      } else {
        reject(new Error(`openscad exited ${code}: ${stderr}`));
      }
    });

    cp.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (stdin) {
      cp.stdin.write(stdin);
      cp.stdin.end();
    }
  });
}

// ── Job workspace ─────────────────────────────────────────────────────────

let workDirReady = false;

async function ensureWorkDir() {
  if (!workDirReady) {
    await mkdir(WORK_DIR, { recursive: true });
    workDirReady = true;
  }
}

async function jobWorkspace(prefix = 'job') {
  await ensureWorkDir();
  const id = randomUUID().slice(0, 8);
  const dir = join(WORK_DIR, `${prefix}-${id}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── Logging ──────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 23);  // HH:MM:SS.mmm
}

function logRequest(req, body = null) {
  const src = body
    ? `${(body.length / 1024).toFixed(1)}KB`
    : '-';
  const ua = (req.headers['user-agent'] || '').slice(0, 60);
  console.log(`[${ts()}] ${req.method} ${req.url}  src=${src}  UA="${ua}"`);
}

function logDone(req, result, elapsedMs) {
  const size = result?.byteLength
    ? `${(result.byteLength / 1024).toFixed(1)}KB`
    : '-';
  console.log(`[${ts()}] ${req.method} ${req.url}  → 200  ${size}  ${elapsedMs}ms`);
}

function logFail(req, err, elapsedMs) {
  const msg = (err?.message || err || '').slice(0, 100);
  console.log(`[${ts()}] ${req.method} ${req.url}  → 500  "${msg}"  ${elapsedMs}ms`);
}

// ── Request body parser ───────────────────────────────────────────────────

function readBody(req, maxSize = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── API: JSON response helper ─────────────────────────────────────────────

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(body);
}

// ── Binary response (gzip 协商) ────────────────────────────────────────────
//
// 按 HTTP 规范协商：浏览器 fetch 总是发送 Accept-Encoding: gzip → 自动压缩；
// curl 默认不发 → 返回原始数据，零感知。zip/png/pdf 等已压缩格式跳过。

function maybeGzip(req, buf) {
  const accepts = (req.headers['accept-encoding'] || '').toLowerCase();
  if (ENABLE_GZIP && accepts.includes('gzip') && buf.length > 1024) {
    return { data: gzipSync(buf), encoding: 'gzip' };
  }
  return { data: buf, encoding: null };
}

function sendBinary(res, req, buf, contentType, filename, gzipEligible = true) {
  const { data, encoding } = gzipEligible ? maybeGzip(req, buf) : { data: buf, encoding: null };
  const headers = {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
  };
  if (gzipEligible) headers['Vary'] = 'Accept-Encoding';
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  res.end(data);
}

// ── Health check ──────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  try {
    // Verify the openscad binary exists and works
    // 注意: openscad 的版本信息输出到 stderr（stdout 为空）
    const { stdout, stderr } = await runOpenSCAD(['--version'], null, 5000);
    const version = (stdout.toString('utf8') + stderr.toString('utf8')).trim().split('\n')[0];
    json(res, 200, { status: 'ok', version, binary: OPENSCAD_BIN, concurrency: { running, max: MAX_CONCURRENT } });
  } catch (err) {
    json(res, 503, { status: 'error', message: `openscad binary not usable: ${err.message}`, binary: OPENSCAD_BIN });
  }
}

// ── D-param helper: extract -Dvar=val from query string ──────────────────

function extractDVars(url) {
  const dVars = url.searchParams.getAll('D');
  const args = [];
  for (const d of dVars) {
    args.push('-D', d);
  }
  return args;
}

// ── Filament helper: extract ?F=Name|#RRGGBBAA for 3MF v4 MMU export ────────
// 与 CLI 的 -O export-3mf/filament-colors 同格式，多个条目换行分隔：
//   ?F=PLA|#FF0000FF&F=PETG|#0000FFFF
//   → -O 'export-3mf/filament-colors=PLA|#FF0000FF\nPETG|#0000FFFF'

function extractFilamentArgs(url) {
  const specs = url.searchParams.getAll('F');
  if (specs.length === 0) return [];
  return ['-O', `export-3mf/filament-colors=${specs.join('\n')}`];
}

// ── Render (binmesh / STL binary) ──────────────────────────────────────────

async function handleRender(req, res) {
  const t0 = performance.now();
  await acquireSlot();
  const ws = await jobWorkspace('render');
  const inputPath = join(ws, 'model.scad');

  try {
    const body = await readBody(req);
    logRequest(req, body);

    const scadSource = body.toString('utf8');

    if (!scadSource.trim()) {
      // finally 块统一释放并发槽位，勿在此处重复 releaseSlot()
      return json(res, 400, { error: 'Empty SCAD source' });
    }

    // Normalize line endings
    const source = scadSource.replace(/\r\n/g, '\n');
    await writeFile(inputPath, source, 'utf8');

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // 默认 binmesh（索引化二进制网格，含每面颜色，体积约为 STL 的 1/2.3）；
    // ?format=stl 回退到 binary STL（老客户端/外部工具兼容）
    const fmt = url.searchParams.get('format') || 'binmesh';
    const validFormats = ['binmesh', 'stl'];
    if (!validFormats.includes(fmt)) {
      // finally 块统一释放并发槽位，勿在此处重复 releaseSlot()
      return json(res, 400, { error: `Unknown format: ${fmt}. Valid: ${validFormats.join(', ')}` });
    }

    const dArgs = extractDVars(url);
    const outputPath = join(ws, `output.${fmt}`);
    const exportFormat = fmt === 'stl' ? 'binstl' : 'binmesh';
    await runOpenSCAD(['-o', outputPath, '--export-format', exportFormat, ...dArgs, inputPath]);

    const meshData = await readFile(outputPath);

    logDone(req, meshData, Math.round(performance.now() - t0));

    const contentType = MIME[`.${fmt}`] || 'application/octet-stream';
    sendBinary(res, req, meshData, contentType, `model.${fmt}`);
  } catch (err) {
    logFail(req, err, Math.round(performance.now() - t0));
    json(res, 500, { error: err.message });
  } finally {
    releaseSlot();
    // Clean up workspace
    fsRm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Preview (PNG) ─────────────────────────────────────────────────────────

async function handlePreview(req, res) {
  const t0 = performance.now();
  await acquireSlot();
  const ws = await jobWorkspace('preview');
  const inputPath = join(ws, 'model.scad');
  const outputPath = join(ws, 'output.png');

  try {
    const body = await readBody(req);
    logRequest(req, body);

    const scadSource = body.toString('utf8');

    if (!scadSource.trim()) {
      // finally 块统一释放并发槽位，勿在此处重复 releaseSlot()
      return json(res, 400, { error: 'Empty SCAD source' });
    }

    const source = scadSource.replace(/\r\n/g, '\n');
    await writeFile(inputPath, source, 'utf8');

    // --preview for quick OpenCSG/ThrownTogether preview, or --render for full geometry
    // Default: --preview (faster, good for preview)
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const mode = url.searchParams.get('mode') || 'render';
    const dArgs = extractDVars(url);

    const args = ['-o', outputPath, ...dArgs];
    if (mode === 'preview') {
      args.push('--preview');
    } else {
      args.push('--render');
      args.push('--viewall');
      args.push('--autocenter');
    }
    args.push('--imgsize=800,600');
    args.push('--colorscheme=Cornfield');
    args.push(inputPath);

    const { stderr } = await runOpenSCAD(args);

    const pngData = await readFile(outputPath);
    logDone(req, pngData, Math.round(performance.now() - t0));

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': pngData.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(pngData);
  } catch (err) {
    logFail(req, err, Math.round(performance.now() - t0));
    json(res, 500, { error: err.message });
  } finally {
    releaseSlot();
    fsRm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Generic Export (multiple formats) ─────────────────────────────────────

async function handleExport(req, res) {
  const t0 = performance.now();
  await acquireSlot();
  const ws = await jobWorkspace('export');
  const inputPath = join(ws, 'model.scad');

  try {
    const body = await readBody(req);
    logRequest(req, body);

    const scadSource = body.toString('utf8');

    if (!scadSource.trim()) {
      // finally 块统一释放并发槽位，勿在此处重复 releaseSlot()
      return json(res, 400, { error: 'Empty SCAD source' });
    }

    const source = scadSource.replace(/\r\n/g, '\n');
    await writeFile(inputPath, source, 'utf8');

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const fmt = url.searchParams.get('format') || 'stl';
    const dArgs = extractDVars(url);

    // Validate format
    const validFormats = ['stl', '3mf', 'off', 'amf', 'svg', 'dxf', 'png', 'pdf', 'csg', 'ast', 'term', 'param'];
    if (!validFormats.includes(fmt)) {
      // finally 块统一释放并发槽位，勿在此处重复 releaseSlot()
      return json(res, 400, { error: `Unknown format: ${fmt}. Valid: ${validFormats.join(', ')}` });
    }

    const ext = fmt === 'png' ? 'png' : fmt;
    const outputPath = join(ws, `output.${ext}`);

    const args = ['-o', outputPath, ...dArgs];
    if (fmt === '3mf') {
      // Use v4 exporter (OrcaSlicer-compatible with paint_color MMU tags)
      args.push('--export-format', '3mf_v4');
      // 耗材配置（可选）：?F=Name|#RRGGBBAA 重复传递，控制 MMU 颜色分割与命名
      args.push(...extractFilamentArgs(url));
    }
    if (fmt === 'png') {
      args.push('--render', '--viewall', '--autocenter', '--imgsize=1024,768');
    }
    args.push(inputPath);

    await runOpenSCAD(args);

    const data = await readFile(outputPath);
    logDone(req, data, Math.round(performance.now() - t0));

    const contentType = MIME[`.${ext}`] || 'application/octet-stream';

    // zip(3mf)/png/pdf 已是压缩格式，跳过 gzip
    const gzipEligible = !['3mf', 'png', 'pdf'].includes(ext);
    sendBinary(res, req, data, contentType, `model.${ext}`, gzipEligible);
  } catch (err) {
    logFail(req, err, Math.round(performance.now() - t0));
    json(res, 500, { error: err.message });
  } finally {
    releaseSlot();
    fsRm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Params: extract Customizer parameter definitions ─────────────────────

async function handleParams(req, res) {
  const t0 = performance.now();
  const ws = await jobWorkspace('params');
  const inputPath = join(ws, 'model.scad');
  const outputPath = join(ws, 'params.json');

  try {
    const body = await readBody(req);
    logRequest(req, body);

    const scadSource = body.toString('utf8');
    if (!scadSource.trim()) {
      return json(res, 400, { error: 'Empty SCAD source' });
    }

    const source = scadSource.replace(/\r\n/g, '\n');
    await writeFile(inputPath, source, 'utf8');

    await runOpenSCAD(['-o', outputPath, '--export-format=param', inputPath]);

    const raw = await readFile(outputPath, 'utf8');
    const params = JSON.parse(raw);
    logDone(req, Buffer.from(raw), Math.round(performance.now() - t0));
    json(res, 200, params);
  } catch (err) {
    logFail(req, err, Math.round(performance.now() - t0));
    json(res, 500, { error: err.message });
  } finally {
    fsRm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Static file serving ───────────────────────────────────────────────────

async function serveStatic(req, res, filePath) {
  // Prevent directory traversal (strict prefix check with path.sep)
  const normalized = path.normalize(filePath);
  // Allow client/ assets and .scad demo files from the project root
  const isClientFile = normalized === CLIENT_DIR ||
    normalized.startsWith(CLIENT_DIR + path.sep);
  const isScadFile = normalized.endsWith('.scad') &&
    (normalized === __dirname || normalized.startsWith(__dirname + path.sep));
  if (!isClientFile && !isScadFile) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const st = await stat(normalized);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(normalized);
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// ── Router ────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS headers for API
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API routes
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return handleHealth(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/render') {
    return handleRender(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/preview') {
    return handlePreview(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/export') {
    return handleExport(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/params') {
    return handleParams(req, res);
  }

  // Static files
  let servePath = url.pathname;
  if (servePath === '/' || servePath === '') servePath = '/index.html';
  // .scad demo files live in the project root (next to server.js)
  const baseDir = servePath.endsWith('.scad') ? __dirname : CLIENT_DIR;
  const absPath = join(baseDir, servePath);
  if (servePath.endsWith('.scad')) {
    logRequest(req);
  }
  return serveStatic(req, res, absPath);
}

// ── Startup ───────────────────────────────────────────────────────────────

async function main() {
  // Verify binary exists
  if (!existsSync(OPENSCAD_BIN)) {
    console.error(`ERROR: OpenSCAD binary not found at: ${OPENSCAD_BIN}`);
    console.error('Set OPENSCAD_BIN env var or build:');
    console.error('  cd openscad && mkdir -p build-cli && cd build-cli && cmake -DHEADLESS=ON .. && make -j$(nproc)');
    process.exit(1);
  }

  await ensureWorkDir();

  const server = http.createServer(handleRequest);

  server.listen(PORT, HOST, () => {
    const hostDisplay = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   OpenSCAD Server-Client Demo                        ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║   Server:    http://${hostDisplay}:${PORT}                     ║`);
    console.log(`║   API Base:  http://${hostDisplay}:${PORT}/api               ║`);
    console.log(`║   Binary:    ${OPENSCAD_BIN}`);
    console.log(`║   Timeout:   ${RENDER_TIMEOUT_MS / 1000}s                            ║`);
    console.log(`║   Workers:   ${MAX_CONCURRENT}                               ║`);
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║   Endpoints:                                         ║');
    console.log('║     POST /api/render    → STL binary                 ║');
    console.log('║     POST /api/preview   → PNG image                  ║');
    console.log('║     POST /api/export?format=3mf → Export file        ║');
    console.log('║     GET  /api/health    → Server status              ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
