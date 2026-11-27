/**
 * TRPG 通用回合制战斗框架主入口 (index.js) - v1.1
 * 运行环境：纯前端 SillyTavern / TauriTavern（零 Node.js 后端依赖）
 *
 * 职责：
 * 1. 启动时按角色卡加载专属/全局配置与当前聊天的独立战斗进度
 * 2. 挂载 Extensions 侧边栏可视化设置面板与可折叠战斗 HUD
 * 3. 监听 CHAT_CHANGED 事件：切角色卡时自动切换方案与战斗进度，并撤回旧卡注入的提示词
 * 4. 监听 MESSAGE_RECEIVED 事件：解析 AI 回复中的 <combat_event> 掉落/开战标签供 HUD 确认
 */

import { scanLatestAiMessageForEvents } from './src/ai_event_listener.js';
import {
    getSTContext,
    loadBattleState,
    loadConfig,
    saveBattleState,
} from './src/config.js';
import { syncAllUnitsEquipment } from './src/engine.js';
import { initHudUI } from './src/hud_ui.js';
import { clearAllInjectedPrompts, syncThresholdPrompts } from './src/prompt_injector.js';
import { initSettingsUI } from './src/settings_ui.js';

let currentConfig = null;
let currentBattleState = null;
let activePrompts = [];
let hudController = null;
let settingsController = null;

/** 统一同步：装备被动 -> 阈值 Buff & Prompt 注入 -> 保存战斗进度 -> 重绘 HUD */
function syncAllRuntime() {
    syncAllUnitsEquipment(currentBattleState, currentConfig);
    activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);
    saveBattleState(currentBattleState);
    hudController?.render();
}

/** 切换角色卡或切换聊天时：重新加载对应角色卡方案与当前对话战斗进度 */
function handleChatChanged() {
    const applySwitch = async () => {
        currentConfig = await loadConfig();
        currentBattleState = loadBattleState();
        syncAllUnitsEquipment(currentBattleState, currentConfig);
        activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);
        hudController?.clearPendingEvents();
        settingsController?.renderAll();
        hudController?.render();
    };
    applySwitch();
    setTimeout(applySwitch, 140);
}

/** 监听 AI 新回复，提取 <combat_event> 剧情事件 */
function handleMessageReceived() {
    if (!currentConfig?.general?.enabled || !currentConfig?.general?.listenAiEvents) return;
    const events = scanLatestAiMessageForEvents();
    if (events.length > 0) {
        hudController?.pushPendingEvents(events);
    }
}

async function bootstrap() {
    try {
        currentConfig = await loadConfig();
        currentBattleState = loadBattleState();

        syncAllUnitsEquipment(currentBattleState, currentConfig);
        activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);

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
                    syncAllUnitsEquipment(currentBattleState, currentConfig);
                    activePrompts = syncThresholdPrompts(currentBattleState, currentConfig);
                }
                hudController?.render();
            },
        });

        hudController = await initHudUI({
            getConfig: () => currentConfig,
            getBattleState: () => currentBattleState,
            setBattleState: (nextState) => {
                currentBattleState = nextState;
            },
            getActivePrompts: () => activePrompts,
            onStateMutated: syncAllRuntime,
            onConfigMutated: () => {
                settingsController?.renderAll();
            },
            onRequestScanAi: () => {
                const events = scanLatestAiMessageForEvents();
                if (events.length > 0) {
                    hudController?.pushPendingEvents(events);
                }
                return events;
            },
        });

        const ctx = getSTContext();
        if (ctx.eventSource && ctx.event_types) {
            if (ctx.event_types.CHAT_CHANGED) {
                ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, handleChatChanged);
            }
            if (ctx.event_types.MESSAGE_RECEIVED) {
                ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, handleMessageReceived);
            }
        }

        window.STCombatFramework = {
            getConfig: () => currentConfig,
            getBattleState: () => currentBattleState,
            getActivePrompts: () => activePrompts,
            scanAiEvents: () => {
                const events = scanLatestAiMessageForEvents();
                hudController?.pushPendingEvents(events);
                return events;
            },
            refresh: () => {
                settingsController?.renderAll();
                syncAllRuntime();
            },
        };

        console.log('[CombatFramework] TRPG 通用回合制战斗框架 v1.1 已启动。');
    } catch (err) {
        console.error('[CombatFramework] 插件初始化失败:', err);
    }
}

if (typeof window.jQuery === 'function') {
    window.jQuery(() => { bootstrap(); });
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
