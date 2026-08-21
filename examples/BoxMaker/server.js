#!/usr/bin/env node
/**
 * BoxMaker server-side renderer.
 *
 * The browser sends SCAD source to this trusted local-development server. The
 * server invokes the OpenSCAD CLI and returns binary STL for preview or STL/3MF
 * files for download. Do not expose this service to untrusted users without
 * filesystem isolation: OpenSCAD include/import directives can access files
 * available to the server process.
 */

"use strict";

const http = require("node:http");
const {spawn} = require("node:child_process");
const {mkdir, readFile, rm, stat, writeFile} = require("node:fs/promises");
const {existsSync} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {randomUUID} = require("node:crypto");

const APP_ROOT = __dirname;
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const LIBRARIES_DIR = path.join(REPO_ROOT, "libraries");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "3001", 10);
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT || "60000", 10);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || "2", 10));
const MAX_BODY_SIZE = Math.max(1024, parseInt(process.env.MAX_BODY_SIZE || `${2 * 1024 * 1024}`, 10));
const MAX_LOG_BYTES = 256 * 1024;
const WORK_ROOT = path.join(os.tmpdir(), "openscad-boxmaker");

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".stl": "model/stl",
  ".3mf": "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
};

function defaultOpenSCADBinary() {
  const candidates = process.platform === "win32" ? [
    path.join(REPO_ROOT, "build-cli", "Release", "openscad.exe"),
    path.join(REPO_ROOT, "build-cli", "openscad.exe")
  ] : [
    path.join(REPO_ROOT, "build-cli", "openscad"),
    path.join(REPO_ROOT, "build-cli", "Release", "openscad")
  ];
  return candidates.find(existsSync) || candidates[0];
}

const OPENSCAD_BIN = process.env.OPENSCAD_BIN || defaultOpenSCADBinary();

let running = 0;
const waiters = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (running < MAX_CONCURRENT) {
      running++;
      resolve();
      return;
    }
    waiters.push(resolve);
  });
}

function releaseSlot() {
  if (waiters.length) {
    waiters.shift()();
    return;
  }
  running = Math.max(0, running - 1);
}

async function withJob(prefix, work) {
  await acquireSlot();
  let workspace;
  try {
    await mkdir(WORK_ROOT, {recursive: true});
    workspace = path.join(WORK_ROOT, `${prefix}-${randomUUID().slice(0, 12)}`);
    await mkdir(workspace, {recursive: true});
    return await work(workspace);
  } finally {
    if (workspace) rm(workspace, {recursive: true, force: true}).catch(() => {});
    releaseSlot();
  }
}

function appendLimited(chunks, chunk, total) {
  if (total.value >= MAX_LOG_BYTES) return;
  const remaining = MAX_LOG_BYTES - total.value;
  const safe = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(safe);
  total.value += safe.length;
}

function openScadEnvironment() {
  const current = process.env.OPENSCADPATH;
  const libraryPath = current ? `${LIBRARIES_DIR}${path.delimiter}${current}` : LIBRARIES_DIR;
  return Object.assign({}, process.env, {OPENSCADPATH: libraryPath});
}

