#!/usr/bin/env node
import http from 'http';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

// --- 配置 ---
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'mcp-logs');
const MAX_MEMORY_RESULTS = 50;
const MAX_NETWORK_LOGS = 100;

// ==========================================
// 1. ResultStore (变量存储)
// ==========================================
class ResultStore extends EventEmitter {
  constructor() {
    super();
    this.results = [];
    this.currentSession = null;
    this.ensureResultsDir();
  }
  async ensureResultsDir() { try { await fs.mkdir(RESULTS_DIR, { recursive: true }); } catch (e) {} }
  async saveResult(result) {
    const timestamp = new Date().toISOString();
    const sessionId = this.currentSession || `session-${Date.now()}`;
    this.currentSession = sessionId;
    const resultData = { timestamp, sessionId, ...result };
    this.results.push(resultData);
    if (this.results.length > MAX_MEMORY_RESULTS) this.results.shift();
    this.emit('new_capture', resultData);
    const filename = path.join(RESULTS_DIR, `${sessionId}.jsonl`);
    fs.appendFile(filename, JSON.stringify(resultData) + '\n').catch(e => console.error(e));
    return resultData;
  }
  consume(limit) {
    if (this.results.length === 0) return [];
    const items = this.results.slice(-limit);
    if (limit >= this.results.length) this.results = [];
    else this.results.splice(this.results.length - limit, limit);
    return items;
  }
  getAll() { return this.results; }
}

// ==========================================
// 2. NetworkStore (网络请求存储)
// ==========================================
class NetworkStore {
  constructor() {
    this.requests = new Map();
    this.requestOrder = [];
  }
  captureRequest({ requestId, request, initiator, type }) {
    if (!this.requests.has(requestId)) {
      this.requests.set(requestId, {
        requestId, url: request.url, method: request.method, type: type || 'Unknown',
        status: 'Pending', timestamp: new Date().toISOString(), initiator
      });
      this.requestOrder.push(requestId);
      if (this.requestOrder.length > MAX_NETWORK_LOGS) this.requests.delete(this.requestOrder.shift());
    }
  }
  updateResponse({ requestId, response }) {
    if (this.requests.has(requestId)) {
      this.requests.get(requestId).status = response.status;
    }
  }
  getAll(limit = 20) {
    return this.requestOrder.slice(-limit).map(id => {
      const r = this.requests.get(id);
      return { requestId: r.requestId, url: r.url, method: r.method, status: r.status, type: r.type };
    }).reverse();
  }
  getDetails(requestId) { return this.requests.get(requestId) || null; }
}

// ==========================================
// 3. ChromeBreakpoint (CDP 控制器)
// ==========================================
class ChromeBreakpoint {
  constructor(resultStore, networkStore) {
    this.ws = null;
    this.messageId = 0;
    this.pendingCallbacks = new Map();
    this.resultStore = resultStore;
    this.networkStore = networkStore;
    this.isRunning = false;
    this.targetConfig = null;
    this.knownScripts = new Map();
  }

