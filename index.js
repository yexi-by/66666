jQuery(async () => {
    // ==========================================
    // 1. 初始化与设置管理 (Settings & Init)
    // ==========================================
    const extensionName = "sd_image_gen"; // 唯一的插件ID，用于存储设置
    const { eventSource, eventTypes, getContext, saveSettingsDebounced } = SillyTavern;
    
    // 默认设置
    const defaultSettings = {
        apiKey: "",
        apiUrl: "https://sd.exacg.cc/api/v1/generate_image" // 允许用户也可以改 URL
    };

    // 加载设置：如果全局设置里没有，就用默认的
    let settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);

    // 更新并保存设置的辅助函数
    function updateSettings() {
        extension_settings[extensionName] = settings;
        // 调用酒馆内置的保存函数 (防抖保存，防止频繁读写)
        saveSettingsDebounced();
    }

    // ==========================================
    // 2. 构建 UI 界面 (Inject UI)
    // ==========================================
    function renderExtensionUI() {
        // 定义设置面板的 HTML
        // 使用了酒馆原生的 CSS 类名 (inline-drawer, text_pole 等) 保持风格一致
        const settingsHtml = `
        <div id="sd_gen_settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SD 绘图插件设置</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display:none;">
                <div class="styled-setting-block">
                    <div class="sidebar-help" title="输入你的 API Key">API Authorization Key</div>
                    <label>API Key (Bearer Token)</label>
                    <input id="sd_input_apikey" class="text_pole" type="password" placeholder="sk-xxxxxx" value="${settings.apiKey || ''}" />
                </div>
                
                <div class="styled-setting-block">
                    <div class="sidebar-help" title="后端接口地址">API URL</div>
                    <label>API Endpoint</label>
                    <input id="sd_input_url" class="text_pole" type="text" value="${settings.apiUrl}" />
                </div>
                
                <div style="margin-top:10px; opacity:0.7; font-size:0.8em;">
                    设置会自动保存。
                </div>
            </div>
        </div>
        `;

        // 将 HTML 插入到酒馆的扩展设置区域
        // 注意：酒馆的扩展设置容器 ID 通常是 #extensions_settings
        $('#extensions_settings').append(settingsHtml);

        // 绑定折叠/展开点击事件
        $('#sd_gen_settings .inline-drawer-header').on('click', function() {
            const content = $(this).next('.inline-drawer-content');
            const icon = $(this).find('.inline-drawer-icon');
            content.slideToggle();
            icon.toggleClass('down').toggleClass('up'); // 切换箭头方向
        });

        // 绑定输入框变化事件 (自动保存)
        $('#sd_input_apikey').on('input', function() {
            settings.apiKey = $(this).val().trim();
            updateSettings();
        });

        $('#sd_input_url').on('input', function() {
            settings.apiUrl = $(this).val().trim();
            updateSettings();
        });
    }

    // ==========================================
    // 3. 核心业务逻辑 (Core Logic)
    // ==========================================
    
    function extractTargetText(text) {
        const match = text.match(/<image>([\s\S]*?)<\/image>/);
        return match ? match[1].trim() : null;
    }

    async function sendDataToServer(content) {
        // 【关键点】这里直接使用 settings.apiUrl 和 settings.apiKey
        if (!settings.apiKey) {
            toastr.warning("请先在扩展设置中填写 API Key");
            return null;
        }

        try {
            const response = await fetch(settings.apiUrl, {
                method: "POST",
                headers: { 
                    // 动态调用 Key
                    "Authorization": `Bearer ${settings.apiKey}`,
                    "Content-Type": "application/json" 
                },
                body: JSON.stringify({ prompt: content })
            });

            const resJson = await response.json();

            if (resJson.success && resJson.data && resJson.data.image_url) {
                return resJson.data.image_url;
            } else {
                console.error("API Error:", resJson);
                toastr.error("生成失败: " + (resJson.message || "未知错误"));
                return null;
            }
        } catch (error) {
            console.error("Network Error:", error);
            toastr.error("网络请求错误，请检查控制台");
            return null;
        }
    }

    function injectGenerateButton($messageBody, promptContent) {
        if ($messageBody.find('.st-gen-img-btn').length > 0) return;

        const $btn = $(`<button class="st-gen-img-btn menu_button">生成图片</button>`);
        $btn.css({
            "display": "block", "margin-top": "10px", "width": "100%", "cursor": "pointer"
        });

        $btn.on('click', async function() {
            const $thisBtn = $(this);
            $thisBtn.prop('disabled', true).text("正在绘图中...");
            
            const imageUrl = await sendDataToServer(promptContent);

            if (imageUrl) {
                const $img = $(`<img src="${imageUrl}" class="st-generated-image" />`);
                $img.css({
                    "display": "block", "margin-top": "10px", 
                    "max-width": "100%", "border-radius": "8px"
                });
                $thisBtn.replaceWith($img);
            } else {
                $thisBtn.prop('disabled', false).text("生成失败，点击重试");
            }
        });

        $messageBody.append($btn);
    }

    // ==========================================
    // 4. 监听与启动 (Listeners)
    // ==========================================

    // 监听消息接收
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (data) => {
        const context = getContext();
        const messageId = typeof data === 'number' ? data : (context.chat.length - 1);
        const targetMessage = context.chat[messageId];

        if (targetMessage && !targetMessage.is_user) {
            const extracted = extractTargetText(targetMessage.mes);
            if (extracted) {
                setTimeout(() => {
                    const $targetDiv = $(`.mes[mesid="${messageId}"] .mes_text`);
                    if ($targetDiv.length) {
                        injectGenerateButton($targetDiv, extracted);
                    }
                }, 50);
            }
        }
    });

    // 插件加载完成时渲染 UI
    renderExtensionUI();
    console.log("SD 绘图插件 (带设置界面版) 已加载");
});