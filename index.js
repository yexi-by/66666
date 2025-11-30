jQuery(async () => {
    // ==========================================
    // 1. 初始化变量
    // ==========================================
    const extensionName = "sd_image_gen"; 
    const extensionSettingsDivId = "sd_gen_settings"; // 给我们的设置块起个ID，防止重复
    const { eventSource, eventTypes, getContext, saveSettingsDebounced } = SillyTavern;
    
    // 默认设置
    const defaultSettings = {
        apiKey: "",
        apiUrl: "https://sd.exacg.cc/api/v1/generate_image"
    };

    // ==========================================
    // 2. 稳健的 UI 渲染逻辑 (修复不显示的问题)
    // ==========================================
    function renderExtensionUI() {
        // 检查点 1: 酒馆的扩展设置主容器是否存在？如果还没加载出来，就跳过
        if ($('#extensions_settings').length === 0) return;

        // 检查点 2: 我们的设置界面是不是已经画好了？如果有了，就别再画了
        if ($(`#${extensionSettingsDivId}`).length > 0) return;

        // 获取当前设置
        let settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);

        // 定义 HTML
        const settingsHtml = `
        <div id="${extensionSettingsDivId}" class="inline-drawer">
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
            </div>
        </div>
        `;

        // 插入 HTML
        $('#extensions_settings').append(settingsHtml);

        // 重新绑定事件 (因为是新生成的 DOM)
        // 1. 折叠/展开
        $(`#${extensionSettingsDivId} .inline-drawer-header`).on('click', function() {
            const content = $(this).next('.inline-drawer-content');
            const icon = $(this).find('.inline-drawer-icon');
            content.slideToggle();
            icon.toggleClass('down').toggleClass('up');
        });

        // 2. 监听输入保存
        $('#sd_input_apikey').on('input', function() {
            const currentSettings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
            currentSettings.apiKey = $(this).val().trim();
            extension_settings[extensionName] = currentSettings;
            saveSettingsDebounced();
        });

        $('#sd_input_url').on('input', function() {
            const currentSettings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
            currentSettings.apiUrl = $(this).val().trim();
            extension_settings[extensionName] = currentSettings;
            saveSettingsDebounced();
        });
        
        console.log("SD插件设置界面注入成功！");
    }

    // 【关键修改】：不再只运行一次，而是每2秒检查一次
    // 这样能确保无论什么时候加载，设置界面都会出现
    setInterval(renderExtensionUI, 2000);


    // ==========================================
    // 3. 核心业务逻辑 (保持不变)
    // ==========================================
    function extractTargetText(text) {
        const match = text.match(/<image>([\s\S]*?)<\/image>/);
        return match ? match[1].trim() : null;
    }

    async function sendDataToServer(content) {
        // 每次发送时实时读取最新设置
        const currentSettings = Object.assign({}, defaultSettings, extension_settings[extensionName]);

        if (!currentSettings.apiKey) {
            toastr.warning("请先在扩展设置中填写 API Key");
            return null;
        }

        try {
            const response = await fetch(currentSettings.apiUrl, {
                method: "POST",
                headers: { 
                    "Authorization": `Bearer ${currentSettings.apiKey}`,
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
            toastr.error("网络请求错误");
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
    // 4. 监听消息
    // ==========================================
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

    console.log("SD 绘图插件（稳健版）已加载");
});