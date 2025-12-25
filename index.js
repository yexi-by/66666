const MODULE_NAME = 'ws_prompt_injector';
const LOG_PREFIX = '[WS Prompt Injector]';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    wsUrl: '',
    // WS 回包注入设置：
    // - role: system | user | assistant
    // - offsetFromBottom: 从底部数的偏移量
    //   0 = 插入到最底部（作为最后一条）
    //   1 = 插入到倒数第 1 条消息之前
    injectionRole: 'system',
    insertionOffsetFromBottom: 0,
});

/** @type {WebSocket | null} */
let ws = null;
/** @type {string | null} */
let wsUrlActive = null;
/** @type {Map<string, {resolve: (v: string) => void, reject: (e: any) => void, timeoutId: number}>} */
const pendingRequests = new Map();

/** @type {Set<string>} */
const ephemeralIds = new Set();

function isEphemeralMessage(m) {
    return Boolean(m && typeof m === 'object' && typeof m.__ws_prompt_injector_ephemeral_id === 'string');
}

function cleanupEphemeralMessages() {
    if (ephemeralIds.size === 0) return 0;
    let removed = 0;
    try {
        const ctx = getContextSafe();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            const id = m?.__ws_prompt_injector_ephemeral_id;
            if (typeof id === 'string' && ephemeralIds.has(id)) {
                chat.splice(i, 1);
                ephemeralIds.delete(id);
                removed++;
            }
        }
    } catch (err) {
        logWarn('清理临时注入消息失败（可忽略）：', err);
    }
    return removed;
}

function coerceInsertionRole(role) {
    if (role === 'system' || role === 'user' || role === 'assistant') return role;
    return 'system';
}

function clampInt(value, { min, max, fallback }) {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

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

    // 仅检测“是否为空”，严禁修改文本内容（包括空格/换行）。
    if (raw.length === 0) return { requestId: null, text: '' };

    // JSON 检测仅用于解析分发 requestId，不影响返回 text 的原始性。
    const maybeJson = raw.trimStart();
    if (maybeJson.startsWith('{') && maybeJson.trimEnd().endsWith('}')) {
        try {
            const obj = JSON.parse(raw);
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
    return { requestId: null, text: raw };
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
        if (isEphemeralMessage(m)) continue;
        if (m && typeof m === 'object' && m.is_user === true && typeof m.mes === 'string') {
            return { index: i, message: m };
        }
    }
    return null;
}

function findLastAssistantMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (isEphemeralMessage(m)) continue;
        if (m && typeof m === 'object' && m.is_user === false && typeof m.mes === 'string') {
            return { index: i, message: m };
        }
    }
    return null;
}

function buildEphemeralMessage({ role, content, chat }) {
    const now = Date.now();
    const id = `${now}_${Math.random().toString(16).slice(2)}`;

    /** @type {{is_user: boolean, name: string, send_date: number, mes: string, __ws_prompt_injector_ephemeral_id: string}} */
    const m = {
        is_user: role === 'user',
        name: role === 'system' ? 'system' : role,
        send_date: now,
        mes: content,
        __ws_prompt_injector_ephemeral_id: id,
    };

    // 尽量沿用当前聊天里已有的 name，避免某些格式器依赖 name。
    if (role === 'user') {
        const lastUser = findLastUserMessage(chat);
        if (lastUser?.message?.name) m.name = lastUser.message.name;
    }
    if (role === 'assistant') {
        const lastAsst = findLastAssistantMessage(chat);
        if (lastAsst?.message?.name) m.name = lastAsst.message.name;
    }

    ephemeralIds.add(id);
    return m;
}

function insertEphemeralMessage(chat, message, offsetFromBottom) {
    const offset = clampInt(offsetFromBottom, { min: 0, max: chat.length, fallback: 0 });
    const index = Math.max(0, Math.min(chat.length, chat.length - offset));
    chat.splice(index, 0, message);
    return index;
}

async function waitForElement(selector, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const $el = jQuery(selector);
        if ($el.length) return $el;
        await new Promise((r) => setTimeout(r, 200));
    }
    return jQuery(selector);
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

        // 先清理可能残留的临时注入（例如异常中断未走到清理逻辑）
        cleanupEphemeralMessages();

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

        // 仅检测空字符串；若不为空，严禁对文本做任何修改（包括 trim/换行拼接）。
        const wsText = typeof injection === 'string' ? injection : String(injection ?? '');
        if (wsText.length === 0) {
            logWarn('WS 回包为空字符串：跳过注入');
            return;
        }

        // 将 WS 回包作为“临时楼层”插入到指定位置（从下往上偏移），并在生成结束后清理。
        const role = coerceInsertionRole(settings.injectionRole);
        const ephemeralMessage = buildEphemeralMessage({ role, content: wsText, chat });
        const insertedAt = insertEphemeralMessage(chat, ephemeralMessage, settings.insertionOffsetFromBottom);

        logInfo('已插入临时注入消息：', {
            role,
            insertedAt,
            injectedChars: wsText.length,
            offsetFromBottom: settings.insertionOffsetFromBottom,
        });
    } catch (err) {
        const msg = `拦截器异常：${friendlyError(err)}（将不注入，继续正常生成）`;
        if (typeof toastr !== 'undefined') toastr.error(msg, 'WS Prompt Injector');
        logError(msg, err);
        // 不调用 abort：保持“失败不阻断生成”的体验
    }
};

