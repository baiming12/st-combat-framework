/**
 * TRPG 通用回合制战斗框架主入口 (index.js)
 * 运行环境：纯前端 SillyTavern / TauriTavern（零 Node.js 后端依赖）
 *
 * 职责：
 * 1. 启动时加载默认/持久化配置与当前聊天的战斗进度
 * 2. 挂载 Extensions 侧边栏可视化设置面板与可折叠战斗 HUD
 * 3. 监听聊天切换事件（CHAT_CHANGED），自动切换不同对话的战斗进度并重新同步提示词注入
 */

import {
    getSTContext,
    loadBattleState,
    loadConfig,
    saveBattleState,
} from './src/config.js';
import { initHudUI } from './src/hud_ui.js';
import { clearAllInjectedPrompts, syncThresholdPrompts } from './src/prompt_injector.js';
import { initSettingsUI } from './src/settings_ui.js';

/** 运行时内存状态 */
let currentConfig = null;
let currentBattleState = null;
let activePrompts = [];
let hudController = null;
let settingsController = null;

/**
 * 统一同步函数：保存战斗进度 -> 刷新阈值提示词注入 -> 重绘 HUD
 */
function syncAllRuntime() {
    saveBattleState(currentBattleState);
    activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);
    hudController?.render();
}

/**
 * 当用户在酒馆里切换聊天记录时，切换对应的战斗进度并重新计算提示词注入
 */
function handleChatChanged() {
    currentBattleState = loadBattleState();
    activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);
    hudController?.render();
}

/**
 * 插件主启动流程
 */
async function bootstrap() {
    try {
        // 1. 加载配置与当前聊天的战斗进度
        currentConfig = await loadConfig();
        currentBattleState = loadBattleState();

        // 2. 初始化阈值提示词注入
        activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);

        // 3. 挂载 Extensions 侧边栏可视化配置面板
        settingsController = await initSettingsUI({
            getConfig: () => currentConfig,
            setConfig: (nextConfig) => {
                currentConfig = nextConfig;
            },
            onConfigChanged: () => {
                if (!currentConfig?.general?.enabled) {
                    clearAllInjectedPrompts();
                    activePrompts = [];
                } else {
                    activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);
                }
                hudController?.render();
            },
        });

        // 4. 挂载战斗 HUD（默认折叠为迷你浮标）
        hudController = await initHudUI({
            getConfig: () => currentConfig,
            getBattleState: () => currentBattleState,
            setBattleState: (nextState) => {
                currentBattleState = nextState;
            },
            getActivePrompts: () => activePrompts,
            onStateMutated: syncAllRuntime,
        });

        // 5. 监听 SillyTavern / TauriTavern 聊天切换事件
        const ctx = getSTContext();
        if (ctx.eventSource && ctx.event_types?.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, handleChatChanged);
        }

        // 暴露只读调试句柄，便于排查问题
        window.STCombatFramework = {
            getConfig: () => currentConfig,
            getBattleState: () => currentBattleState,
            getActivePrompts: () => activePrompts,
            refresh: () => {
                settingsController?.renderAll();
                syncAllRuntime();
            },
        };

        console.log('[CombatFramework] TRPG 通用回合制战斗框架已启动。');
    } catch (err) {
        console.error('[CombatFramework] 插件初始化失败:', err);
    }
}

// 兼容 SillyTavern 原生 jQuery 启动方式与纯原生 DOMContentLoaded
if (typeof window.jQuery === 'function') {
    window.jQuery(() => {
        bootstrap();
    });
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
