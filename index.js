const MODULE_NAME = 'ws_prompt_injector';
const LOG_PREFIX = '[WS Prompt Injector]';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    wsUrl: '',
});

/** @type {WebSocket | null} */
let ws = null;
/** @type {string | null} */
let wsUrlActive = null;
/** @type {Map<string, {resolve: (v: string) => void, reject: (e: any) => void, timeoutId: number}>} */
const pendingRequests = new Map();

function getContextSafe() {
    if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') {
        throw new Error('SillyTavern.getContext() 不可用：请确认此脚本在 SillyTavern 扩展环境中运行');
    }
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = getContextSafe();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        saveSettingsDebounced();
    }

    // 补齐缺失的默认键（兼容更新）
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }

    return extensionSettings[MODULE_NAME];
}

function logInfo(...args) {
    console.info(LOG_PREFIX, ...args);
}
function logDebug(...args) {
    console.debug(LOG_PREFIX, ...args);
}
function logWarn(...args) {
    console.warn(LOG_PREFIX, ...args);
}
function logError(...args) {
    console.error(LOG_PREFIX, ...args);
}

function friendlyError(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

function updateStatusUi() {
    const $status = jQuery('#ws_prompt_injector_status');
    if ($status.length === 0) return;
    const state = ws?.readyState;
    let text = '未连接';
    if (state === WebSocket.CONNECTING) text = '连接中…';
    if (state === WebSocket.OPEN) text = '已连接';
    if (state === WebSocket.CLOSING) text = '断开中…';
    if (state === WebSocket.CLOSED) text = '已断开';
    $status.text(`${text}${wsUrlActive ? `（${wsUrlActive}）` : ''}`);
}

function closeWs(reason = 'manual') {
    if (!ws) {
        wsUrlActive = null;
        updateStatusUi();
        return;
    }
    try {
        logInfo(`关闭 WS：reason=${reason}`);
        ws.close(1000, reason);
    } catch (err) {
        logWarn('关闭 WS 失败：', err);
    } finally {
        ws = null;
        wsUrlActive = null;
        updateStatusUi();
    }
}

function parseWsPayload(raw) {
    // 支持：
    // 1) 纯文本：直接作为注入文本
    // 2) JSON：{ requestId, text } 或 { requestId, injection } 或 { text } ...
    if (typeof raw !== 'string') return { requestId: null, text: '' };
    const trimmed = raw.trim();
    if (!trimmed) return { requestId: null, text: '' };

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const obj = JSON.parse(trimmed);
            const requestId = typeof obj.requestId === 'string' ? obj.requestId : null;
            const text =
                typeof obj.injection === 'string'
                    ? obj.injection
                    : typeof obj.text === 'string'
                        ? obj.text
                        : typeof obj.message === 'string'
                            ? obj.message
                            : '';
            return { requestId, text };
        } catch {
            // JSON 解析失败则按纯文本处理
        }
    }
    return { requestId: null, text: trimmed };
}