  async getDebuggerUrl(port) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/json`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data);
            const page = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'));
            if (page) resolve(page.webSocketDebuggerUrl);
            else reject(new Error(`No debuggable page on port ${port}`));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
    });
  }

  async _initConnection(port) {
    if (this.isRunning) await this.stop();
    const wsUrl = await this.getDebuggerUrl(port);
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.isRunning = true;
    this.ws.on('message', (d) => this.handleMessage(JSON.parse(d.toString())));
    await this.send('Debugger.enable');
    await this.send('Runtime.enable');
    await this.send('Page.enable'); 
    await this.send('Network.enable');
  }

  async connectAndBreak(port, targetFile, line, col, refresh) {
    await this._initConnection(port);
    this.targetConfig = { pattern: targetFile, line, col };
    if (refresh) await this.refreshPage();
    return `Connected. Monitoring "${targetFile}"...`;
  }

  async connectOnly(port) {
    await this._initConnection(port);
    this.targetConfig = null;
    return `Connected to CDP port ${port}.`;
  }

  async refreshPage() {
    if (!this.ws) throw new Error("Not connected");
    this.knownScripts.clear();
    this.lastScriptId = null;
    console.log('[Server] Refreshing page, clearing script cache...');
    await this.send('Page.reload', { ignoreCache: true });
    return "Refreshed.";
  }

  findScript(urlPattern) {
    for (const [id, script] of this.knownScripts) {
      if (script.url && (script.url.includes(urlPattern) || new RegExp(urlPattern).test(script.url))) {
        return script;
      }
    }
    return null;
  }

  async getScriptContent(urlPattern) {
    let script = this.findScript(urlPattern);
    // 如果找不到，尝试完全匹配 URL
    if (!script) {
        for (const [id, s] of this.knownScripts) {
            if (s.url === urlPattern) { script = s; break; }
        }
    }
    
    if (!script) {
        // 如果是 internal script 或者 VM script，可能没有 URL，这里简单处理
        throw new Error(`Script matching "${urlPattern}" not found in cache.`);
    }

    try {
        const result = await this.send('Debugger.getScriptSource', { scriptId: script.scriptId });
        if (!result || !result.scriptSource) throw new Error("Empty source.");
        const lines = result.scriptSource.split(/\r?\n/);
        return { scriptId: script.scriptId, url: script.url, totalLines: lines.length, lines: lines };
    } catch (e) {
        if (e.message && e.message.includes('No script for id')) {
            this.knownScripts.delete(script.scriptId);
            throw new Error(`Script expired. Page likely reloaded.`);
        }
        throw e;
    }
  }

  handleMessage(msg) {
    if (msg.id && this.pendingCallbacks.has(msg.id)) {
      this.pendingCallbacks.get(msg.id)(msg);
      this.pendingCallbacks.delete(msg.id);
      return;
    }
    switch (msg.method) {
      case 'Debugger.scriptParsed': this.handleScriptParsed(msg.params); break;
      case 'Runtime.executionContextsCleared':
      case 'Page.frameNavigated':
        console.log('[Server] Page context cleared. Resetting script cache.');
        this.knownScripts.clear();
        this.lastScriptId = null;
        break;
      case 'Debugger.paused': this.handlePaused(msg.params); break;
      case 'Network.requestWillBeSent': this.networkStore.captureRequest(msg.params); break;
      case 'Network.responseReceived': this.networkStore.updateResponse(msg.params); break;
    }
  }

  async handleScriptParsed({ url, scriptId }) {
    if (url) this.knownScripts.set(scriptId, { url, scriptId });
    if (!url || !this.targetConfig) return;
    const { pattern, line, col } = this.targetConfig;
    if (url.includes(pattern) || new RegExp(pattern).test(url)) {
      if (this.lastScriptId === scriptId) return;
      this.lastScriptId = scriptId;
      try {
        await this.send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: line - 1, columnNumber: col }});
        console.log(`[Server] Breakpoint set: ${url}`);
      } catch (e) { console.error(`Breakpoint error: ${e.message}`); }
    }
  }

  async handlePaused(params) {
    try {
      const frame = params.callFrames[0];
      if (!frame) return;
      const result = { functionName: frame.functionName, variables: {} };
      const localScope = frame.scopeChain.find(s => s.type === 'local');
      if (localScope?.object?.objectId) {
        const props = await this.send('Runtime.getProperties', { objectId: localScope.object.objectId, ownProperties: true, generatePreview: true });
        if (props.result) props.result.forEach(p => result.variables[p.name] = p.value?.value || p.value?.description || 'unknown');
      }
      await this.resultStore.saveResult(result);
      console.log(`[Server] Captured variables.`);
    } catch (e) { console.error(e); } finally { await this.send('Debugger.resume'); }
  }

  async send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('No connection'));
      const id = ++this.messageId;
      this.pendingCallbacks.set(id, (msg) => {
        if (msg.error) reject(msg.error); else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async stop() {
    if (this.ws) {
      try { await this.send('Debugger.disable'); await this.send('Runtime.disable'); await this.send('Network.disable'); } catch(e){}
      this.ws.close();
    }
    this.isRunning = false;
    this.knownScripts.clear();
    return "Stopped.";
  }
}

// ==========================================
// MCP Server Tools
// ==========================================
const resultStore = new ResultStore();
const networkStore = new NetworkStore();
const debuggerService = new ChromeBreakpoint(resultStore, networkStore);

const mcpServer = new McpServer({ name: "Chrome-Debugger-Pro", version: "1.3.0" });

// --- 调试控制工具 ---

mcpServer.tool(
  "start_debugging",
  "Connects to Chrome, sets a breakpoint, and optionally refreshes the page.",
  {
    targetFile: z.string().describe("Partial filename to match (e.g. 'chunk-vendors')"),
    lineNumber: z.number().describe("Line number to break on (1-based)"),
    columnNumber: z.number().default(0).describe("Column number (0-based)"),
    port: z.number().default(9222).describe("Chrome remote debugging port"),
    refresh: z.boolean().default(true).describe("Whether to refresh the page to trigger the breakpoint")
  },
  async ({ targetFile, lineNumber, columnNumber, port, refresh }) => ({
    content: [{ type: "text", text: await debuggerService.connectAndBreak(port, targetFile, lineNumber, columnNumber, refresh) }]
  })
);

mcpServer.tool(
  "connect_cdp_port",
  "Connects to Chrome CDP without setting breakpoints, useful for network monitoring.",
  { port: z.number().default(9222).describe("Chrome remote debugging port") },
  async ({ port }) => ({
    content: [{ type: "text", text: await debuggerService.connectOnly(port) }]
  })
);

mcpServer.tool(
  "stop_debugging",
  "Disconnects the debugger and clears cache.",
  {},
  async () => ({ content: [{ type: "text", text: await debuggerService.stop() }] })
);

mcpServer.tool(
  "refresh_page",
  "Reloads the current page in Chrome (ignoring cache) to re-trigger scripts.",
  {},
  async () => ({ content: [{ type: "text", text: await debuggerService.refreshPage() }] })
);

mcpServer.tool(
  "get_vars",
  "Retrieves (and consumes) the latest local variables captured from breakpoints.",
  { limit: z.number().default(1).describe("Number of captured states to retrieve") },
  async ({ limit }) => {
    const data = resultStore.consume(limit);
    if (data.length === 0) return { content: [{ type: "text", text: "No new captured variables." }] };
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// --- 网络分析工具 ---

mcpServer.tool(
  "get_recent_network_requests",
  "Lists recent network requests (URL, method, status). Use this to find requestId.",
  { limit: z.number().default(20).describe("Number of requests to return") },
  async ({ limit }) => ({
    content: [{ type: "text", text: JSON.stringify(networkStore.getAll(limit), null, 2) }]
  })
);

mcpServer.tool(
  "get_request_details",
  "Gets full details of a specific request, including headers and raw initiator info.",
  { requestId: z.string().describe("The ID of the request to inspect") },
  async ({ requestId }) => ({
    content: [{ type: "text", text: JSON.stringify(networkStore.getDetails(requestId), null, 2) }]
  })
);

// --- 源码分析工具 ---

mcpServer.tool(
  "get_script_info",
  "Gets metadata (line count, scriptId) for a file to verify it exists.",
  { urlPattern: z.string().describe("Partial filename or URL") },
  async ({ urlPattern }) => {
    try {
      const info = await debuggerService.getScriptContent(urlPattern);
      return { content: [{ type: "text", text: JSON.stringify({ url: info.url, scriptId: info.scriptId, totalLines: info.totalLines }, null, 2) }] };
    } catch (error) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
  }
);

mcpServer.tool(
  "read_script_lines",
  "Reads a range of lines from a script file.",
  { 
    urlPattern: z.string().describe("Partial filename or URL"),
    startLine: z.number().describe("Start line (1-based)"),
    endLine: z.number().describe("End line (1-based)")
  },
  async ({ urlPattern, startLine, endLine }) => {
    try {
      if (startLine < 1 || endLine < startLine) throw new Error("Invalid range");
      const info = await debuggerService.getScriptContent(urlPattern);
      const effectiveEnd = Math.min(endLine, info.totalLines);
      const content = info.lines.slice(startLine - 1, effectiveEnd).join('\n');
      return { content: [{ type: "text", text: `File: ${info.url}\nRange: ${startLine}-${effectiveEnd}\n\n${content}` }] };
    } catch (error) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
  }
);

mcpServer.tool(
  "read_code_around_location",
  "Reads code around a specific line/column, useful for minified files.",
  {
    urlPattern: z.string().describe("Filename pattern"),
    lineNumber: z.number().describe("Line number (1-based)"),
    columnNumber: z.number().describe("Column number (0-based)"),
    radius: z.number().default(200).describe("Chars to read before/after")
  },
  async ({ urlPattern, lineNumber, columnNumber, radius }) => {
    try {
      const info = await debuggerService.getScriptContent(urlPattern);
      if (lineNumber < 1 || lineNumber > info.totalLines) throw new Error("Line out of bounds");
      const lineContent = info.lines[lineNumber - 1];
      const start = Math.max(0, columnNumber - radius);
      const end = Math.min(lineContent.length, columnNumber + radius);
      let snippet = lineContent.substring(start, end);
      if (start > 0) snippet = '...' + snippet;
      if (end < lineContent.length) snippet = snippet + '...';
      const pointerOffset = columnNumber - start + (start > 0 ? 3 : 0);
      return { content: [{ type: "text", text: `File: ${info.url}\n${snippet}\n${' '.repeat(Math.max(0, pointerOffset))}^` }] };
    } catch (error) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
  }
);

// --- 🌟 新增：高级调用栈分析工具 ---

mcpServer.tool(
  "get_request_call_stack",
  "Retrieves the JS call stack (Initiator) for a network request and fetches the code snippet for each stack frame.",
  {
    requestId: z.string().describe("The ID of the request to analyze"),
    radius: z.number().default(100).describe("Context characters radius for snippets")
  },
  async ({ requestId, radius }) => {
    const req = networkStore.getDetails(requestId);
    if (!req) return { content: [{ type: "text", text: "Request ID not found." }], isError: true };

    const stack = req.initiator?.stack;
    if (!stack || !stack.callFrames || stack.callFrames.length === 0) {
      return { content: [{ type: "text", text: `No JS call stack available for request ${requestId} (Type: ${req.initiator?.type})` }] };
    }

    let report = `Call Stack for ${req.method} ${req.url}:\n${'='.repeat(50)}\n`;

    for (const [index, frame] of stack.callFrames.entries()) {
      const { url, lineNumber, columnNumber, functionName } = frame;
      const displayFunc = functionName || '(anonymous)';
      const location = `${url}:${lineNumber + 1}:${columnNumber}`; // Line is 0-based in CDP
      
      report += `\n[${index}] ${displayFunc} at ${location}\n`;

      if (url) {
        try {
          // 复用 getScriptContent 逻辑获取文件
          // 注意：Initiator 的 URL 必须精准匹配，或者我们需要从 knownScripts 里找
          // 这里的 url 是完整的 URL
          const info = await debuggerService.getScriptContent(url);
          
          if (info && info.lines[lineNumber]) {
             const lineContent = info.lines[lineNumber];
             const start = Math.max(0, columnNumber - radius);
             const end = Math.min(lineContent.length, columnNumber + radius);
             let snippet = lineContent.substring(start, end);
             if (start > 0) snippet = '...' + snippet;
             if (end < lineContent.length) snippet = snippet + '...';
             
             // 指针
             const pointerOffset = columnNumber - start + (start > 0 ? 3 : 0);
             
             report += `   Code:\n   ${snippet}\n   ${' '.repeat(pointerOffset)}^\n`;
          } else {
             report += `   (Source line not found)\n`;
          }
        } catch (e) {
          report += `   (Could not fetch source: ${e.message.split('\n')[0]})\n`;
        }
      } else {
        report += `   (Internal/VM script, no URL)\n`;
      }
    }

    return { content: [{ type: "text", text: report }] };
  }
);

// ==========================================
// Native Node.js HTTP Streaming Server
// ==========================================
const transportMap = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (url.pathname === '/sse') {
    const newSessionId = Date.now().toString();
    console.log(`[SSE] New connection: ${newSessionId}`);
    const transport = new SSEServerTransport(`/messages?sessionId=${newSessionId}`, res);
    transportMap.set(newSessionId, transport);
    req.on('close', () => transportMap.delete(newSessionId));
    await mcpServer.connect(transport);
    return;
  }

  if (url.pathname === '/messages' && req.method === 'POST') {
    let transport = transportMap.get(sessionId);
    if (!transport) {
      if (transportMap.size > 0) transport = Array.from(transportMap.values()).pop();
      else { res.writeHead(404); res.end(JSON.stringify({ error: "Session not found" })); return; }
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => console.log(`✅ MCP Server (Native HTTP) running at http://localhost:${PORT}/sse`));