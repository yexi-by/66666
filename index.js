jQuery(async () => {
    // ===========================
    // 配置部分
    // ===========================
    const extensionName = "sd_image_gen";
    const settingsDivId = "sd_gen_settings";
    const { eventSource, eventTypes, getContext, saveSettingsDebounced } = SillyTavern;

    // 默认设置
    const defaultSettings = {
        apiKey: "",
        apiUrl: "https://sd.exacg.cc/api/v1/generate_image"
    };

    // ===========================
    // 功能函数：注入设置界面
    // ===========================
    function injectSettingsUI() {
        // 1. 如果设置界面已经存在，直接退出，防止重复注入
        if ($(`#${settingsDivId}`).length > 0) return;

        // 2. 找到扩展设置的容器 (酒馆标准ID: #extensions_settings)
        const $settingsContainer = $('#extensions_settings');
        if ($settingsContainer.length === 0) return; // 容器还不存在，跳过

        // 3. 读取当前配置
        let settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);

        // 4. 构建 HTML (样式已分离到 style.css)
        const html = `
            <div id="${settingsDivId}">
                <div class="inline-drawer-header">
                    <b>SD 绘图插件设置</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display:none;">
                    <div class="styled-setting-block">
                        <label>API Authorization Key</label>
                        <input id="sd_input_apikey" class="text_pole" type="password" placeholder="sk-..." value="${settings.apiKey || ''}" />
                    </div>
                    <div class="styled-setting-block">
                        <label>API Endpoint</label>
                        <input id="sd_input_url" class="text_pole" type="text" value="${settings.apiUrl}" />
                    </div>
                </div>
            </div>
        `;

        // 5. 插入到容器末尾
        $settingsContainer.append(html);

        // 6. 绑定事件
        const $drawer = $(`#${settingsDivId}`);
        
        // 折叠/展开
        $drawer.find('.inline-drawer-header').on('click', function() {
            $(this).next('.inline-drawer-content').slideToggle();
            $(this).find('.inline-drawer-icon').toggleClass('down up');
        });

        // 保存设置
        $drawer.find('#sd_input_apikey').on('input', function() {
            settings.apiKey = $(this).val().trim();
            extension_settings[extensionName] = settings;
            saveSettingsDebounced();
        });

        $drawer.find('#sd_input_url').on('input', function() {
            settings.apiUrl = $(this).val().trim();
            extension_settings[extensionName] = settings;
            saveSettingsDebounced();
        });
        
        console.log("[SD Plugin] 设置界面注入成功");
    }

    // ===========================
    // 核心逻辑：监听 DOM 变化 (解决不显示的问题)
    // ===========================
    
    // 这里的逻辑是：监听整个 body，一旦发现 #extensions_settings 出现了，就运行注入函数
    const observer = new MutationObserver((mutations) => {
        // 检查扩展设置容器是否存在
        if (document.getElementById('extensions_settings')) {
            injectSettingsUI();
        }
    });

    // 开始观察 DOM 变化
    observer.observe(document.body, { childList: true, subtree: true });

    // 为了保险，脚本加载时也尝试运行一次
    injectSettingsUI();


    // ===========================
    // 业务逻辑：提取与生成
    // ===========================
    function extractTargetText(text) {
        const match = text.match(/<image>([\s\S]*?)<\/image>/);
        return match ? match[1].trim() : null;
    }

    async function sendDataToServer(content) {
        // 实时读取设置
        const settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
        
        if (!settings.apiKey) {
            toastr.warning("请在扩展设置中填写 API Key");
            return null;
        }

        try {
            const response = await fetch(settings.apiUrl, {
                method: "POST",
                headers: { 
                    "Authorization": `Bearer ${settings.apiKey}`,
                    "Content-Type": "application/json" 
                },
                body: JSON.stringify({ prompt: content })
            });

            const res = await response.json();
            if (res.success && res.data && res.data.image_url) {
                return res.data.image_url;
            } else {
                toastr.error("生成失败: " + (res.message || "未知错误"));
                return null;
            }
        } catch (e) {
            toastr.error("网络请求错误");
            return null;
        }
    }

    // 监听消息并生成按钮
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (data) => {
        const context = getContext();
        const msgId = typeof data === 'number' ? data : (context.chat.length - 1);
        const msg = context.chat[msgId];

        if (msg && !msg.is_user) {
            const extracted = extractTargetText(msg.mes);
            if (extracted) {
                // 等待 UI 渲染
                setTimeout(() => {
                    const $div = $(`.mes[mesid="${msgId}"] .mes_text`);
                    if ($div.length && $div.find('.st-gen-img-btn').length === 0) {
                        const $btn = $(`<button class="st-gen-img-btn">生成图片</button>`);
                        
                        $btn.on('click', async function() {
                            const $me = $(this);
                            $me.prop('disabled', true).text("正在绘图中...");
                            const url = await sendDataToServer(extracted);
                            if (url) {
                                $me.replaceWith(`<img src="${url}" class="st-generated-image" />`);
                            } else {
                                $me.prop('disabled', false).text("生成失败，重试");
                            }
                        });
                        
                        $div.append($btn);
                    }
                }, 100);
            }
        }
    });

    console.log("[SD Plugin] 插件已加载");
});