async function connectWs(wsUrl) {
    if (!wsUrl || typeof wsUrl !== 'string') {
        throw new Error('WS 地址为空');
    }
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
        throw new Error('WS 地址必须以 ws:// 或 wss:// 开头');
    }

    if (ws && ws.readyState === WebSocket.OPEN && wsUrlActive === wsUrl) {
        return;
    }

    // 如果已存在连接但 URL 不同，先断开
    if (ws) {
        closeWs('url_changed');
    }

    logInfo('准备连接 WS：', wsUrl);
    wsUrlActive = wsUrl;
    ws = new WebSocket(wsUrl);
    updateStatusUi();

    ws.addEventListener('open', () => {
        logInfo('WS 已连接');
        updateStatusUi();
        if (typeof toastr !== 'undefined') toastr.success('WS 已连接', 'WS Prompt Injector');
    });

    ws.addEventListener('close', (ev) => {
        logWarn('WS 已关闭：', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        // 清理所有 pending 请求，避免拦截器永久等待
        for (const [requestId, pending] of pendingRequests.entries()) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error(`WS 已关闭（${ev.code} ${ev.reason || ''}）`));
            pendingRequests.delete(requestId);
        }
        updateStatusUi();
    });

    ws.addEventListener('error', (ev) => {
        logError('WS error 事件：', ev);
        updateStatusUi();
    });

    ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        const parsed = parseWsPayload(data);
        logDebug(
            '收到 WS 消息：',
            parsed.requestId
                ? { requestId: parsed.requestId, textPreview: parsed.text?.slice?.(0, 200) }
                : { textPreview: parsed.text?.slice?.(0, 200) },
        );

        if (parsed.requestId && pendingRequests.has(parsed.requestId)) {
            const pending = pendingRequests.get(parsed.requestId);
            pendingRequests.delete(parsed.requestId);
            clearTimeout(pending.timeoutId);
            pending.resolve(parsed.text ?? '');
            return;
        }

        // 如果服务端没返回 requestId，则尝试把消息交给“最早的 pending”
        const first = pendingRequests.entries().next();
        if (!first.done) {
            const [requestId, pending] = first.value;
            pendingRequests.delete(requestId);
            clearTimeout(pending.timeoutId);
            pending.resolve(parsed.text ?? '');
        } else {
            logWarn('收到 WS 消息但没有 pending 请求，已忽略');
        }
    });

    // 等待 open（带超时）
    await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            reject(new Error('连接 WS 超时（5000ms）'));
        }, 5000);
        ws.addEventListener(
            'open',
            () => {
                clearTimeout(timeoutId);
                resolve();
            },
            { once: true },
        );
        ws.addEventListener(
            'close',
            () => {
                clearTimeout(timeoutId);
                reject(new Error('WS 在连接完成前关闭'));
            },
            { once: true },
        );
        ws.addEventListener(
            'error',
            () => {
                // 有些浏览器不会给 error 细节，这里只做兜底
                // close 事件也会触发，所以不一定 reject
            },
            { once: true },
        );
    });
}

async function requestInjectionOverWs(userInput, { type } = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('WS 未连接');
    }

    const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const payload = {
        requestId,
        type: 'user_input',
        generationType: type ?? null,
        user_input: userInput,
        timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);

    logInfo('发送 WS 请求：', { requestId, generationType: type, userInputPreview: userInput.slice(0, 200) });
    ws.send(raw);

    const injectionText = await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error('等待 WS 回包超时（8000ms）'));
        }, 8000);
        pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });

    return injectionText;
}

function findLastUserMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && typeof m === 'object' && m.is_user === true && typeof m.mes === 'string') {
            return { index: i, message: m };
        }
    }
    return null;
}

// 生成前拦截器（在 manifest.json 里通过 generate_interceptor 指定）
globalThis.wsPromptInjectorInterceptor = async function (chat, contextSize, abort, type) {
    try {
        const settings = getSettings();
        if (!settings.enabled) {
            logDebug('拦截器跳过：未启用');
            return;
        }

        if (!settings.wsUrl) {
            if (typeof toastr !== 'undefined') toastr.error('请先在扩展设置里填写 WS 地址', 'WS Prompt Injector');
            logWarn('拦截器跳过：WS 地址为空');
            return;
        }

        const lastUser = findLastUserMessage(chat);
        if (!lastUser) {
            logWarn('拦截器跳过：未找到最后一条用户消息');
            return;
        }

        const userInput = lastUser.message.mes;
        logDebug('拦截器命中：', {
            type,
            contextSize,
            lastUserIndex: lastUser.index,
            userInputPreview: userInput.slice(0, 200),
        });

        try {
            await connectWs(settings.wsUrl);
        } catch (err) {
            const msg = `WS 连接失败：${friendlyError(err)}（将不注入，继续正常生成）`;
            if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
            logError(msg, err);
            return;
        }

        let injection;
        try {
            injection = await requestInjectionOverWs(userInput, { type });
        } catch (err) {
            const msg = `WS 请求失败：${friendlyError(err)}（将不注入，继续正常生成）`;
            if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
            logError(msg, err);
            return;
        }

        // 你已保证服务端回包格式正确：这里原样保留（不 trim），避免误删有效空白/换行
        const clean = typeof injection === 'string' ? injection : String(injection ?? '');
        if (clean.length === 0) {
            logWarn('WS 回包为空字符串：跳过注入');
            return;
        }

        // 重要：按文档建议 clone 被修改的 message，避免把注入写进真实聊天记录
        const cloned = structuredClone(lastUser.message);
        cloned.mes = `${cloned.mes}\n\n${clean}`;
        chat[lastUser.index] = cloned;

        logInfo('已注入到提示词末尾：', { injectedChars: clean.length });
    } catch (err) {
        const msg = `拦截器异常：${friendlyError(err)}（将不注入，继续正常生成）`;
        if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
        logError(msg, err);
        // 不调用 abort：保持“失败不阻断生成”的体验
    }
};

