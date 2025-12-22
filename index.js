// SillyTavern WebSocket 消息拦截扩展
// 在发送消息给AI之前，先通过WebSocket与服务端通信

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// 扩展基本信息
const extensionName = "st-extension-example";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 默认设置
const defaultSettings = {
    enabled: true,
    wsServerHost: "localhost",
    wsServerPort: 8080,
    timeout: 30000, // 超时时间(毫秒)
};

// WebSocket 连接实例
let wsConnection = null;
let isWaitingForResponse = false;

/**
 * 加载扩展设置
 */
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    // 兼容旧版设置（如果存在wsServerUrl则解析）
    if (extension_settings[extensionName].wsServerUrl && !extension_settings[extensionName].wsServerHost) {
        try {
            const url = new URL(extension_settings[extensionName].wsServerUrl);
            extension_settings[extensionName].wsServerHost = url.hostname;
            extension_settings[extensionName].wsServerPort = parseInt(url.port) || 8080;
        } catch (e) {
            extension_settings[extensionName].wsServerHost = defaultSettings.wsServerHost;
            extension_settings[extensionName].wsServerPort = defaultSettings.wsServerPort;
        }
    }

    // 更新UI显示
    $("#ws_interceptor_enabled").prop("checked", extension_settings[extensionName].enabled);
    $("#ws_server_host").val(extension_settings[extensionName].wsServerHost);
    $("#ws_server_port").val(extension_settings[extensionName].wsServerPort);
    $("#ws_timeout").val(extension_settings[extensionName].timeout / 1000);
}

/**
 * 获取当前设置
 */
/**
 * 获取当前设置
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * 获取完整的WebSocket URL
 */
function getWsUrl() {
    const settings = getSettings();
    return `ws://${settings.wsServerHost}:${settings.wsServerPort}`;
}

/**
 * 创建WebSocket连接并发送消息
 * @param {string} userInput 用户输入的消息
 * @returns {Promise<string>} 服务端返回的处理后的消息
 */
function sendToWebSocket(userInput) {
    return new Promise((resolve, reject) => {
        const settings = getSettings();
        const wsUrl = getWsUrl();
        const timeout = settings.timeout;

        console.log(`[WS Interceptor] 正在连接到 WebSocket 服务器: ${wsUrl}`);

        try {
            wsConnection = new WebSocket(wsUrl);

            // 设置超时定时器
            const timeoutId = setTimeout(() => {
                if (wsConnection && wsConnection.readyState !== WebSocket.CLOSED) {
                    wsConnection.close();
                }
                reject(new Error(`WebSocket 连接超时 (${timeout / 1000}秒)`));
            }, timeout);

            wsConnection.onopen = () => {
                console.log("[WS Interceptor] WebSocket 连接已建立");
                // 发送用户输入到服务端
                const message = JSON.stringify({
                    type: "user_input",
                    content: userInput,
                    timestamp: Date.now()
                });
                wsConnection.send(message);
                console.log("[WS Interceptor] 已发送消息到服务端:", userInput);
                
                // 弹窗通知：消息已发送
                toastr.info(
                    `消息已发送到服务端\n内容: ${userInput.substring(0, 50)}${userInput.length > 50 ? '...' : ''}`,
                    "📤 发送消息",
                    { timeOut: 3000, extendedTimeOut: 2000 }
                );
            };

            wsConnection.onmessage = (event) => {
                clearTimeout(timeoutId);
                console.log("[WS Interceptor] 收到服务端响应:", event.data);
                
                let processedContent;
                try {
                    // 尝试解析JSON响应
                    const response = JSON.parse(event.data);
                    processedContent = response.content || response.text || response.message || event.data;
                } catch (e) {
                    // 如果不是JSON，直接使用原始文本
                    processedContent = event.data;
                }
                
                // 弹窗通知：收到响应
                toastr.success(
                    `服务端返回内容:\n${processedContent.substring(0, 100)}${processedContent.length > 100 ? '...' : ''}`,
                    "📥 收到响应",
                    { timeOut: 5000, extendedTimeOut: 3000 }
                );
                
                // 关闭连接
                wsConnection.close();
                resolve(processedContent);
            };

            wsConnection.onerror = (error) => {
                clearTimeout(timeoutId);
                console.error("[WS Interceptor] WebSocket 错误:", error);
                reject(new Error("WebSocket 连接错误"));
            };

            wsConnection.onclose = (event) => {
                console.log("[WS Interceptor] WebSocket 连接已关闭", event.code, event.reason);
            };

        } catch (error) {
            reject(new Error(`无法创建 WebSocket 连接: ${error.message}`));
        }
    });
}

/**
 * 拦截用户消息并通过WebSocket处理
 * @param {string} userMessage 原始用户消息
 * @returns {Promise<string>} 处理后的消息
 */