function runOpenSCAD(args, timeoutMs = RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSCAD_BIN, args, {
      cwd: REPO_ROOT,
      env: openScadEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [], stderr = [];
    const stdoutSize = {value: 0}, stderrSize = {value: 0};
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`OpenSCAD timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => appendLimited(stdout, chunk, stdoutSize));
    child.stderr.on("data", (chunk) => appendLimited(stderr, chunk, stderrSize));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        finish(resolve, {stdout: Buffer.concat(stdout), stderr: stderrText});
      } else {
        finish(reject, new Error(`OpenSCAD exited ${code}${stderrText ? `: ${stderrText}` : ""}`));
      }
    });
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, Object.assign(corsHeaders(), {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length
  }));
  res.end(body);
}

function sendBinary(res, data, contentType, filename) {
  res.writeHead(200, Object.assign(corsHeaders(), {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  }));
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error(`SCAD source exceeds ${MAX_BODY_SIZE} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function renderSource(source, format) {
  if (!source.trim()) throw new Error("SCAD source is empty");
  if (format !== "stl" && format !== "3mf") throw new Error(`Unsupported format: ${format}`);

  return withJob(format, async (workspace) => {
    const input = path.join(workspace, "model.scad");
    const output = path.join(workspace, `model.${format}`);
    await writeFile(input, source.replace(/\r\n/g, "\n"), "utf8");
    const exportFormat = format === "3mf" ? "3mf" : "binstl";
    await runOpenSCAD(["-o", output, "--export-format", exportFormat, input]);
    const data = await readFile(output);
    if (data.length === 0) {
      throw new Error(format === "3mf" ? "This OpenSCAD CLI build does not support 3MF export" : "OpenSCAD produced an empty STL file");
    }
    return data;
  });
}

async function detect3mfSupport() {
  const workspace = path.join(WORK_ROOT, `capability-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(workspace, {recursive: true});
    const input = path.join(workspace, "probe.scad");
    const output = path.join(workspace, "probe.3mf");
    await writeFile(input, "cube(1);\n", "utf8");
    await runOpenSCAD(["-o", output, "--export-format", "3mf", input], 10000);
    const data = await readFile(output);
    return data.length > 0;
  } catch (error) {
    return false;
  } finally {
    rm(workspace, {recursive: true, force: true}).catch(() => {});
  }
}

async function handleHealth(res) {
  try {
    const result = await runOpenSCAD(["--version"], 5000);
    const version = `${result.stdout.toString("utf8")}\n${result.stderr}`.trim().split("\n")[0];
    const supports3mf = await detect3mfSupport();
    sendJson(res, 200, {
      status: "ok",
      version,
      binary: OPENSCAD_BIN,
      libraryPath: LIBRARIES_DIR,
      formats: {stl: true, "3mf": supports3mf},
      concurrency: {running, max: MAX_CONCURRENT}
    });
  } catch (error) {
    sendJson(res, 503, {status: "error", message: error.message, binary: OPENSCAD_BIN});
  }
}

async function handleRender(req, res, url) {
  const format = url.searchParams.get("format") || "stl";
  if (format !== "stl") return sendJson(res, 400, {error: "Preview supports only binary STL"});
  try {
    const source = (await readBody(req)).toString("utf8");
    const data = await renderSource(source, "stl");
    sendBinary(res, data, MIME[".stl"], "boxmaker.stl");
  } catch (error) {
    sendJson(res, 500, {error: error.message});
  }
}

async function handleExport(req, res, url) {
  const format = url.searchParams.get("format") || "stl";
  if (format !== "stl" && format !== "3mf") {
    return sendJson(res, 400, {error: "Export format must be stl or 3mf"});
  }
  try {
    const source = (await readBody(req)).toString("utf8");
    const data = await renderSource(source, format);
    sendBinary(res, data, MIME[`.${format}`], `boxmaker.${format}`);
  } catch (error) {
    sendJson(res, 500, {error: error.message});
  }
}

function safeStaticPath(pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  const absolute = path.resolve(APP_ROOT, `.${decoded}`);
  return absolute === APP_ROOT || absolute.startsWith(`${APP_ROOT}${path.sep}`) ? absolute : null;
}

async function serveStatic(req, res, pathname) {
  const file = safeStaticPath(pathname);
  if (!file) {
    res.writeHead(403, {"Content-Type": "text/plain; charset=utf-8"});
    res.end("Forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    const data = await readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {"Content-Type": type, "Content-Length": data.length});
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch {
    res.writeHead(404, {"Content-Type": "text/plain; charset=utf-8"});
    res.end("Not Found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") return handleHealth(res);
  if (req.method === "POST" && url.pathname === "/api/render") return handleRender(req, res, url);
  if (req.method === "POST" && url.pathname === "/api/export") return handleExport(req, res, url);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url.pathname);
  sendJson(res, 405, {error: "Method not allowed"});
}

async function main() {
  if (!existsSync(OPENSCAD_BIN)) {
    console.error(`OpenSCAD CLI not found: ${OPENSCAD_BIN}`);
    console.error("Set OPENSCAD_BIN or build the headless CLI (see 构建说明/build-cli.md).");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(path.join(LIBRARIES_DIR, "BOSL2", "std.scad"))) {
    console.error(`BOSL2 not found: ${path.join(LIBRARIES_DIR, "BOSL2", "std.scad")}`);
    console.error("BoxMaker server requires libraries/BOSL2 for generated rounded rectangles.");
    process.exitCode = 1;
    return;
  }
  await mkdir(WORK_ROOT, {recursive: true});
  http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendJson(res, 500, {error: error.message}));
  }).listen(PORT, HOST, () => {
    console.log(`BoxMaker server: http://${HOST}:${PORT}`);
    console.log(`OpenSCAD CLI: ${OPENSCAD_BIN}`);
    console.log(`BOSL2 library: ${path.join(LIBRARIES_DIR, "BOSL2")}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