async function initUi() {
    const { saveSettingsDebounced, Popup } = getContextSafe();
    const settings = getSettings();

    const settingsUrl = new URL('settings.html', import.meta.url).toString();
    const html = await jQuery.get(settingsUrl);
    jQuery('#extensions_settings').append(html);

    // 初始化控件值
    jQuery('#ws_prompt_injector_enabled').prop('checked', Boolean(settings.enabled)).trigger('input');
    jQuery('#ws_prompt_injector_url').val(settings.wsUrl ?? '');

    function persist() {
        saveSettingsDebounced();
        updateStatusUi();
    }

    jQuery('#ws_prompt_injector_enabled').on('input', (ev) => {
        settings.enabled = Boolean(jQuery(ev.target).prop('checked'));
        logInfo('设置变更：enabled=', settings.enabled);
        persist();
    });

    jQuery('#ws_prompt_injector_url').on('input', (ev) => {
        settings.wsUrl = String(jQuery(ev.target).val() ?? '').trim();
        logInfo('设置变更：wsUrl=', settings.wsUrl);
        persist();
    });

    jQuery('#ws_prompt_injector_connect').on('click', async () => {
        const url = String(jQuery('#ws_prompt_injector_url').val() ?? '').trim();
        if (!url) {
            if (typeof toastr !== 'undefined') toastr.error('WS 地址不能为空', 'WS Prompt Injector');
            return;
        }
        try {
            await connectWs(url);
        } catch (err) {
            const msg = `连接失败：${friendlyError(err)}`;
            if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
            logError(msg, err);
        } finally {
            updateStatusUi();
        }
    });

    jQuery('#ws_prompt_injector_disconnect').on('click', async () => {
        closeWs('user_disconnect');
        if (typeof toastr !== 'undefined') toastr.info('已断开 WS', 'WS Prompt Injector');
    });

    jQuery('#ws_prompt_injector_test').on('click', async () => {
        const url = String(jQuery('#ws_prompt_injector_url').val() ?? '').trim();
        if (!url) {
            if (typeof toastr !== 'undefined') toastr.error('WS 地址不能为空', 'WS Prompt Injector');
            return;
        }
        try {
            await connectWs(url);
            const ctx = getContextSafe();
            // 尽量取当前输入框，否则退化为最后一条用户消息
            const inputBox = document.getElementById('send_textarea');
            const fromBox = inputBox && 'value' in inputBox ? String(inputBox.value ?? '') : '';
            const lastUser = findLastUserMessage(ctx.chat ?? []);
            const sample = fromBox.length ? fromBox : lastUser?.message?.mes || '';

            if (!sample) {
                if (typeof toastr !== 'undefined') {
                    toastr.warning('没有可用于测试的文本：请先在输入框输入内容', 'WS Prompt Injector');
                }
                return;
            }

            const injection = await requestInjectionOverWs(sample, { type: 'test' });
            const text = typeof injection === 'string' ? injection : String(injection ?? '');
            const shownText = text.length === 0 ? '(空回包)' : text;
            logInfo('测试回包：', { chars: text.length, preview: text.slice(0, 400) });
            if (Popup?.show?.text) {
                await Popup.show.text(
                    'WS Prompt Injector - 测试回包',
                    `<pre style="white-space: pre-wrap;">${shownText.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`,
                );
            } else {
                if (typeof toastr !== 'undefined') toastr.info('测试回包已打印到控制台', 'WS Prompt Injector');
            }
        } catch (err) {
            const msg = `测试失败：${friendlyError(err)}`;
            if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
            logError(msg, err);
        } finally {
            updateStatusUi();
        }
    });

    updateStatusUi();
    logInfo('扩展 UI 初始化完成');

    // 启用时尝试自动连接（失败不弹阻断性弹窗）
    if (settings.enabled && settings.wsUrl) {
        connectWs(settings.wsUrl).catch((err) => {
            logWarn('自动连接失败（可忽略，手动连接即可）：', err);
            updateStatusUi();
        });
    }
}

jQuery(async () => {
    try {
        await initUi();
    } catch (err) {
        const msg = `扩展初始化失败：${friendlyError(err)}`;
        if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
        logError(msg, err);
    }
});
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
