/**
 * 战斗 HUD 悬浮面板交互模块 (src/hud_ui.js) - v1.1
 * 职责：
 * 1. 默认折叠为迷你可拖拽浮标，适配 TauriTavern 窄屏防遮挡
 * 2. 渲染 1v1 ~ 4v4 战场卡片（血条、蓝条、双特殊槽、Buff 徽章含装备常驻/阈值触发标识）
 * 3. 操作区支持「技能 / 道具 / 装备」三标签切换：战斗中可放技能、用道具、实时穿脱装备
 * 4. 显示 AI 剧情事件（<combat_event>）一键确认条：获得装备/道具/触发开战均由用户点击确认
 * 5. 战报仅支持“填入输入框（绝不自动发送）”或“复制到剪贴板”
 */

import { MAX_UNITS_PER_SIDE, getGaugeEntries, saveConfig } from './config.js';
import { applyMvuVitalsOnBattleStart } from './mvu_bridge.js';
import {
    addEnemyToBattle,
    adjustUnitStatManual,
    allocateStatPoint,
    applyExternalStatusToUnit,
    changeUnitClass,
    checkSkillPrerequisite,
    createBattleState,
    endPlayerTurn,
    equipItemOnUnit,
    executeAllyAction,
    executeDefendWaitAction,
    executeStruggleAction,
    executeUseItem,
    findClassById,
    findEquipmentById,
    findItemById,
    findSkillById,
    findStatusDefById,
    findUnitById,
    formatCombatLogOutput,
    formatEnemyIntentSummary,
    getEffectiveStats,
    getSkillRemainingCooldown,
    getUnitAvailableSkills,
    getUnitStrugglePreview,
    grantSkillToUnit,
    isAlive,
    isUnitRestrained,
    isWorldviewEnabled,
    levelUpUnit,
    parseRestraintObjectTargetId,
    resetUnitAllocatedPoints,
    unequipItemFromUnit,
} from './engine.js';

const PHASE_LABELS = {
    idle: '待机',
    player_turn: '我方回合',
    enemy_turn: '敌方回合',
    victory: '战斗胜利',
    defeat: '战斗失败',
};

const TARGET_TYPE_BADGES = {
    single_enemy: '单敌',
    all_enemies: '群敌',
    self: '自身',
    single_ally: '单友',
    all_allies: '群友',
};

const SLOT_LABELS = {
    weapon: '武器',
    head: '头部',
    body: '防具',
    accessory: '饰品',
};

