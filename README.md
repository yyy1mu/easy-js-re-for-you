# Chrome Debugger Pro - MCP Server

一个强大的 Chrome DevTools Protocol (CDP) MCP 服务器，用于调试和分析 JavaScript 应用程序。通过 Model Context Protocol (MCP) 提供断点调试、变量捕获、网络监控和源码分析功能。

## 功能特性

### 🔍 调试控制
- **断点调试**: 连接到 Chrome 并设置断点，捕获局部变量
- **页面刷新**: 支持强制刷新页面以重新触发脚本
- **连接管理**: 灵活的 CDP 连接管理，支持仅连接模式（用于网络监控）

### 📊 网络分析
- **请求监控**: 实时捕获和记录网络请求
- **请求详情**: 获取完整的请求信息，包括请求头、响应状态等
- **调用栈分析**: 获取网络请求的 JavaScript 调用栈，并自动获取每个栈帧的代码片段

### 📝 源码分析
- **脚本信息**: 获取脚本元数据（行数、scriptId 等）
- **代码读取**: 按行范围读取脚本内容
- **位置分析**: 读取指定行/列周围的代码上下文，特别适用于压缩文件

### 💾 数据存储
- **变量捕获**: 自动保存断点捕获的变量到本地文件
- **会话管理**: 支持多会话管理，结果按会话分组存储
- **日志持久化**: 所有捕获的数据自动保存到 `mcp-logs` 目录

## 最简化的运行方法

### 一键启动（三个终端窗口）

**终端 1 - 启动 Chrome（调试模式）:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable
```

**终端 2 - 启动 MCP 服务器:**
```bash
npm install  # 首次运行需要安装依赖
node index.js
```

**终端 3 - 使用 Cherry 连接（stdio 模式）:**
```bash
cherry stdio 快速配置sse http://localhost:3000/sse
```

### 模型建议

- **复杂 JavaScript 代码分析**: 建议使用 **GPT-5.1** 模型以获得更好的代码理解和分析能力
- 对于简单的调试任务，可以使用其他模型

## 快速开始

### 前置要求

1. **Node.js**: 需要 Node.js 18+ 版本（支持 ES 模块）
2. **Chrome/Chromium**: 需要以远程调试模式启动

### 安装依赖

```bash
npm install
```

### 启动 Chrome（远程调试模式）

```bash
# macOS/Linux
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable

# 或者使用 Chromium
chromium --remote-debugging-port=9222
```

### 反调试 JavaScript 处理

如果目标网站包含**反调试 JavaScript 代码**（如检测 DevTools、阻止断点等），建议使用**魔改版 Chrome**：

- 魔改版 Chrome 通常移除了反调试检测机制
- 可以绕过常见的反调试保护（如 `debugger` 语句检测、DevTools 检测等）
- 提供更稳定的调试环境

> **提示**: 项目后续会开发自定义的魔改版 Chrome，专门针对反调试场景进行优化。

### 启动 MCP 服务器

```bash
node index.js
```

服务器将在 `http://localhost:3000` 启动（可通过 `PORT` 环境变量修改）。

### 通过 MCP 客户端连接

连接到 SSE 端点：
```
http://localhost:3000/sse
```

## 使用示例

### 1. 设置断点并开始调试

```javascript
// 在 chunk-vendors.js 的第 100 行设置断点
start_debugging({
  targetFile: "chunk-vendors",
  lineNumber: 100,
  columnNumber: 0,
  port: 9222,
  refresh: true
})
```

### 2. 获取捕获的变量

```javascript
// 获取最近捕获的变量
get_vars({ limit: 1 })
```

### 3. 监控网络请求

```javascript
// 连接到 CDP（不设置断点）
connect_cdp_port({ port: 9222 })

// 获取最近的网络请求
get_recent_network_requests({ limit: 20 })

// 获取请求详情
get_request_details({ requestId: "..." })

// 分析请求的调用栈
get_request_call_stack({ requestId: "...", radius: 100 })
```

### 4. 读取源码

```javascript
// 获取脚本信息
get_script_info({ urlPattern: "chunk-vendors" })

// 读取指定行范围
read_script_lines({
  urlPattern: "chunk-vendors",
  startLine: 1,
  endLine: 50
})

// 读取指定位置周围的代码
read_code_around_location({
  urlPattern: "chunk-vendors",
  lineNumber: 100,
  columnNumber: 500,
  radius: 200
})
```

### 5. 典型使用场景：分析加密请求

以下是一个典型的逆向分析流程，用于分析加密的网络请求：

```text
请使用 MCP 工具连接到 Chrome DevTools 端口 9222，然后执行以下操作：

1. 连接到 CDP 并监控网络请求
   - 使用 connect_cdp_port 连接到端口 9222
   - 刷新目标网站页面

2. 查找目标 API 请求
   - 使用 get_recent_network_requests 获取最近的网络请求列表
   - 找到目标 API 请求的 requestId

3. 分析请求的调用栈
   - 使用 get_request_call_stack 获取该请求的完整 JavaScript 调用栈
   - 分析每个栈帧的代码片段，定位加密逻辑的位置

4. 设置断点进行调试
   - 根据调用栈信息，使用 start_debugging 在关键位置设置断点
   - 刷新页面触发断点

5. 捕获和分析变量
   - 使用 get_vars 获取断点捕获的局部变量
   - 逐步分析加密逻辑，找出加密密钥或算法

6. 读取相关源码
   - 使用 read_code_around_location 有针对性地读取关键代码片段
   - 避免一次性读取整个文件，提高分析效率

注意事项：
- 优先使用调用栈信息定位代码位置，而不是盲目搜索
- 对于压缩文件，使用 read_code_around_location 查看特定位置的代码
- 如果遇到反调试代码，建议使用魔改版 Chrome
```

## 配置

- **端口**: 通过 `PORT` 环境变量设置服务器端口（默认: 3000）
- **Chrome 调试端口**: 默认 9222，可在工具调用时指定
- **日志目录**: 结果保存在 `mcp-logs` 目录，格式为 JSONL

## 项目结构

```
.
├── index.js          # 主服务器文件
├── package.json      # 项目依赖配置
├── README.md         # 项目文档
└── mcp-logs/         # 捕获数据存储目录（自动创建）
```

## 技术栈

- **Model Context Protocol (MCP)**: 用于 AI 工具集成
- **Chrome DevTools Protocol (CDP)**: 与 Chrome 调试器通信
- **WebSocket**: 与 CDP 建立连接
- **Server-Sent Events (SSE)**: MCP 传输协议
- **Zod**: 参数验证

## 注意事项

1. 确保 Chrome 以远程调试模式启动，否则无法连接
2. 断点设置基于文件名模式匹配，确保目标文件已加载
3. 页面刷新会清空脚本缓存，需要重新设置断点
4. 网络请求的调用栈仅在请求发起时可用，某些请求可能没有 JS 调用栈

## 开发计划

- [ ] **WASM 支持**: 测试和开发 WebAssembly 调试功能（计划中）
- [ ] **魔改 Chrome 开发**: 开发自定义的魔改版 Chrome，专门用于绕过反调试保护（计划中）

## 许可证

MIT

