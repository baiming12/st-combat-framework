/**
 * TRPG 通用回合制战斗框架主入口 (index.js) - v1.4
 * 运行环境：纯前端 SillyTavern / TauriTavern（零 Node.js 后端依赖）
 *
 * 职责：
 * 1. 按角色卡加载专属/全局配置与当前聊天的独立战斗进度
 * 2. 挂载 Extensions 侧边栏可视化设置面板与可折叠战斗 HUD
 * 3. v1.4 MVU Zod 双向联动：自动读取 stat_data.combat 并把战斗结果轻量写回 MVU（不同步 Buff）
 * 4. 兼容无 MVU 角色卡的 <combat_event> 标签监听
 */

import { scanLatestAiMessageForEvents } from './src/ai_event_listener.js';
import {
    getSTContext,
    loadBattleState,
    loadConfig,
    saveBattleState,
    saveConfig,
} from './src/config.js';
import { syncAllUnitsEquipment } from './src/engine.js';
import { initHudUI } from './src/hud_ui.js';
import { pullFromMvuZod, pushToMvuZod } from './src/mvu_bridge.js';
import { clearAllInjectedPrompts, syncThresholdPrompts } from './src/prompt_injector.js';
import { initSettingsUI } from './src/settings_ui.js';

let currentConfig = null;
let currentBattleState = null;
let activePrompts = [];
let aiContextText = '';
let hudController = null;
let settingsController = null;

/** 刷新阈值 Buff / Prompt 注入、AI 上下文摘要、持久化战斗状态并重绘 HUD */
function refreshRuntimeWithoutPush() {
    syncAllUnitsEquipment(currentBattleState, currentConfig);
    const res = syncThresholdPrompts(currentBattleState, currentConfig);
    activePrompts = res.activeRules;
    aiContextText = res.contextText;
    saveBattleState(currentBattleState);
    hudController?.render();
}

/** 玩家操作导致状态变更：同步运行时并自动写回 MVU Zod (stat_data.combat) */
function syncAllRuntime(options = {}) {
    refreshRuntimeWithoutPush();
    pushToMvuZod(currentConfig, currentBattleState, options).catch(err => {
        console.warn('[CombatFramework] 写回 MVU Zod 失败:', err);
    });
}

/** 从 MVU Zod 拉取最新 stat_data.combat 并同步到插件（不反向写回，避免循环） */
function syncPullFromMvu(showNotice = false) {
    if (!currentConfig?.general?.enabled || !currentConfig?.general?.mvuSyncEnabled) {
        return { found: false, changed: false, events: [], summary: '' };
    }
    const res = pullFromMvuZod(currentConfig, currentBattleState);
    if (res.changed) {
        saveConfig(currentConfig);
        settingsController?.renderAll();
        refreshRuntimeWithoutPush();
    }
    if (res.events.length > 0) {
        hudController?.pushPendingEvents(res.events);
    }
    if (showNotice) {
        hudController?.showToast(res.found ? `🔄 ${res.summary}` : 'ℹ️ 当前角色卡未检测到 MVU stat_data.combat');
    }
    return res;
}

/** 切换角色卡或切换聊天时：重新加载对应角色卡方案、战斗进度并尝试从 MVU 拉取 */
function handleChatChanged() {
    const applySwitch = async () => {
        currentConfig = await loadConfig();
        currentBattleState = loadBattleState();
        hudController?.clearPendingEvents();
        syncPullFromMvu(false);
        refreshRuntimeWithoutPush();
        settingsController?.renderAll();
    };
    applySwitch();
    setTimeout(applySwitch, 180);
}

/** 监听 AI 新回复：同步 <combat_event> 标签并在 MVU 解析完成后拉取最新 stat_data.combat */
function handleMessageReceived() {
    if (!currentConfig?.general?.enabled) return;

    if (currentConfig.general.listenAiEvents) {
        const events = scanLatestAiMessageForEvents();
        if (events.length > 0) {
            hudController?.pushPendingEvents(events);
        }
    }

    if (currentConfig.general.mvuSyncEnabled) {
        // 留出一点时间等待 MVU Zod 扩展完成本楼层变量解析
        setTimeout(() => syncPullFromMvu(false), 450);
    }
}