function escapeHtml(str) {
    return String(str ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function copyTextSafe(text) {
    if (!text) return false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fallback below
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

function fillChatInputWithoutSending(text, strategy = 'append') {
    if (!text) return false;
    const textarea = document.getElementById('send_textarea');
    if (!textarea) return false;

    const existing = textarea.value || '';
    if (strategy === 'replace' || !existing.trim()) {
        textarea.value = text;
    } else {
        textarea.value = `${existing.replace(/\s+$/, '')}\n\n${text}`;
    }

    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

/** 格式化装备的属性与 Buff 简短摘要 */
function formatEquipBonusSummary(eq, config) {
    const parts = [];
    if (eq.bonusHp) parts.push(`HP${eq.bonusHp > 0 ? '+' : ''}${eq.bonusHp}`);
    if (eq.bonusMp) parts.push(`MP${eq.bonusMp > 0 ? '+' : ''}${eq.bonusMp}`);
    if (eq.bonusAtk) parts.push(`攻${eq.bonusAtk > 0 ? '+' : ''}${eq.bonusAtk}`);
    if (eq.bonusSpi) parts.push(`精${eq.bonusSpi > 0 ? '+' : ''}${eq.bonusSpi}`);
    if (eq.bonusDef) parts.push(`防${eq.bonusDef > 0 ? '+' : ''}${eq.bonusDef}`);
    if (eq.bonusMdef) parts.push(`抗${eq.bonusMdef > 0 ? '+' : ''}${eq.bonusMdef}`);
    const pIds = Array.isArray(eq.passiveStatusIds) ? eq.passiveStatusIds : (eq.passiveStatusId ? [eq.passiveStatusId] : []);
    if (pIds.length > 0) {
        const names = pIds.map(id => findStatusDefById(config, id)?.name).filter(Boolean);
        if (names.length) parts.push(`常驻:${names.join('/')}`);
    }
    const gIds = Array.isArray(eq.grantSkillIds) ? eq.grantSkillIds : (eq.grantSkillId ? [eq.grantSkillId] : []);
    if (gIds.length > 0) {
        const names = gIds.map(id => (config.skills || []).find(s => s.id === id)?.name).filter(Boolean);
        if (names.length) parts.push(`附技:${names.join('/')}`);
    }
    return parts.join(' ') || '无额外加成';
}

export async function initHudUI(deps) {
    const oldRoot = document.getElementById('stcf-hud-root');
    if (oldRoot) oldRoot.remove();

    const htmlUrl = new URL('../hud.html', import.meta.url);
    const resp = await fetch(htmlUrl);
    if (!resp.ok) throw new Error(`无法加载 hud.html (${resp.status})`);
    const html = await resp.text();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    const root = wrapper.firstElementChild;
    document.body.appendChild(root);

    let gmMode = false;
    let actionTab = 'skills'; // 'skills' | 'items' | 'equip'
    let toastTimer = null;
    let isCollapsed = deps.getConfig()?.general?.hudStartCollapsed !== false;
    let pendingEvents = [];

    const elPill = root.querySelector('#stcf-collapsed-pill');
    const elPillBadge = root.querySelector('#stcf-pill-badge');
    const elHeader = root.querySelector('#stcf-hud-header');
    const elPhaseBadge = root.querySelector('#stcf-phase-badge');
    const elTurnBadge = root.querySelector('#stcf-turn-badge');
    const elBtnSyncMvu = root.querySelector('#stcf-btn-sync-mvu');
    const elBtnAuthoring = root.querySelector('#stcf-btn-authoring-mode');
    const elBtnAiContext = root.querySelector('#stcf-btn-ai-context');
    const elContextBox = root.querySelector('#stcf-context-box');
    const elContextChars = root.querySelector('#stcf-context-chars');
    const elContextText = root.querySelector('#stcf-context-text');
    const elBtnScanAi = root.querySelector('#stcf-btn-scan-ai');
    const elBtnGm = root.querySelector('#stcf-btn-gm-mode');
    const elBtnStartReset = root.querySelector('#stcf-btn-start-reset');
    const elBtnCollapse = root.querySelector('#stcf-btn-collapse');
    const elEventBar = root.querySelector('#stcf-event-bar');
    const elPromptBar = root.querySelector('#stcf-prompt-bar');
    const elPromptBarToggle = root.querySelector('#stcf-prompt-bar-toggle');
    const elPromptCount = root.querySelector('#stcf-prompt-count');
    const elPromptPreview = root.querySelector('#stcf-prompt-preview');
    const elIdle = root.querySelector('#stcf-idle-placeholder');
    const elBattleArea = root.querySelector('#stcf-battle-area');
    const elBattlefield = root.querySelector('#stcf-battlefield');
    const elAlliesList = root.querySelector('#stcf-allies-list');
    const elEnemiesList = root.querySelector('#stcf-enemies-list');
    const elActorName = root.querySelector('#stcf-current-actor-name');
    const elTargetName = root.querySelector('#stcf-current-target-name');
    const elSkillsBar = root.querySelector('#stcf-skills-bar');
    const elItemsBar = root.querySelector('#stcf-items-bar');
    const elEquipBar = root.querySelector('#stcf-equip-bar');
    const elGrowthBar = root.querySelector('#stcf-growth-bar');
    const elTabGrowth = root.querySelector('#stcf-tab-growth');
    const elBtnEndTurn = root.querySelector('#stcf-btn-end-turn');
    const elBtnCopyLog = root.querySelector('#stcf-btn-copy-log');
    const elBtnFillInput = root.querySelector('#stcf-btn-fill-input');
    const elBtnFinishBattle = root.querySelector('#stcf-btn-finish-battle');
    const elBtnClearRoundLog = root.querySelector('#stcf-btn-clear-round-log');
    const elLogList = root.querySelector('#stcf-log-list');
    const elToast = root.querySelector('#stcf-toast');

    function showToast(msg) {
        if (!elToast) return;
        elToast.textContent = msg;
        elToast.classList.remove('stcf-hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => elToast.classList.add('stcf-hidden'), 2400);
    }

    function setCollapsed(nextCollapsed) {
        isCollapsed = Boolean(nextCollapsed);
        root.classList.toggle('stcf-collapsed', isCollapsed);
        clampRootIntoViewport();
    }

    function clampRootIntoViewport() {
        const rect = root.getBoundingClientRect();
        if (!root.style.left && !root.style.top) return;
        const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
        const curLeft = parseFloat(root.style.left) || 0;
        const curTop = parseFloat(root.style.top) || 0;
        root.style.left = `${Math.min(maxLeft, Math.max(8, curLeft))}px`;
        root.style.top = `${Math.min(maxTop, Math.max(8, curTop))}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
    }

    function setupDraggable(handleEl, isPillHandle = false) {
        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let origLeft = 0;
        let origTop = 0;

        handleEl.addEventListener('pointerdown', (e) => {
            if (!isPillHandle && e.target.closest('button')) return;
            dragging = true;
            moved = false;
            const rect = root.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            origLeft = rect.left;
            origTop = rect.top;
            handleEl.setPointerCapture?.(e.pointerId);
        });

        handleEl.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!moved && Math.hypot(dx, dy) > 5) moved = true;
            if (moved) {
                root.style.left = `${origLeft + dx}px`;
                root.style.top = `${origTop + dy}px`;
                root.style.right = 'auto';
                root.style.bottom = 'auto';
                clampRootIntoViewport();
            }
        });

        handleEl.addEventListener('pointerup', () => {
            if (dragging && isPillHandle && !moved) setCollapsed(false);
            dragging = false;
        });

        handleEl.addEventListener('pointercancel', () => { dragging = false; });
    }

    setupDraggable(elPill, true);
    setupDraggable(elHeader, false);
    window.addEventListener('resize', clampRootIntoViewport);

    async function dispatchNewLogs(newLogs) {
        if (!Array.isArray(newLogs) || newLogs.length === 0) return;
        const config = deps.getConfig();
        const state = deps.getBattleState();
        const mode = config?.general?.outputMode || 'fill_input';
        if (mode === 'manual') return;

        const text = formatCombatLogOutput(state, config, newLogs);
        if (!text) return;

        if (mode === 'clipboard') {
            const ok = await copyTextSafe(text);
            showToast(ok ? '📋 战报已自动复制到剪贴板' : '⚠️ 剪贴板写入受限，请点复制按钮');
        } else if (mode === 'fill_input') {
            const ok = fillChatInputWithoutSending(text, config.general?.inputFillStrategy || 'append');
            showToast(ok ? '✏️ 战报已填入输入框（未发送）' : '⚠️ 未找到聊天输入框，请使用复制按钮');
        }
    }

    elBtnCollapse.addEventListener('click', () => setCollapsed(true));

    elBtnGm.addEventListener('click', () => {
        gmMode = !gmMode;
        elBtnGm.classList.toggle('active', gmMode);
        showToast(gmMode ? '🛠️ 已开启手动数值微调' : '🛠️ 已关闭手动数值微调');
        render();
    });

    elBtnSyncMvu.addEventListener('click', () => {
        deps.onRequestSyncMvu?.();
    });

    elBtnAuthoring?.addEventListener('click', () => {
        const cfg = deps.getConfig();
        if (!cfg?.general) return;
        cfg.general.authoringMode = !cfg.general.authoringMode;
        saveConfig(cfg);
        deps.onConfigMutated?.();
        deps.onStateMutated();
        showToast(cfg.general.authoringMode
            ? '✍️ 创作模式已开启：AI 现可看见完整技能/状态/装备/规则配置'
            : '🎮 创作模式已关闭，切回日常省 Token 模式');
    });

    elBtnAiContext.addEventListener('click', () => {
        const isHidden = elContextBox.classList.toggle('stcf-hidden');
        elBtnAiContext.classList.toggle('active', !isHidden);
        render();
    });

    elBtnScanAi.addEventListener('click', () => {
        const found = deps.onRequestScanAi?.() || [];
        if (found.length === 0) {
            showToast('🔍 最新 AI 回复中未检测到 <combat_event> 标签');
        } else {
            showToast(`🎁 检测到 ${found.length} 条剧情联动事件，请点击确认`);
        }
    });

    elPromptBarToggle.addEventListener('click', () => {
        elPromptPreview.classList.toggle('stcf-hidden');
    });

    root.querySelectorAll('.stcf-mobile-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            root.querySelectorAll('.stcf-mobile-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            elBattlefield.dataset.view = btn.dataset.side || 'both';
        });
    });

    // 切换操作标签：技能 / 道具 / 装备 / 成长职业
    root.querySelectorAll('.stcf-action-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            actionTab = btn.dataset.actionTab || 'skills';
            root.querySelectorAll('.stcf-action-tab').forEach(b => b.classList.toggle('active', b === btn));
            elSkillsBar.classList.toggle('stcf-hidden', actionTab !== 'skills');
            elItemsBar.classList.toggle('stcf-hidden', actionTab !== 'items');
            elEquipBar.classList.toggle('stcf-hidden', actionTab !== 'equip');
            elGrowthBar.classList.toggle('stcf-hidden', actionTab !== 'growth');
            render();
        });
    });

    elBtnStartReset.addEventListener('click', () => {
        const cur = deps.getBattleState();
        if (cur && cur.active) {
            if (!window.confirm('确定要按当前设置重新开始战斗吗？当前血量和回合进度将被重置。')) return;
        }
        const cfg = deps.getConfig();
        const nextState = createBattleState(cfg);
        applyMvuVitalsOnBattleStart(nextState, cfg);
        deps.setBattleState(nextState);
        deps.onStateMutated();
        showToast('⚔️ 已开启新战斗');
    });

    elBtnEndTurn.addEventListener('click', async () => {
        const res = endPlayerTurn(deps.getBattleState(), deps.getConfig());
        if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
        deps.onStateMutated();
        await dispatchNewLogs(res.newLogs);
    });

    elBtnCopyLog.addEventListener('click', async () => {
        const text = formatCombatLogOutput(deps.getBattleState(), deps.getConfig());
        if (!text) { showToast('本回合暂无战报可复制'); return; }
        const ok = await copyTextSafe(text);
        showToast(ok ? '📋 已复制本回合完整战报' : '⚠️ 复制失败，请检查权限');
    });

    elBtnFillInput.addEventListener('click', () => {
        const config = deps.getConfig();
        const text = formatCombatLogOutput(deps.getBattleState(), config);
        if (!text) { showToast('本回合暂无战报可填入'); return; }
        const ok = fillChatInputWithoutSending(text, config.general?.inputFillStrategy || 'append');
        showToast(ok ? '✏️ 已将战报填入输入框（未发送）' : '⚠️ 未找到聊天输入框');
    });

    elBtnFinishBattle?.addEventListener('click', () => {
        const state = deps.getBattleState();
        if (!state || !state.active) return;
        const finished = state.phase === 'victory' || state.phase === 'defeat';
        if (!finished && !window.confirm('当前战斗尚未结束，确定要撤退/结束战斗并返回日常待机状态吗？')) {
            return;
        }
        deps.setBattleState(null);
        deps.onStateMutated();
        showToast('🏁 战斗已结束，已切回日常待机并同步状态');
    });

    elBtnClearRoundLog.addEventListener('click', () => {
        const state = deps.getBattleState();
        if (!state) return;
        state.currentRoundLogs = [];
        deps.onStateMutated();
        showToast('已清空本轮战报缓存');
    });

    /** 解析事件中的敌人列表（优先按 ID 查敌人图鉴，兼容临时自创敌人） */
    function resolveEventEnemies(ev, config) {
        const list = [];
        for (const eid of ev.enemyIds || []) {
            const tpl = (config.enemies || []).find(e => e.id === eid);
            if (tpl) list.push({ ...tpl, enabled: true });
        }
        for (const custom of ev.enemies || []) {
            list.push(custom);
        }
        return list.slice(0, MAX_UNITS_PER_SIDE);
    }

    /** 将事件附带的自定义状态与技能先入库（例如地下城新装备自带的新 Buff/技能） */
    function registerBundledDeps(ev, config) {
        for (const st of ev.bundledStatuses || []) {
            if (!st?.id) continue;
            const idx = (config.statuses || []).findIndex(x => x.id === st.id);
            if (idx >= 0) config.statuses[idx] = { ...config.statuses[idx], ...st };
            else config.statuses.push(st);
        }
        for (const sk of ev.bundledSkills || []) {
            if (!sk?.id) continue;
            const idx = (config.skills || []).findIndex(x => x.id === sk.id);
            if (idx >= 0) config.skills[idx] = { ...config.skills[idx], ...sk };
            else config.skills.push(sk);
        }
    }

    /** 渲染 AI 剧情事件一键确认条（v2.0 支持 8 类事件 + 地下城批量掉落包 + 一键全收） */
    function renderPendingEvents() {
        const config = deps.getConfig();
        if (!pendingEvents.length) {
            elEventBar.classList.add('stcf-hidden');
            elEventBar.innerHTML = '';
            return;
        }
        elEventBar.classList.remove('stcf-hidden');
        const batchHeader = pendingEvents.length >= 2 ? `
            <div class="stcf-event-item" style="border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:6px;margin-bottom:4px;">
                <div class="stcf-event-desc">📦 共检测到 <strong>${pendingEvents.length}</strong> 条剧情联动事件</div>
                <div class="stcf-event-actions">
                    <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-batch="accept_all_loot">✅ 一键全部收录</button>
                    <button type="button" class="stcf-btn stcf-btn-sm" data-ev-batch="dismiss_all">✖ 全部忽略</button>
                </div>
            </div>
        ` : '';

        elEventBar.innerHTML = batchHeader + pendingEvents.map(ev => {
            if (ev.type === 'loot_equipment') {
                const eq = (ev.equipId && findEquipmentById(config, ev.equipId)) || ev.equipment;
                if (!eq) return '';
                const slotName = SLOT_LABELS[eq.slot] || eq.slot;
                const summary = formatEquipBonusSummary(eq, config);
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">🎁 剧情获得装备 <strong>【${escapeHtml(eq.name)}】</strong>(${slotName} · ${escapeHtml(summary)})</div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-act="equip_now">收录并装备</button>
                            <button type="button" class="stcf-btn stcf-btn-secondary stcf-btn-sm" data-ev-act="store_only">仅收入库</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'loot_item') {
                const libItem = ev.itemId ? findItemById(config, ev.itemId) : null;
                const it = libItem ? { ...libItem, quantity: ev.quantity || 1 } : ev.item;
                if (!it) return '';
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">${escapeHtml(it.icon || '🎒')} 剧情获得道具 <strong>【${escapeHtml(it.name)} ×${it.quantity}】</strong></div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-act="accept_item">收入背包</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'loot_bundle') {
                const parts = [];
                for (const eEntry of ev.equips || []) {
                    const eq = (eEntry.equipId && findEquipmentById(config, eEntry.equipId)) || eEntry.equipment;
                    if (eq) parts.push(`🛡️${eq.name}`);
                }
                for (const iEntry of ev.items || []) {
                    const libIt = iEntry.itemId ? findItemById(config, iEntry.itemId) : null;
                    const it = libIt || iEntry.item;
                    if (it) parts.push(`${it.icon || '🎒'}${it.name}×${iEntry.quantity || 1}`);
                }
                for (const sEntry of ev.grantSkills || []) {
                    const sk = (sEntry.skillId && findSkillById(config, sEntry.skillId)) || sEntry.skill;
                    if (sk) parts.push(`✨${sk.name}`);
                }
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">💎 <strong>【${escapeHtml(ev.title || '战利品包')}】</strong>：${escapeHtml(parts.join('、') || '附带配置数据')}</div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-act="accept_bundle">一键收入库</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'grant_skill') {
                const sk = (ev.skillId && findSkillById(config, ev.skillId)) || ev.skill;
                if (!sk) return '';
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">✨ 剧情领悟技能 <strong>【${escapeHtml(sk.name)}】</strong>${sk.description ? `（${escapeHtml(sk.description)}）` : ''}</div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-act="accept_skill">学会该技能</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'grant_status') {
                const st = (ev.statusId && findStatusDefById(config, ev.statusId)) || ev.status;
                if (!st) return '';
                const verb = ev.remove ? '解除状态' : '附加状态';
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">${escapeHtml(st.icon || '✨')} 剧情${verb} <strong>【${escapeHtml(st.name)}】</strong>${ev.turns ? `(${ev.turns}回合)` : ''}</div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-act="accept_status">确认生效</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'level_up') {
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">⬆️ <strong>${escapeHtml(ev.reason || '剧情修炼突破')}</strong>：提升 <strong>+${ev.levels || 1} 级</strong>（自动发放自由属性点）</div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-ev-act="accept_level_up">确认突破</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'start_combat') {
                const resolved = resolveEventEnemies(ev, config);
                const names = resolved.map(e => `${e.name}(HP:${e.maxHp})`).join('、') || '默认敌方';
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">⚔️ 剧情遭遇敌人：<strong>${escapeHtml(names)}</strong></div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-warn stcf-btn-sm" data-ev-act="accept_combat">一键开战</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            if (ev.type === 'add_enemy') {
                const resolved = resolveEventEnemies(ev, config);
                const names = resolved.map(e => `${e.name}(HP:${e.maxHp})`).join('、');
                if (!names) return '';
                return `
                    <div class="stcf-event-item" data-ev-uid="${escapeHtml(ev.uid)}">
                        <div class="stcf-event-desc">🚨 战斗中敌方增援：<strong>${escapeHtml(names)}</strong></div>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-warn stcf-btn-sm" data-ev-act="accept_add_enemy">塞入当前战场</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-ev-act="dismiss">忽略</button>
                        </div>
                    </div>
                `;
            }
            return '';
        }).join('');
    }

    function applySingleLootOrGrowthEvent(ev, act, config, state) {
        registerBundledDeps(ev, config);

        if (ev.type === 'loot_equipment') {
            const libEq = ev.equipId ? findEquipmentById(config, ev.equipId) : null;
            const eq = libEq || ev.equipment;
            if (!eq) return '';
            let finalId = eq.id;
            if (!libEq) {
                const existIdx = (config.equipments || []).findIndex(x => x.id === eq.id || x.name === eq.name);
                if (existIdx >= 0) {
                    config.equipments[existIdx] = { ...config.equipments[existIdx], ...eq, id: config.equipments[existIdx].id };
                    finalId = config.equipments[existIdx].id;
                } else {
                    config.equipments.push(eq);
                }
            }
            if (act === 'equip_now') {
                const targetUnitId = ev.autoEquipTo || state?.selectedActorId || config.allies?.[0]?.id;
                if (state && state.active && targetUnitId) {
                    equipItemOnUnit(state, config, targetUnitId, finalId);
                } else {
                    const tpl = (config.allies || []).find(a => a.id === targetUnitId) || config.allies?.[0];
                    if (tpl) {
                        if (!Array.isArray(tpl.equipmentIds)) tpl.equipmentIds = [];
                        if (!tpl.equipmentIds.includes(finalId)) tpl.equipmentIds.push(finalId);
                    }
                }
                return `🛡️ 已收录并装备「${eq.name}」`;
            }
            return `🎁 已将「${eq.name}」收入装备库`;
        }

        if (ev.type === 'loot_item') {
            const libItem = ev.itemId ? findItemById(config, ev.itemId) : null;
            if (libItem) {
                libItem.quantity = (libItem.quantity || 0) + (ev.quantity || 1);
                return `🎒 「${libItem.name}」库存 +${ev.quantity || 1}`;
            }
            if (ev.item) {
                const exist = (config.items || []).find(x => x.id === ev.item.id || x.name === ev.item.name);
                if (exist) exist.quantity = (exist.quantity || 0) + ev.item.quantity;
                else config.items.push(ev.item);
                return `🎒 已将「${ev.item.name} ×${ev.item.quantity}」收入背包`;
            }
            return '';
        }

        if (ev.type === 'loot_bundle') {
            let cnt = 0;
            for (const eEntry of ev.equips || []) {
                const libEq = eEntry.equipId ? findEquipmentById(config, eEntry.equipId) : null;
                const eq = libEq || eEntry.equipment;
                if (!eq) continue;
                if (!libEq) {
                    const existIdx = (config.equipments || []).findIndex(x => x.id === eq.id || x.name === eq.name);
                    if (existIdx >= 0) config.equipments[existIdx] = { ...config.equipments[existIdx], ...eq, id: config.equipments[existIdx].id };
                    else config.equipments.push(eq);
                }
                cnt++;
            }
            for (const iEntry of ev.items || []) {
                const libIt = iEntry.itemId ? findItemById(config, iEntry.itemId) : null;
                if (libIt) {
                    libIt.quantity = (libIt.quantity || 0) + (iEntry.quantity || 1);
                    cnt++;
                } else if (iEntry.item) {
                    const exist = (config.items || []).find(x => x.id === iEntry.item.id || x.name === iEntry.item.name);
                    if (exist) exist.quantity = (exist.quantity || 0) + (iEntry.quantity || 1);
                    else config.items.push(iEntry.item);
                    cnt++;
                }
            }
            const targetUnitId = ev.unitId || state?.selectedActorId || config.allies?.[0]?.id;
            for (const sEntry of ev.grantSkills || []) {
                const libSk = sEntry.skillId ? findSkillById(config, sEntry.skillId) : null;
                const sk = libSk || sEntry.skill;
                if (!sk) continue;
                let finalSkId = sk.id;
                if (!libSk) {
                    const existIdx = (config.skills || []).findIndex(x => x.id === sk.id || x.name === sk.name);
                    if (existIdx >= 0) { config.skills[existIdx] = { ...config.skills[existIdx], ...sk, id: config.skills[existIdx].id }; finalSkId = config.skills[existIdx].id; }
                    else config.skills.push(sk);
                }
                if (targetUnitId) grantSkillToUnit(state, config, targetUnitId, finalSkId);
                cnt++;
            }
            return `💎 已全部收录「${ev.title || '战利品包'}」共 ${cnt} 项`;
        }

        if (ev.type === 'grant_skill') {
            const libSkill = ev.skillId ? findSkillById(config, ev.skillId) : null;
            const sk = libSkill || ev.skill;
            if (!sk) return '';
            let finalSkillId = sk.id;
            if (!libSkill) {
                const existIdx = (config.skills || []).findIndex(x => x.id === sk.id || x.name === sk.name);
                if (existIdx >= 0) {
                    config.skills[existIdx] = { ...config.skills[existIdx], ...sk, id: config.skills[existIdx].id };
                    finalSkillId = config.skills[existIdx].id;
                } else {
                    config.skills.push(sk);
                }
            }
            const targetUnitId = ev.unitId || state?.selectedActorId || config.allies?.[0]?.id;
            grantSkillToUnit(state, config, targetUnitId, finalSkillId);
            return `✨ 已学会技能「${sk.name}」`;
        }

        if (ev.type === 'grant_status') {
            let finalStId = ev.statusId;
            if (ev.status && !findStatusDefById(config, ev.status.id)) {
                config.statuses.push(ev.status);
                finalStId = ev.status.id;
            }
            const targetUnitId = ev.unitId || state?.selectedActorId || config.allies?.[0]?.id;
            const r = applyExternalStatusToUnit(state, config, targetUnitId, finalStId, ev.turns, ev.remove);
            return r.ok ? `✨ 已${ev.remove ? '解除' : '附加'}剧情状态` : `⚠️ ${r.message}`;
        }

        if (ev.type === 'level_up') {
            const targetUnitId = ev.unitId || state?.selectedActorId || config.allies?.[0]?.id;
            const r = levelUpUnit(state, config, targetUnitId, ev.levels || 1);
            return r.ok ? `⬆️ 已突破至 Lv.${r.level}（+${r.gainedPts} 自由点）` : `⚠️ ${r.message}`;
        }
        return '';
    }

    elEventBar.addEventListener('click', (e) => {
        const config = deps.getConfig();
        const state = deps.getBattleState();

        const batchBtn = e.target.closest('[data-ev-batch]');
        if (batchBtn) {
            const batchAct = batchBtn.dataset.evBatch;
            if (batchAct === 'dismiss_all') {
                pendingEvents = [];
                render();
                return;
            }
            if (batchAct === 'accept_all_loot') {
                let doneCount = 0;
                const remaining = [];
                for (const ev of pendingEvents) {
                    if (['loot_equipment', 'loot_item', 'loot_bundle', 'grant_skill', 'grant_status', 'level_up'].includes(ev.type)) {
                        applySingleLootOrGrowthEvent(ev, 'store_only', config, state);
                        doneCount++;
                    } else {
                        remaining.push(ev);
                    }
                }
                pendingEvents = remaining;
                saveConfig(config);
                deps.onConfigMutated?.();
                deps.onStateMutated();
                showToast(`✅ 已一键收录 ${doneCount} 项战利品/成长事件！`);
                return;
            }
        }

        const actBtn = e.target.closest('[data-ev-act]');
        if (!actBtn) return;
        const itemEl = actBtn.closest('.stcf-event-item');
        const uid = itemEl?.dataset.evUid;
        const evIdx = pendingEvents.findIndex(x => x.uid === uid);
        if (evIdx < 0) return;

        const ev = pendingEvents[evIdx];
        const act = actBtn.dataset.evAct;

        if (act === 'dismiss') {
            pendingEvents.splice(evIdx, 1);
            if (ev.fromMvuField) {
                deps.onStateMutated({ clearMvuField: ev.fromMvuField });
            } else {
                render();
            }
            return;
        }

        if (['loot_equipment', 'loot_item', 'loot_bundle', 'grant_skill', 'grant_status', 'level_up'].includes(ev.type)) {
            const msg = applySingleLootOrGrowthEvent(ev, act, config, state);
            saveConfig(config);
            pendingEvents.splice(evIdx, 1);
            deps.onConfigMutated?.();
            deps.onStateMutated();
            if (msg) showToast(msg);
            return;
        }

        if (ev.type === 'start_combat') {
            registerBundledDeps(ev, config);
            saveConfig(config);
            const resolved = resolveEventEnemies(ev, config);
            const nextState = createBattleState(config, resolved.length ? resolved : null);
            applyMvuVitalsOnBattleStart(nextState, config);
            deps.setBattleState(nextState);
            pendingEvents.splice(evIdx, 1);
            deps.onConfigMutated?.();
            deps.onStateMutated({ clearMvuField: ev.fromMvuField || '' });
            showToast('⚔️ 已按剧情敌人开启战斗！');
            return;
        }

        if (ev.type === 'add_enemy') {
            registerBundledDeps(ev, config);
            saveConfig(config);
            const resolved = resolveEventEnemies(ev, config);
            if (!state || !state.active) {
                const nextState = createBattleState(config, resolved.length ? resolved : null);
                applyMvuVitalsOnBattleStart(nextState, config);
                deps.setBattleState(nextState);
                showToast('⚔️ 已开启战斗并加入该敌人！');
            } else {
                let addedCount = 0;
                for (const enemyTpl of resolved) {
                    const r = addEnemyToBattle(state, config, enemyTpl);
                    if (r.ok) addedCount++;
                    else showToast(`⚠️ ${r.message}`);
                }
                if (addedCount > 0) showToast(`🚨 已向当前战场塞入 ${addedCount} 名敌方增援！`);
            }
            pendingEvents.splice(evIdx, 1);
            deps.onConfigMutated?.();
            deps.onStateMutated({ clearMvuField: ev.fromMvuField || '' });
        }
    });

    function renderUnitCard(unit, state, config) {
        const alive = isAlive(unit);
        const eff = getEffectiveStats(unit, config);
        const isSelectedActor = state.selectedActorId === unit.id;
        const isSelectedTarget = state.selectedTargetId === unit.id;

        const hpPct = unit.maxHp > 0 ? Math.round((unit.hp / unit.maxHp) * 100) : 0;
        const mpPct = unit.maxMp > 0 ? Math.round((unit.mp / unit.maxMp) * 100) : 0;
        const gaugeEntries = getGaugeEntries(config);
        const gaugesHtml = gaugeEntries.map(gDef => {
            const val = Number.isFinite(Number(unit.gauges?.[gDef.id])) ? Number(unit.gauges[gDef.id]) : gDef.min;
            const span = Math.max(1, gDef.max - gDef.min);
            const pct = Math.min(100, Math.max(0, Math.round(((val - gDef.min) / span) * 100)));
            const valText = (gDef.min === 0 && gDef.max === 100) ? String(val) : `${val}/${gDef.max}`;
            return `
                <div class="stcf-bar-row stcf-bar-mini">
                    <span class="stcf-bar-label" title="${escapeHtml(gDef.name)} (${gDef.min}~${gDef.max})">${escapeHtml(gDef.name)}</span>
                    <div class="stcf-bar-track"><div class="stcf-bar-fill" style="width:${pct}%;background:${escapeHtml(gDef.color)}"></div></div>
                    <span class="stcf-bar-val">${valText}</span>
                </div>
            `;
        }).join('');

        const unitRestrained = isUnitRestrained(unit, config);
        let stateTag = '';
        if (!alive) stateTag = '<span class="stcf-unit-tag stcf-tag-ko">倒下</span>';
        else if (eff.isStunned) stateTag = '<span class="stcf-unit-tag stcf-tag-stun">受控</span>';
        else if (unitRestrained) stateTag = '<span class="stcf-unit-tag stcf-tag-bind">⛓️被束缚</span>';
        else if (unit.side === 'ally') {
            stateTag = unit.hasActed
                ? '<span class="stcf-unit-tag stcf-tag-done">已行动</span>'
                : '<span class="stcf-unit-tag stcf-tag-ready">待行动</span>';
        }

        const statusHtml = (unit.statuses || []).map(st => {
            const def = findStatusDefById(config, st.statusId);
            if (!def) return '';
            let badgeText = String(st.remainingTurns);
            let sourceNote = `剩余 ${st.remainingTurns} 回合`;
            let extraClass = '';
            let objBreakBtn = '';

            if (st.source === 'equipment') {
                badgeText = '装';
                sourceNote = `装备「${st.sourceLabel || ''}」常驻效果`;
                extraClass = 'stcf-chip-equip';
            } else if (st.source === 'threshold') {
                badgeText = '⚡';
                sourceNote = `阈值规则「${st.sourceLabel || ''}」维持生效`;
                extraClass = 'stcf-chip-threshold';
            } else if (def.restraintType) {
                extraClass = 'stcf-chip-bind';
                const kindText = def.restraintType === 'magical' ? '法术束缚' : '物理束缚';
                if (def.restraintSourceMode === 'object' && st.objectHp > 0) {
                    const objName = def.restraintObjectName || def.name;
                    const objTargetKey = `restraint::${unit.id}::${st.statusId}`;
                    const isPinned = state.selectedTargetId === objTargetKey;
                    badgeText = `HP ${st.objectHp}/${st.objectMaxHp || st.objectHp}`;
                    sourceNote = `${kindText}道具「${objName}」(${badgeText}，打破即释放)`;
                    objBreakBtn = `<button type="button" class="stcf-break-btn ${isPinned ? 'active' : ''}" data-pin-target="${escapeHtml(objTargetKey)}" title="瞄准并攻击该禁锢道具（不会伤及队友）">🔨打碎</button>`;
                } else {
                    const casterName = st.casterId ? (findUnitById(state, st.casterId)?.name || st.casterId) : '未知';
                    sourceNote = `${kindText}｜施法者：${casterName}（攻击施法者立即释放）`;
                }
            } else if (st.casterId || st.sourceLabel) {
                const casterName = st.sourceLabel || (findUnitById(state, st.casterId)?.name || st.casterId);
                sourceNote = `剩余 ${st.remainingTurns} 回合｜来源：${casterName}`;
            }
            const tip = `${def.name}（${sourceNote}）：${def.description || '组合状态效果'}`;
            return `<span class="stcf-status-chip ${extraClass}" title="${escapeHtml(tip)}">${escapeHtml(def.icon || '✨')} ${escapeHtml(def.name)} <b>${badgeText}</b>${objBreakBtn}</span>`;
        }).join('');

        const equipCount = (unit.equipmentIds || []).length;
        const equipBadge = equipCount > 0 ? `<span class="stcf-equip-count" title="已穿戴 ${equipCount} 件装备">🛡️${equipCount}</span>` : '';
        const autoToggleBtn = unit.side === 'ally'
            ? `<button type="button" class="stcf-target-pin ${unit.autoControl ? 'active' : ''}" data-toggle-auto="${escapeHtml(unit.id)}" title="${unit.autoControl ? '当前由 AI 自动托管出招（点击切回手动控制）' : '当前手动控制（点击开启 AI 自动托管）'}" style="${unit.autoControl ? 'border-color:#f1c40f;background:rgba(241,196,15,0.28);color:#ffe17a;' : 'opacity:0.55;'}">${unit.autoControl ? '🤖托管' : '🤖'}</button>`
            : '';
        const clsObj = config.progression?.enabled ? findClassById(config, unit.classId) : null;
        const lvClassTag = config.progression?.enabled && unit.side === 'ally'
            ? `<span class="stcf-unit-tag stcf-tag-lv">Lv.${unit.level || 1}${clsObj ? ` ${escapeHtml(clsObj.name)}` : ''}</span>`
            : '';

        const gmGaugeBtns = gaugeEntries.map(gDef => {
            const step = (gDef.max - gDef.min) <= 15 ? 1 : 10;
            return `
                <span title="${escapeHtml(gDef.id)}">${escapeHtml(gDef.name)}</span>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="${escapeHtml(gDef.id)}" data-gm-delta="${-step}">-${step}</button>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="${escapeHtml(gDef.id)}" data-gm-delta="${step}">+${step}</button>
            `;
        }).join('');

        const gmHtml = gmMode ? `
            <div class="stcf-gm-row">
                <span>HP</span>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="hp" data-gm-delta="-10">-10</button>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="hp" data-gm-delta="10">+10</button>
                ${gmGaugeBtns}
            </div>
        ` : '';

        const classes = [
            'stcf-unit-card',
            unit.side === 'ally' ? 'stcf-unit-ally' : 'stcf-unit-enemy',
            !alive ? 'stcf-unit-dead' : '',
            isSelectedActor ? 'stcf-selected-actor' : '',
            isSelectedTarget ? 'stcf-selected-target' : '',
        ].filter(Boolean).join(' ');

        const intentInfo = (unit.side === 'enemy' && alive && state.phase === 'player_turn')
            ? formatEnemyIntentSummary(unit, state, config)
            : null;
        const intentHtml = intentInfo ? `
            <div class="stcf-intent-row ${intentInfo.interrupted ? 'is-interrupted' : (intentInfo.isInterruptible ? 'is-interruptible' : '')}" title="${escapeHtml(intentInfo.tooltip)}">
                <span class="stcf-intent-text">${escapeHtml(intentInfo.text)}</span>
                ${intentInfo.badge ? `<span class="stcf-intent-badge stcf-intent-${escapeHtml(intentInfo.badgeKind)}">${escapeHtml(intentInfo.badge)}</span>` : ''}
            </div>
        ` : '';

        return `
            <div class="${classes}" data-unit-id="${escapeHtml(unit.id)}" data-unit-side="${unit.side}">
                <div class="stcf-unit-top">
                    <div class="stcf-unit-name-wrap">
                        <span class="stcf-unit-name">${escapeHtml(unit.name)}</span>
                        ${lvClassTag}
                        ${stateTag}
                        ${autoToggleBtn}
                        ${equipBadge}
                    </div>
                    <div class="stcf-unit-top-right">
                        <span class="stcf-unit-stats" title="实时物攻 / 精神法攻 / 物防 / 法抗">攻${eff.atk} 精${eff.spi} 防${eff.def} 抗${eff.mdef}</span>
                        ${alive ? `<button type="button" class="stcf-target-pin ${isSelectedTarget ? 'active' : ''}" data-pin-target="${escapeHtml(unit.id)}" title="设为技能/道具瞄准目标">🎯</button>` : ''}
                    </div>
                </div>
                ${intentHtml}

                <div class="stcf-bar-group">
                    <div class="stcf-bar-row">
                        <span class="stcf-bar-label">HP</span>
                        <div class="stcf-bar-track"><div class="stcf-bar-fill stcf-bar-hp" style="width:${hpPct}%"></div></div>
                        <span class="stcf-bar-val">${unit.hp}/${unit.maxHp}</span>
                    </div>
                    <div class="stcf-bar-row">
                        <span class="stcf-bar-label">MP</span>
                        <div class="stcf-bar-track"><div class="stcf-bar-fill stcf-bar-mp" style="width:${mpPct}%"></div></div>
                        <span class="stcf-bar-val">${unit.mp}/${unit.maxMp}</span>
                    </div>
                    ${gaugesHtml ? `<div class="stcf-gauges-row">${gaugesHtml}</div>` : ''}
                </div>

                ${statusHtml ? `<div class="stcf-statuses-row">${statusHtml}</div>` : ''}
                ${gmHtml}
            </div>
        `;
    }

    function render() {
        const config = deps.getConfig();
        const enabled = config?.general?.enabled !== false;
        root.classList.toggle('stcf-hidden', !enabled);
        if (!enabled) return;

        const state = deps.getBattleState();
        const activePrompts = deps.getActivePrompts() || [];
        const contextText = deps.getAiContextText?.() || '';
        elContextChars.textContent = String(contextText.length);
        elContextText.textContent = contextText || '（当前未开启 AI 上下文同步开关，可在扩展设置中开启）';
        renderPendingEvents();

        const evBadge = pendingEvents.length ? ` · 🎁${pendingEvents.length}` : '';
        const authOn = Boolean(config?.general?.authoringMode);
        const authBadge = authOn ? ' · ✍️创作' : '';
        elBtnAuthoring?.classList.toggle('active', authOn);

        if (!state || !state.active) {
            elPillBadge.textContent = `待机${authBadge}${evBadge}`;
            elPhaseBadge.textContent = authOn ? '创作模式' : '未开始';
            elTurnBadge.textContent = 'T0';
            elBtnStartReset.textContent = '开始战斗';
            elIdle.classList.remove('stcf-hidden');
            elBattleArea.classList.add('stcf-hidden');
        } else {
            const phaseLabel = PHASE_LABELS[state.phase] || state.phase;
            elPillBadge.textContent = `T${state.turn} ${phaseLabel}${authBadge}${activePrompts.length ? ` · 📌${activePrompts.length}` : ''}${evBadge}`;
            elPhaseBadge.textContent = phaseLabel;
            elTurnBadge.textContent = `第 ${state.turn} 回合`;
            elBtnStartReset.textContent = '重置战斗';
            elIdle.classList.add('stcf-hidden');
            elBattleArea.classList.remove('stcf-hidden');

            elAlliesList.innerHTML = state.allies.map(u => renderUnitCard(u, state, config)).join('');
            elEnemiesList.innerHTML = state.enemies.map(u => renderUnitCard(u, state, config)).join('');

            const actor = findUnitById(state, state.selectedActorId);
            const target = findUnitById(state, state.selectedTargetId);
            const parsedObjTarget = parseRestraintObjectTargetId(state.selectedTargetId);
            elActorName.textContent = actor ? actor.name : '无';
            if (parsedObjTarget) {
                const boundU = findUnitById(state, parsedObjTarget.unitId);
                const stObj = boundU?.statuses?.find(s => s.statusId === parsedObjTarget.statusId);
                const stDef = findStatusDefById(config, parsedObjTarget.statusId);
                const objName = stDef?.restraintObjectName || stDef?.name || '禁锢道具';
                elTargetName.textContent = boundU && stObj
                    ? `🔨 ${boundU.name}的「${objName}」(HP ${stObj.objectHp}/${stObj.objectMaxHp})`
                    : '自动';
            } else {
                elTargetName.textContent = target ? target.name : '自动';
            }

            const canAct = state.phase === 'player_turn' && actor && actor.side === 'ally' && isAlive(actor) && !actor.hasActed;
            const actorAlive = state.phase === 'player_turn' && actor && actor.side === 'ally' && isAlive(actor);

            // 1. 技能栏（被束缚时自动置顶显示「⛓️ 挣扎脱离」及实时概率，普通技能自动锁定）
            const strugglePreview = actor ? getUnitStrugglePreview(state, config, actor) : null;
            const struggleBtnHtml = strugglePreview ? (() => {
                const tipLines = strugglePreview.items.map(x => `${x.name}：${x.detail}`).join('\n');
                return `
                    <button type="button" class="stcf-skill-btn stcf-struggle-btn" data-action="struggle" ${!canAct ? 'disabled' : ''} title="${escapeHtml(tipLines)}">
                        <span class="stcf-skill-name">⛓️ 挣扎脱离</span>
                        <span class="stcf-skill-meta">预计成功率 ${strugglePreview.minPercent}%</span>
                    </button>
                `;
            })() : '';

            const availSkills = actor ? getUnitAvailableSkills(actor, config) : [];
            const defendBtnHtml = (!strugglePreview && actor && actor.side === 'ally') ? `
                <button type="button" class="stcf-skill-btn" data-action="defend_wait" ${!canAct ? 'disabled' : ''} title="跳过本角色攻击，防御待机并调息回复少量 MP（防止缺蓝/全冷却卡死）">
                    <span class="stcf-skill-name">🛡️ 防御待机</span>
                    <span class="stcf-skill-meta">0MP · 调息回蓝</span>
                </button>
            ` : '';
            if (availSkills.length === 0 && !struggleBtnHtml && !defendBtnHtml) {
                elSkillsBar.innerHTML = '<span class="stcf-muted">该角色尚未配置技能，请到「成长/职业」或扩展设置中添加。</span>';
            } else {
                elSkillsBar.innerHTML = struggleBtnHtml + availSkills.map(({ skill: sk, fromEquipmentName, fromClassName }) => {
                    const lackMp = actor && actor.mp < sk.mpCost;
                    const remCd = actor ? getSkillRemainingCooldown(actor, sk.id) : 0;
                    const preCheck = actor ? checkSkillPrerequisite(state, config, actor, sk, state.selectedTargetId) : { ok: true };
                    const disabled = !canAct || lackMp || !preCheck.ok;
                    const typeBadge = TARGET_TYPE_BADGES[sk.targetType] || '';
                    const intTag = sk.canInterrupt ? ` · 💥打断${(sk.interruptChance ?? 100) < 100 ? `${sk.interruptChance}%` : ''}` : '';
                    const srcTag = fromEquipmentName ? ` · 🛡️${fromEquipmentName}` : (fromClassName ? ` · 🎓${fromClassName}` : '');
                    const lockTag = remCd > 0 ? ` · ⏳CD ${remCd}T` : (!preCheck.ok ? ' · 🔒需前置' : '');
                    const tip = `${sk.description || sk.name}｜消耗 ${sk.mpCost} MP${sk.cooldown ? `｜冷却 ${sk.cooldown}T` : ''}${sk.canInterrupt ? `｜💥可打断敌方蓄力/可打断意图(${sk.interruptChance ?? 100}%)` : ''}｜公式：${sk.formula}${!preCheck.ok ? `｜⚠️ ${preCheck.reason}` : ''}`;
                    return `
                        <button type="button" class="stcf-skill-btn" data-skill-id="${escapeHtml(sk.id)}" ${disabled ? 'disabled' : ''} title="${escapeHtml(tip)}">
                            <span class="stcf-skill-name">${remCd > 0 ? '⏳ ' : (!preCheck.ok ? '🔒 ' : '')}${escapeHtml(sk.name)}</span>
                            <span class="stcf-skill-meta">${typeBadge}${sk.mpCost > 0 ? ` · ${sk.mpCost}MP` : ''}${intTag}${escapeHtml(srcTag)}${lockTag}</span>
                        </button>
                    `;
                }).join('') + defendBtnHtml;
            }

            // 2. 道具栏
            const items = config.items || [];
            if (items.length === 0) {
                elItemsBar.innerHTML = '<span class="stcf-muted">背包暂无道具，可在扩展设置「道具库」添加或导入。</span>';
            } else {
                elItemsBar.innerHTML = items.map(it => {
                    const noStock = (it.quantity || 0) <= 0;
                    const disabled = noStock || !actorAlive || (it.consumesTurn && !canAct);
                    const typeBadge = TARGET_TYPE_BADGES[it.targetType] || '';
                    const turnTag = it.consumesTurn ? '' : ' · 不占回合';
                    const tip = `${it.description || it.name}｜剩余 ${it.quantity}`;
                    return `
                        <button type="button" class="stcf-skill-btn stcf-item-btn" data-item-id="${escapeHtml(it.id)}" ${disabled ? 'disabled' : ''} title="${escapeHtml(tip)}">
                            <span class="stcf-skill-name">${escapeHtml(it.icon || '🎒')} ${escapeHtml(it.name)} ×${it.quantity}</span>
                            <span class="stcf-skill-meta">${typeBadge}${turnTag}</span>
                        </button>
                    `;
                }).join('');
            }

            // 3. 装备栏（当前选中我方角色的穿脱面板）
            const equips = config.equipments || [];
            if (!actor || actor.side !== 'ally') {
                elEquipBar.innerHTML = '<span class="stcf-muted">请先点选一名我方角色查看/更换装备。</span>';
            } else if (equips.length === 0) {
                elEquipBar.innerHTML = '<span class="stcf-muted">装备库为空，可在扩展设置「装备库」中添加或从写卡助手导入。</span>';
            } else {
                const wornSet = new Set(actor.equipmentIds || []);
                elEquipBar.innerHTML = equips.map(eq => {
                    const isWorn = wornSet.has(eq.id);
                    const slotName = SLOT_LABELS[eq.slot] || eq.slot;
                    const summary = formatEquipBonusSummary(eq, config);
                    return `
                        <div class="stcf-equip-row ${isWorn ? 'stcf-equip-worn' : ''}">
                            <div class="stcf-equip-info">
                                <strong>[${slotName}] ${escapeHtml(eq.name)}</strong>
                                <span class="stcf-muted">${escapeHtml(summary)}</span>
                            </div>
                            <button type="button" class="stcf-btn stcf-btn-sm ${isWorn ? 'stcf-btn-warn' : 'stcf-btn-primary'}"
                                data-equip-action="${isWorn ? 'unequip' : 'equip'}" data-equip-id="${escapeHtml(eq.id)}">
                                ${isWorn ? '卸下' : '穿戴'}
                            </button>
                        </div>
                    `;
                }).join('');
            }

            // 4. 成长 / 自由加点 / 职业树 / 通用技能池（v1.5 新增）
            const progOn = config.progression?.enabled !== false;
            elTabGrowth.classList.toggle('stcf-hidden', !progOn);
            if (progOn && actor && actor.side === 'ally') {
                const freePts = Number(actor.freePoints) || 0;
                elTabGrowth.textContent = freePts > 0 ? `⬆️ 成长(+${freePts})` : '⬆️ 成长/职业';
                const gains = config.progression?.statGains || { vitHp: 15, strAtk: 2, spiMag: 2, spiMp: 8, defPhys: 2, mdefMag: 2 };
                const alloc = actor.allocated || { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 };
                const statDefs = [
                    ['vit', '体质', `+${gains.vitHp}HP`],
                    ['str', '力量', `+${gains.strAtk}物攻`],
                    ['spi', '精神', `+${gains.spiMag}法攻/+${gains.spiMp}MP`],
                    ['def', '物防', `+${gains.defPhys}物防`],
                    ['mdef', '法抗', `+${gains.mdefMag}法抗`],
                ];
                const enabledClasses = (config.classTrees || []).filter(c => isWorldviewEnabled(config, c.worldview));
                const curClass = findClassById(config, actor.classId);
                const curLv = actor.level || 1;

                const unlockPreview = curClass
                    ? (curClass.unlockSkills || []).map(u => {
                        const skName = findSkillById(config, u.skillId)?.name || u.skillId;
                        const ok = curLv >= u.level;
                        return `<span class="stcf-status-chip ${ok ? 'stcf-chip-equip' : ''}">Lv.${u.level} ${escapeHtml(skName)} ${ok ? '✅' : '🔒'}</span>`;
                    }).join('')
                    : '<span class="stcf-muted">未选择职业</span>';

                const universalSkills = (config.skills || []).filter(s => s.poolType === 'universal' && isWorldviewEnabled(config, s.worldview));

                elGrowthBar.innerHTML = `
                    <div class="stcf-growth-top">
                        <span><strong>${escapeHtml(actor.name)}</strong> · Lv.<strong>${curLv}</strong> · 剩余自由点：<strong style="color:#ffd166">${freePts}</strong></span>
                        <div class="stcf-event-actions">
                            <button type="button" class="stcf-btn stcf-btn-primary stcf-btn-sm" data-growth-act="level_up">⬆️ 修炼升级(+1级)</button>
                            <button type="button" class="stcf-btn stcf-btn-sm" data-growth-act="reset_pts">🔄 洗点</button>
                        </div>
                    </div>
                    <div class="stcf-alloc-grid">
                        ${statDefs.map(([key, label, hint]) => `
                            <div class="stcf-alloc-cell">
                                <span>${label} <b>${alloc[key] || 0}</b> <small class="stcf-muted">(${hint})</small></span>
                                <button type="button" class="stcf-btn stcf-btn-sm stcf-btn-primary" data-alloc-stat="${key}" ${freePts <= 0 ? 'disabled' : ''}>+</button>
                            </div>
                        `).join('')}
                    </div>
                    <div class="stcf-growth-class">
                        <div class="stcf-growth-top">
                            <span>🎓 职业树切换：</span>
                            <select class="stcf-hud-select" id="stcf-hud-class-select">
                                <option value="">无职业</option>
                                ${enabledClasses.map(c => {
                                    const parentName = c.parentClassId ? (findClassById(config, c.parentClassId)?.name || '') : '';
                                    const label = `[${c.worldview}] ${parentName ? `${parentName}→` : ''}${c.name} (Lv.${c.requiredLevel})`;
                                    const locked = curLv < c.requiredLevel;
                                    return `<option value="${escapeHtml(c.id)}" ${actor.classId === c.id ? 'selected' : ''} ${locked ? 'disabled' : ''}>${escapeHtml(label)}${locked ? ' 🔒' : ''}</option>`;
                                }).join('')}
                            </select>
                        </div>
                        <div class="stcf-statuses-row">${unlockPreview}</div>
                    </div>
                    <div class="stcf-growth-univ">
                        <div class="stcf-muted" style="margin-bottom:3px;">🌐 通用技能池（勾选即可自由装备给当前角色）：</div>
                        <div class="stcf-chips-wrap">
                            ${universalSkills.map(sk => `
                                <label class="stcf-chip-check">
                                    <input type="checkbox" data-hud-univ-skill="${escapeHtml(sk.id)}" ${(actor.skillIds || []).includes(sk.id) ? 'checked' : ''}>
                                    <span>${escapeHtml(sk.name)}</span>
                                </label>
                            `).join('') || '<span class="stcf-muted">暂无启用的通用技能</span>'}
                        </div>
                    </div>
                `;
            } else {
                elTabGrowth.textContent = '⬆️ 成长/职业';
                elGrowthBar.innerHTML = '<span class="stcf-muted">请先选择一名我方角色。</span>';
            }

            elBtnEndTurn.disabled = state.phase !== 'player_turn';
            if (elBtnFinishBattle) {
                const ended = state.phase === 'victory' || state.phase === 'defeat';
                elBtnFinishBattle.classList.toggle('stcf-btn-primary', ended);
                elBtnFinishBattle.classList.toggle('stcf-btn-secondary', !ended);
                elBtnFinishBattle.textContent = ended ? '🏁 结束战斗(返回日常)' : '🏁 结束/撤退';
            }

            const recentLogs = (state.allLogs || []).slice(-25);
            elLogList.innerHTML = recentLogs.length
                ? recentLogs.map(line => `<div class="stcf-log-item">${escapeHtml(line)}</div>`).join('')
                : '<div class="stcf-muted">暂无战斗记录</div>';
            elLogList.scrollTop = elLogList.scrollHeight;
        }

        if (activePrompts.length > 0) {
            elPromptBar.classList.remove('stcf-hidden');
            elPromptCount.textContent = String(activePrompts.length);
            elPromptPreview.innerHTML = activePrompts.map(p => `
                <div class="stcf-prompt-item">
                    <div class="stcf-prompt-item-title">【${escapeHtml(p.name)}】触发者：${escapeHtml(p.matchedUnitNames.join('、'))}</div>
                    <div class="stcf-prompt-item-text">${escapeHtml(p.renderedText)}</div>
                </div>
            `).join('');
        } else {
            elPromptBar.classList.add('stcf-hidden');
            elPromptPreview.classList.add('stcf-hidden');
        }
    }

    // 战场卡片点击委托
    elBattlefield.addEventListener('click', (e) => {
        const state = deps.getBattleState();
        const config = deps.getConfig();
        if (!state || !state.active) return;

        const gmBtn = e.target.closest('.stcf-gm-btn');
        if (gmBtn) {
            e.stopPropagation();
            if (adjustUnitStatManual(state, config, gmBtn.dataset.gmUnit, gmBtn.dataset.gmStat, Number(gmBtn.dataset.gmDelta))) {
                deps.onStateMutated();
            }
            return;
        }

        const autoBtn = e.target.closest('[data-toggle-auto]');
        if (autoBtn) {
            e.stopPropagation();
            const uid = autoBtn.dataset.toggleAuto;
            const liveAlly = (state.allies || []).find(a => a.id === uid);
            const tplAlly = (config.allies || []).find(a => a.id === uid);
            if (liveAlly) {
                const nextVal = !liveAlly.autoControl;
                liveAlly.autoControl = nextVal;
                if (tplAlly) tplAlly.autoControl = nextVal;
                saveConfig(config);
                deps.onConfigMutated?.();
                deps.onStateMutated();
                showToast(nextVal ? `🤖 ${liveAlly.name} 已切为 AI 自动托管` : `🎮 ${liveAlly.name} 已切回手动控制`);
            }
            return;
        }

        const pinBtn = e.target.closest('[data-pin-target]');
        if (pinBtn) {
            e.stopPropagation();
            state.selectedTargetId = pinBtn.dataset.pinTarget;
            deps.onStateMutated();
            return;
        }

        const card = e.target.closest('.stcf-unit-card');
        if (!card) return;
        const unit = findUnitById(state, card.dataset.unitId);
        if (!unit || !isAlive(unit)) return;

        if (card.dataset.unitSide === 'ally') state.selectedActorId = unit.id;
        else state.selectedTargetId = unit.id;
        deps.onStateMutated();
    });

    // 释放技能 / 点击内置「⛓️ 挣扎脱离」
    elSkillsBar.addEventListener('click', async (e) => {
        const btn = e.target.closest('.stcf-skill-btn');
        if (!btn || btn.disabled) return;
        const state = deps.getBattleState();
        if (btn.dataset.action === 'struggle') {
            const res = executeStruggleAction(state, deps.getConfig(), state.selectedActorId);
            if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
            deps.onStateMutated();
            await dispatchNewLogs(res.newLogs);
            return;
        }
        if (btn.dataset.action === 'defend_wait') {
            const res = executeDefendWaitAction(state, deps.getConfig(), state.selectedActorId);
            if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
            deps.onStateMutated();
            await dispatchNewLogs(res.newLogs);
            return;
        }
        const res = executeAllyAction(state, deps.getConfig(), state.selectedActorId, btn.dataset.skillId, state.selectedTargetId);
        if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
        deps.onStateMutated();
        await dispatchNewLogs(res.newLogs);
    });

    // 使用道具
    elItemsBar.addEventListener('click', async (e) => {
        const btn = e.target.closest('.stcf-item-btn');
        if (!btn || btn.disabled) return;
        const state = deps.getBattleState();
        const config = deps.getConfig();
        const res = executeUseItem(state, config, state.selectedActorId, btn.dataset.itemId, state.selectedTargetId);
        if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
        saveConfig(config); // 持久化道具剩余库存
        deps.onConfigMutated?.();
        deps.onStateMutated();
        await dispatchNewLogs(res.newLogs);
    });

    // 穿戴/卸下装备
    elEquipBar.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-equip-action]');
        if (!btn) return;
        const state = deps.getBattleState();
        const config = deps.getConfig();
        const eqId = btn.dataset.equipId;
        const act = btn.dataset.equipAction;
        const res = act === 'unequip'
            ? unequipItemFromUnit(state, config, state.selectedActorId, eqId)
            : equipItemOnUnit(state, config, state.selectedActorId, eqId);
        if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
        saveConfig(config);
        deps.onConfigMutated?.();
        deps.onStateMutated();
        showToast(act === 'unequip' ? '已卸下装备' : '🛡️ 已穿戴装备并同步属性/常驻 Buff');
        await dispatchNewLogs(res.newLogs);
    });

    // 成长/加点/职业树/通用技能池交互（v1.5）
    elGrowthBar.addEventListener('click', (e) => {
        const state = deps.getBattleState();
        const config = deps.getConfig();
        if (!state || !state.active) return;

        const allocBtn = e.target.closest('[data-alloc-stat]');
        if (allocBtn) {
            const res = allocateStatPoint(state, config, state.selectedActorId, allocBtn.dataset.allocStat);
            if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
            saveConfig(config);
            deps.onConfigMutated?.();
            deps.onStateMutated();
            return;
        }

        const actBtn = e.target.closest('[data-growth-act]');
        if (actBtn) {
            const act = actBtn.dataset.growthAct;
            if (act === 'level_up') {
                const res = levelUpUnit(state, config, state.selectedActorId, 1);
                if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
                saveConfig(config);
                deps.onConfigMutated?.();
                deps.onStateMutated();
                showToast(`⬆️ 突破至 Lv.${res.level}，获得 ${res.gainedPts} 点自由属性点！`);
            } else if (act === 'reset_pts') {
                const res = resetUnitAllocatedPoints(state, config, state.selectedActorId);
                if (!res.ok) { showToast(`⚠️ ${res.message}`); return; }
                saveConfig(config);
                deps.onConfigMutated?.();
                deps.onStateMutated();
                showToast(`🔄 已洗点，返还 ${res.refunded} 点自由属性点`);
            }
        }
    });

    elGrowthBar.addEventListener('change', (e) => {
        const state = deps.getBattleState();
        const config = deps.getConfig();
        if (!state || !state.active) return;

        if (e.target.id === 'stcf-hud-class-select') {
            const res = changeUnitClass(state, config, state.selectedActorId, e.target.value);
            if (!res.ok) { showToast(`⚠️ ${res.message}`); render(); return; }
            saveConfig(config);
            deps.onConfigMutated?.();
            deps.onStateMutated();
            showToast('🎓 职业已变更，对应职业技能已同步！');
            return;
        }

        if (e.target.dataset.hudUnivSkill) {
            const sid = e.target.dataset.hudUnivSkill;
            const live = (state.allies || []).find(a => a.id === state.selectedActorId);
            const tpl = (config.allies || []).find(a => a.id === state.selectedActorId);
            if (!live || !tpl) return;
            const set = new Set(tpl.skillIds || []);
            if (e.target.checked) set.add(sid);
            else set.delete(sid);
            tpl.skillIds = [...set];
            live.skillIds = [...set];
            saveConfig(config);
            deps.onConfigMutated?.();
            deps.onStateMutated();
        }
    });

    setCollapsed(isCollapsed);
    render();

    return {
        render,
        setCollapsed,
        showToast,
        pushPendingEvents(events) {
            if (!Array.isArray(events) || events.length === 0) return;
            pendingEvents = [...events];
            render();
        },
        clearPendingEvents() {
            pendingEvents = [];
            render();
        },
    };
}