async function interceptMessage(userMessage) {
    const settings = getSettings();
    
    if (!settings.enabled) {
        console.log("[WS Interceptor] 扩展已禁用，直接发送原始消息");
        return userMessage;
    }

    if (isWaitingForResponse) {
        console.log("[WS Interceptor] 正在等待上一个请求的响应");
        toastr.warning("请等待上一个请求完成");
        return null; // 返回null表示取消发送
    }

    try {
        isWaitingForResponse = true;
        const wsUrl = getWsUrl();
        toastr.info(
            `正在连接到 ${wsUrl}...`,
            "🔌 WebSocket 连接中",
            { timeOut: 2000 }
        );
        
        // 发送到WebSocket服务端并等待响应
        const processedMessage = await sendToWebSocket(userMessage);
        
        console.log("[WS Interceptor] 处理后的消息:", processedMessage);
        toastr.success(
            "消息处理完成，正在发送给 AI",
            "✅ 处理完成",
            { timeOut: 3000 }
        );
        
        return processedMessage;
    } catch (error) {
        console.error("[WS Interceptor] 处理消息时出错:", error);
        toastr.error(`处理失败: ${error.message}`, "WS Interceptor");
        // 出错时返回原始消息，让用户决定是否继续
        return userMessage;
    } finally {
        isWaitingForResponse = false;
    }
}

/**
 * 消息发送前的事件处理器
 */
async function onMessageSendBefore(data) {
    const settings = getSettings();
    
    if (!settings.enabled) {
        return;
    }

    // 获取用户输入
    const userMessage = data.message;
    
    if (!userMessage || userMessage.trim() === "") {
        return;
    }

    console.log("[WS Interceptor] 拦截到用户消息:", userMessage);

    try {
        // 处理消息
        const processedMessage = await interceptMessage(userMessage);
        
        if (processedMessage === null) {
            // 取消发送
            data.abort = true;
            return;
        }

        // 用处理后的消息替换原始消息
        data.message = processedMessage;
        console.log("[WS Interceptor] 消息已替换为处理后的内容");
        
    } catch (error) {
        console.error("[WS Interceptor] 处理失败:", error);
        toastr.error(`WebSocket处理失败: ${error.message}`);
    }
}

/**
 * 启用状态改变处理器
 */
function onEnabledChange(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].enabled = value;
    saveSettingsDebounced();
    
    if (value) {
        toastr.success("WebSocket 拦截器已启用");
    } else {
        toastr.info("WebSocket 拦截器已禁用");
    }
}

/**
 * 服务器地址改变处理器
 */
function onServerHostChange(event) {
    const value = $(event.target).val();
    extension_settings[extensionName].wsServerHost = value;
    saveSettingsDebounced();
}

/**
 * 服务器端口改变处理器
 */
function onServerPortChange(event) {
    const value = parseInt($(event.target).val()) || 8080;
    extension_settings[extensionName].wsServerPort = value;
    saveSettingsDebounced();
}

/**
 * 超时时间改变处理器
 */
function onTimeoutChange(event) {
    const value = parseInt($(event.target).val()) * 1000;
    extension_settings[extensionName].timeout = value;
    saveSettingsDebounced();
}

/**
 * 测试WebSocket连接
 */
async function onTestConnection() {
    const wsUrl = getWsUrl();
    
    try {
        toastr.info(`正在测试连接到 ${wsUrl}...`, "🔌 测试连接");
        
        const ws = new WebSocket(wsUrl);
        
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error("连接超时"));
            }, 5000);

            ws.onopen = () => {
                clearTimeout(timeout);
                ws.close();
                resolve();
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                reject(new Error("连接失败"));
            };
        });

        toastr.success(`✅ 成功连接到 ${wsUrl}`, "连接测试成功");
    } catch (error) {
        toastr.error(`❌ 连接失败: ${error.message}`, "连接测试失败");
    }
}

// 扩展初始化
jQuery(async () => {
    // 加载设置面板HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
    $("#extensions_settings").append(settingsHtml);

    // 绑定事件处理器
    $("#ws_interceptor_enabled").on("change", onEnabledChange);
    $("#ws_server_host").on("change", onServerHostChange);
    $("#ws_server_port").on("change", onServerPortChange);
    $("#ws_timeout").on("change", onTimeoutChange);
    $("#ws_test_connection").on("click", onTestConnection);

    // 加载设置
    await loadSettings();

    // 注册消息发送前的事件监听器
    // 使用 MESSAGE_SENT 事件来拦截消息
    eventSource.on(event_types.MESSAGE_SENDING, onMessageSendBefore);

    console.log("[WS Interceptor] 扩展已加载");
});
