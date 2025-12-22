# SillyTavern WebSocket 消息拦截器扩展

这个扩展可以在用户发送消息给AI之前，先通过WebSocket与外部服务端进行通信，处理用户输入后再发送给AI。

## 功能特点

- 拦截用户发送的消息
- 通过WebSocket发送到自定义服务端
- 等待服务端处理并返回结果
- 用处理后的内容替换原始消息发送给AI
- 支持自定义服务器地址和超时时间
- 提供连接测试功能

## 安装方法

1. 将此扩展文件夹复制到 SillyTavern 的扩展目录：
   ```
   SillyTavern/public/scripts/extensions/third-party/st-extension-example
   ```

2. 重启 SillyTavern 或刷新页面

3. 在设置中找到 "WebSocket 消息拦截器" 面板进行配置

## 使用方法

### 配置扩展

1. 打开 SillyTavern 设置
2. 找到 "WebSocket 消息拦截器" 面板
3. 配置以下选项：
   - **启用 WebSocket 拦截**: 开启/关闭拦截功能
   - **WebSocket 服务器地址**: 设置你的服务器地址（默认: `ws://localhost:8080`）
   - **连接超时时间**: 设置超时时间（秒）
4. 点击 "测试连接" 验证服务器是否可达

### 服务端要求

你的 WebSocket 服务端需要：

1. 接收 JSON 格式的消息：
   ```json
   {
       "type": "user_input",
       "content": "用户输入的文本",
       "timestamp": 1703000000000
   }
   ```

2. 返回 JSON 格式的响应：
   ```json
   {
       "type": "response",
       "content": "处理后的文本"
   }
   ```

   或者直接返回纯文本

## 测试服务器

项目包含一个测试用的 WebSocket 服务器（`test-server.js`）：

```bash
# 安装依赖
npm install ws

# 运行测试服务器
node test-server.js
```

服务器会在 `ws://localhost:8080` 监听连接。

## 工作流程

```
用户输入消息
     ↓
扩展拦截消息
     ↓
建立 WebSocket 连接
     ↓
发送消息到服务端
     ↓
等待服务端处理
     ↓
接收处理后的内容
     ↓
替换原始消息
     ↓
发送给 AI
```

## 文件结构

```
st-extension-example/
├── index.js        # 主扩展脚本
├── example.html    # 设置面板 HTML
├── style.css       # 样式文件
├── manifest.json   # 扩展清单
├── test-server.js  # 测试服务器
└── README.md       # 说明文档
```

## 开发说明

### 事件监听

扩展使用 SillyTavern 的 `MESSAGE_SENDING` 事件来拦截消息：

```javascript
eventSource.on(event_types.MESSAGE_SENDING, onMessageSendBefore);
```

### 消息处理

在 `onMessageSendBefore` 函数中：
- `data.message` 包含原始用户消息
- 设置 `data.message` 为新值可以替换消息内容
- 设置 `data.abort = true` 可以取消发送

## 注意事项

- 确保 WebSocket 服务器在发送消息前已启动
- 如果连接失败或超时，会使用原始消息继续发送
- 控制台会输出详细的调试信息

## 许可证

MIT License
