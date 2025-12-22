/**
 * 测试用 WebSocket 服务器
 * 用于测试 SillyTavern WebSocket 消息拦截器扩展
 * 
 * 运行方法: node test-server.js
 * 需要先安装依赖: npm install ws
 */

const WebSocket = require('ws');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket 测试服务器已启动，监听端口 ${PORT}`);

wss.on('connection', (ws) => {
    console.log('客户端已连接');

    ws.on('message', (message) => {
        console.log('收到消息:', message.toString());
        
        try {
            const data = JSON.parse(message.toString());
            
            // 处理用户输入
            if (data.type === 'user_input') {
                const userContent = data.content;
                
                // 这里可以对用户输入进行任何处理
                // 示例：在消息前添加前缀
                const processedContent = `[已处理] ${userContent}`;
                
                // 返回处理后的内容
                const response = {
                    type: 'response',
                    content: processedContent,
                    original: userContent,
                    timestamp: Date.now()
                };
                
                console.log('发送响应:', response);
                ws.send(JSON.stringify(response));
            }
        } catch (error) {
            console.error('处理消息时出错:', error);
            // 如果解析失败，直接返回原始消息
            ws.send(JSON.stringify({
                type: 'error',
                content: message.toString(),
                error: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('客户端已断开连接');
    });

    ws.on('error', (error) => {
        console.error('WebSocket 错误:', error);
    });
});

console.log('等待 SillyTavern 扩展连接...');
console.log('按 Ctrl+C 停止服务器');