async function initUi() {
    const { saveSettingsDebounced, Popup, eventSource, event_types } = getContextSafe();
    const settings = getSettings();

    // Linux/Docker 等环境下，使用 import.meta.url + $.get 可能因为加载方式不同而失败。
    // 这里直接内联设置面板 HTML，确保任何环境都能显示设置项。
    const settingsHtml = `
<div class="ws-prompt-injector-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>WS Prompt Injector</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>

        <div class="inline-drawer-content">
            <div class="ws-prompt-injector_block flex-container">
                <input id="ws_prompt_injector_enabled" type="checkbox" />
                <label for="ws_prompt_injector_enabled">启用：生成前把 user_input 发到 WS，并把回包注入到提示词末尾</label>
            </div>

            <div class="ws-prompt-injector_block flex-container">
                <label for="ws_prompt_injector_url" style="min-width: 70px;">WS 地址</label>
                <input id="ws_prompt_injector_url" class="text_pole" type="text" placeholder="ws://127.0.0.1:8765" />
            </div>

            <div class="ws-prompt-injector_block flex-container">
                <input id="ws_prompt_injector_connect" class="menu_button" type="submit" value="连接" />
                <input id="ws_prompt_injector_disconnect" class="menu_button" type="submit" value="断开" />
                <div id="ws_prompt_injector_status" class="ws-prompt-injector_status"></div>
            </div>

            <div class="ws-prompt-injector_block flex-container">
                <input id="ws_prompt_injector_test" class="menu_button" type="submit" value="发送测试" />
                <span class="ws-prompt-injector_hint">会发送当前输入框内容（或最后一条用户消息）并等待回包</span>
            </div>

            <div class="ws-prompt-injector_block flex-container">
                <label for="ws_prompt_injector_role" style="min-width: 70px;">插入角色</label>
                <select id="ws_prompt_injector_role" class="text_pole">
                    <option value="system">system</option>
                    <option value="user">user</option>
                    <option value="assistant">assistant</option>
                </select>
            </div>

            <div class="ws-prompt-injector_block flex-container">
                <label for="ws_prompt_injector_offset" style="min-width: 70px;">插入位置</label>
                <input id="ws_prompt_injector_offset" class="text_pole" type="number" min="0" step="1" />
                <span class="ws-prompt-injector_hint">从底部偏移：0=最底部(最后一条)，1=倒数第1条之前</span>
            </div>

            <hr class="sysHR" />
        </div>
    </div>
</div>
`;

    const $settingsRoot = await waitForElement('#extensions_settings', 10000);
    if (!$settingsRoot.length) {
        throw new Error('未找到 #extensions_settings：扩展设置页尚未加载完成');
    }
    // 避免重复插入（热重载/重复初始化场景）
    if ($settingsRoot.find('#ws_prompt_injector_enabled').length === 0) {
        $settingsRoot.append(settingsHtml);
    }

    // 初始化控件值
    jQuery('#ws_prompt_injector_enabled').prop('checked', Boolean(settings.enabled)).trigger('input');
    jQuery('#ws_prompt_injector_url').val(settings.wsUrl ?? '');
    jQuery('#ws_prompt_injector_role').val(coerceInsertionRole(settings.injectionRole));
    jQuery('#ws_prompt_injector_offset').val(String(clampInt(settings.insertionOffsetFromBottom, { min: 0, max: 9999, fallback: 0 })));

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

    jQuery('#ws_prompt_injector_role').on('change', (ev) => {
        settings.injectionRole = coerceInsertionRole(String(jQuery(ev.target).val() ?? 'system'));
        logInfo('设置变更：injectionRole=', settings.injectionRole);
        persist();
    });

    jQuery('#ws_prompt_injector_offset').on('input', (ev) => {
        settings.insertionOffsetFromBottom = clampInt(jQuery(ev.target).val(), { min: 0, max: 9999, fallback: 0 });
        logInfo('设置变更：insertionOffsetFromBottom=', settings.insertionOffsetFromBottom);
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

    // 生成完成/停止后，立即清理临时注入内容，确保不计入后续上下文。
    if (eventSource && event_types) {
        const tryCleanup = (reason) => {
            const removed = cleanupEphemeralMessages();
            if (removed > 0) logDebug(`已清理临时注入消息：reason=${reason}`, { removed });
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, () => tryCleanup('MESSAGE_RECEIVED'));
        eventSource.on(event_types.GENERATION_ENDED, () => tryCleanup('GENERATION_ENDED'));
        eventSource.on(event_types.GENERATION_STOPPED, () => tryCleanup('GENERATION_STOPPED'));
        eventSource.on(event_types.CHAT_CHANGED, () => tryCleanup('CHAT_CHANGED'));
    }

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