/** 滑卡(Swipe)或删楼回溯时，自动跟随 MVU 楼层回滚状态 */
function handleFloorRollback() {
    if (!currentConfig?.general?.enabled || !currentConfig?.general?.mvuSyncEnabled) return;
    setTimeout(() => syncPullFromMvu(false), 200);
}

async function bootstrap() {
    try {
        currentConfig = await loadConfig();
        currentBattleState = loadBattleState();

        // 启动时若当前卡片已有 MVU stat_data.combat，先同步一次
        const bootPull = pullFromMvuZod(currentConfig, currentBattleState);
        if (bootPull.changed) {
            saveConfig(currentConfig);
        }

        syncAllUnitsEquipment(currentBattleState, currentConfig);
        const initRes = syncThresholdPrompts(currentBattleState, currentConfig);
        activePrompts = initRes.activeRules;
        aiContextText = initRes.contextText;

        settingsController = await initSettingsUI({
            getConfig: () => currentConfig,
            setConfig: (nextConfig) => {
                currentConfig = nextConfig;
            },
            onConfigChanged: () => {
                if (!currentConfig?.general?.enabled) {
                    clearAllInjectedPrompts();
                    activePrompts = [];
                    aiContextText = '';
                } else {
                    syncAllUnitsEquipment(currentBattleState, currentConfig);
                    const res = syncThresholdPrompts(currentBattleState, currentConfig);
                    activePrompts = res.activeRules;
                    aiContextText = res.contextText;
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
            getAiContextText: () => aiContextText,
            onStateMutated: (opts) => syncAllRuntime(opts),
            onConfigMutated: () => {
                settingsController?.renderAll();
            },
            onRequestScanAi: () => {
                const tagEvents = scanLatestAiMessageForEvents();
                const mvuRes = syncPullFromMvu(false);
                const merged = [...tagEvents, ...(mvuRes.events || [])];
                if (merged.length > 0) {
                    hudController?.pushPendingEvents(merged);
                }
                return merged;
            },
            onRequestSyncMvu: () => syncPullFromMvu(true),
        });

        if (bootPull.events.length > 0) {
            hudController.pushPendingEvents(bootPull.events);
        }

        const ctx = getSTContext();
        if (ctx.eventSource && ctx.event_types) {
            if (ctx.event_types.CHAT_CHANGED) {
                ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, handleChatChanged);
            }
            if (ctx.event_types.MESSAGE_RECEIVED) {
                ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, handleMessageReceived);
            }
            if (ctx.event_types.MESSAGE_SWIPED) {
                ctx.eventSource.on(ctx.event_types.MESSAGE_SWIPED, handleFloorRollback);
            }
            if (ctx.event_types.MESSAGE_DELETED) {
                ctx.eventSource.on(ctx.event_types.MESSAGE_DELETED, handleFloorRollback);
            }
        }

        // 若安装了 MagVarUpdate (MVU) 插件，直接监听其变量更新完成事件，零延迟同步
        try {
            if (typeof window.eventOn === 'function' && window.Mvu?.events?.VARIABLE_UPDATE_ENDED) {
                window.eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED, () => {
                    syncPullFromMvu(false);
                });
            }
        } catch (err) {
            console.warn('[CombatFramework] 绑定 Mvu.events 失败（将使用默认监听）:', err);
        }

        window.STCombatFramework = {
            getConfig: () => currentConfig,
            getBattleState: () => currentBattleState,
            getActivePrompts: () => activePrompts,
            syncFromMvu: () => syncPullFromMvu(true),
            pushToMvu: () => pushToMvuZod(currentConfig, currentBattleState),
            refresh: () => {
                settingsController?.renderAll();
                refreshRuntimeWithoutPush();
            },
        };

        console.log('[CombatFramework] TRPG 通用回合制战斗框架 v1.4 (MVU Zod 联动版) 已启动。');
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
