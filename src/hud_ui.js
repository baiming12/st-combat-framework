/**
 * 战斗 HUD 悬浮面板交互模块 (src/hud_ui.js)
 * 职责：
 * 1. 加载 hud.html 并挂载到页面，默认折叠为迷你可拖拽浮标，避免在 TauriTavern 窄屏下遮挡聊天区
 * 2. 渲染 1v1 ~ 4v4 战场卡片（双方 HP、MP/体力、双特殊槽、Buff/Debuff 图标及悬浮详情）
 * 3. 处理技能点击、目标切换、结束回合、GM 快捷数值微调
 * 4. 战报输出仅支持“填入聊天输入框（绝不自动发送）”或“复制到剪贴板（双方案兼容 TauriTavern）”
 */

import {
    adjustUnitStatManual,
    createBattleState,
    endPlayerTurn,
    executeAllyAction,
    findSkillById,
    findStatusDefById,
    findUnitById,
    formatCombatLogOutput,
    getEffectiveStats,
    isAlive,
} from './engine.js';

/** 阶段中文标签映射（纯框架状态名，不含任何剧情或角色硬编码） */
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

/**
 * HTML 特殊字符转义，防止用户输入的名称破坏界面结构
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * 兼容 TauriTavern / 普通浏览器的双重剪贴板复制函数
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyTextSafe(text) {
    if (!text) return false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 回退到传统 textarea 复制方式
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

/**
 * 将战报填入 SillyTavern / TauriTavern 聊天输入框（严禁自动发送！）
 * @param {string} text
 * @param {'append'|'replace'} strategy
 * @returns {boolean}
 */
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

    // 仅触发输入框高度刷新事件，绝不点击发送按钮
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

/**
 * 创建并初始化 HUD 控制器
 * @param {{
 *   getConfig: () => object,
 *   getBattleState: () => object|null,
 *   setBattleState: (state: object|null) => void,
 *   getActivePrompts: () => Array<object>,
 *   onStateMutated: () => void,
 * }} deps
 */
export async function initHudUI(deps) {
    // 防止重复挂载
    const oldRoot = document.getElementById('stcf-hud-root');
    if (oldRoot) oldRoot.remove();

    const htmlUrl = new URL('../hud.html', import.meta.url);
    const resp = await fetch(htmlUrl);
    if (!resp.ok) {
        throw new Error(`无法加载 hud.html (${resp.status})`);
    }
    const html = await resp.text();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    const root = wrapper.firstElementChild;
    document.body.appendChild(root);

    let gmMode = false;
    let toastTimer = null;
    let isCollapsed = deps.getConfig()?.general?.hudStartCollapsed !== false;

    // DOM 元素引用
    const elPill = root.querySelector('#stcf-collapsed-pill');
    const elPillBadge = root.querySelector('#stcf-pill-badge');
    const elHeader = root.querySelector('#stcf-hud-header');
    const elPhaseBadge = root.querySelector('#stcf-phase-badge');
    const elTurnBadge = root.querySelector('#stcf-turn-badge');
    const elBtnGm = root.querySelector('#stcf-btn-gm-mode');
    const elBtnStartReset = root.querySelector('#stcf-btn-start-reset');
    const elBtnCollapse = root.querySelector('#stcf-btn-collapse');
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
    const elBtnEndTurn = root.querySelector('#stcf-btn-end-turn');
    const elBtnCopyLog = root.querySelector('#stcf-btn-copy-log');
    const elBtnFillInput = root.querySelector('#stcf-btn-fill-input');
    const elBtnClearRoundLog = root.querySelector('#stcf-btn-clear-round-log');
    const elLogList = root.querySelector('#stcf-log-list');
    const elToast = root.querySelector('#stcf-toast');

    function showToast(msg) {
        if (!elToast) return;
        elToast.textContent = msg;
        elToast.classList.remove('stcf-hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => elToast.classList.add('stcf-hidden'), 2200);
    }

    function setCollapsed(nextCollapsed) {
        isCollapsed = Boolean(nextCollapsed);
        root.classList.toggle('stcf-collapsed', isCollapsed);
        clampRootIntoViewport();
    }

    /** 确保悬浮窗/浮标永远停留在当前可见窗口范围内（适配 TauriTavern 缩放） */
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

    /** 绑定平滑拖拽（同时支持鼠标与触屏；短按浮标仍触发点击展开） */
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
            if (!moved && Math.hypot(dx, dy) > 5) {
                moved = true;
            }
            if (moved) {
                root.style.left = `${origLeft + dx}px`;
                root.style.top = `${origTop + dy}px`;
                root.style.right = 'auto';
                root.style.bottom = 'auto';
                clampRootIntoViewport();
            }
        });

        handleEl.addEventListener('pointerup', () => {
            if (dragging && isPillHandle && !moved) {
                setCollapsed(false);
            }
            dragging = false;
        });

        handleEl.addEventListener('pointercancel', () => {
            dragging = false;
        });
    }

    setupDraggable(elPill, true);
    setupDraggable(elHeader, false);
    window.addEventListener('resize', clampRootIntoViewport);

    /** 根据用户配置自动处理新产生的战报（仅复制或填入输入框，绝不自动发送） */
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
            showToast(ok ? '📋 战报已自动复制到剪贴板' : '⚠️ 剪贴板写入受限，请点复制按钮重试');
        } else if (mode === 'fill_input') {
            const ok = fillChatInputWithoutSending(text, config.general?.inputFillStrategy || 'append');
            showToast(ok ? '✏️ 战报已填入输入框（未发送）' : '⚠️ 未找到聊天输入框，请使用复制按钮');
        }
    }

    // 折叠按钮
    elBtnCollapse.addEventListener('click', () => setCollapsed(true));

    // GM 手动微调模式切换
    elBtnGm.addEventListener('click', () => {
        gmMode = !gmMode;
        elBtnGm.classList.toggle('active', gmMode);
        showToast(gmMode ? '🛠️ 已开启手动数值微调' : '🛠️ 已关闭手动数值微调');
        render();
    });

    // 展开/收起生效提示词预览
    elPromptBarToggle.addEventListener('click', () => {
        elPromptPreview.classList.toggle('stcf-hidden');
    });

    // 窄屏视图标签切换（全览 / 我方 / 敌方）
    root.querySelectorAll('.stcf-mobile-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            root.querySelectorAll('.stcf-mobile-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            elBattlefield.dataset.view = btn.dataset.side || 'both';
        });
    });

    // 开始 / 重置战斗
    elBtnStartReset.addEventListener('click', () => {
        const cur = deps.getBattleState();
        if (cur && cur.active) {
            if (!window.confirm('确定要按当前设置重新开始战斗吗？当前血量和回合进度将被重置。')) {
                return;
            }
        }
        const config = deps.getConfig();
        const nextState = createBattleState(config);
        deps.setBattleState(nextState);
        deps.onStateMutated();
        showToast('⚔️ 已开启新战斗');
    });

    // 结束我方回合
    elBtnEndTurn.addEventListener('click', async () => {
        const state = deps.getBattleState();
        const config = deps.getConfig();
        const res = endPlayerTurn(state, config);
        if (!res.ok) {
            showToast(`⚠️ ${res.message}`);
            return;
        }
        deps.onStateMutated();
        await dispatchNewLogs(res.newLogs);
    });

    // 手动复制本回合战报
    elBtnCopyLog.addEventListener('click', async () => {
        const text = formatCombatLogOutput(deps.getBattleState(), deps.getConfig());
        if (!text) {
            showToast('本回合暂无战报可复制');
            return;
        }
        const ok = await copyTextSafe(text);
        showToast(ok ? '📋 已复制本回合完整战报' : '⚠️ 复制失败，请检查权限');
    });

    // 手动填入输入框（不发送）
    elBtnFillInput.addEventListener('click', () => {
        const config = deps.getConfig();
        const text = formatCombatLogOutput(deps.getBattleState(), config);
        if (!text) {
            showToast('本回合暂无战报可填入');
            return;
        }
        const ok = fillChatInputWithoutSending(text, config.general?.inputFillStrategy || 'append');
        showToast(ok ? '✏️ 已将战报填入输入框（未发送）' : '⚠️ 未找到聊天输入框');
    });

    // 清空本轮待导出记录
    elBtnClearRoundLog.addEventListener('click', () => {
        const state = deps.getBattleState();
        if (!state) return;
        state.currentRoundLogs = [];
        deps.onStateMutated();
        showToast('已清空本轮战报缓存');
    });

    /** 渲染单个角色卡片（含血条、蓝条、双特殊槽、Buff 徽章、GM 微调按钮） */
    function renderUnitCard(unit, state, config) {
        const alive = isAlive(unit);
        const eff = getEffectiveStats(unit, config);
        const isSelectedActor = state.selectedActorId === unit.id;
        const isSelectedTarget = state.selectedTargetId === unit.id;

        const hpPct = unit.maxHp > 0 ? Math.round((unit.hp / unit.maxHp) * 100) : 0;
        const mpPct = unit.maxMp > 0 ? Math.round((unit.mp / unit.maxMp) * 100) : 0;
        const gA = unit.gauges?.gauge_a ?? 0;
        const gB = unit.gauges?.gauge_b ?? 0;
        const gADef = config.gauges?.gauge_a || { name: '状态槽A', color: '#e67e22' };
        const gBDef = config.gauges?.gauge_b || { name: '状态槽B', color: '#9b59b6' };

        let stateTag = '';
        if (!alive) {
            stateTag = '<span class="stcf-unit-tag stcf-tag-ko">倒下</span>';
        } else if (eff.isStunned) {
            stateTag = '<span class="stcf-unit-tag stcf-tag-stun">受控</span>';
        } else if (unit.side === 'ally') {
            stateTag = unit.hasActed
                ? '<span class="stcf-unit-tag stcf-tag-done">已行动</span>'
                : '<span class="stcf-unit-tag stcf-tag-ready">待行动</span>';
        }

        const statusHtml = (unit.statuses || []).map(st => {
            const def = findStatusDefById(config, st.statusId);
            if (!def) return '';
            const tip = `${def.name}（剩余 ${st.remainingTurns} 回合）：${def.description || def.effectType}`;
            return `<span class="stcf-status-chip" title="${escapeHtml(tip)}">${escapeHtml(def.icon || '✨')} ${escapeHtml(def.name)} <b>${st.remainingTurns}</b></span>`;
        }).join('');

        const gmHtml = gmMode ? `
            <div class="stcf-gm-row">
                <span>HP</span>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="hp" data-gm-delta="-10">-10</button>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="hp" data-gm-delta="10">+10</button>
                <span>A槽</span>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="gauge_a" data-gm-delta="-10">-10</button>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="gauge_a" data-gm-delta="10">+10</button>
                <span>B槽</span>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="gauge_b" data-gm-delta="-10">-10</button>
                <button type="button" class="stcf-gm-btn" data-gm-unit="${escapeHtml(unit.id)}" data-gm-stat="gauge_b" data-gm-delta="10">+10</button>
            </div>
        ` : '';

        const classes = [
            'stcf-unit-card',
            unit.side === 'ally' ? 'stcf-unit-ally' : 'stcf-unit-enemy',
            !alive ? 'stcf-unit-dead' : '',
            isSelectedActor ? 'stcf-selected-actor' : '',
            isSelectedTarget ? 'stcf-selected-target' : '',
        ].filter(Boolean).join(' ');

        return `
            <div class="${classes}" data-unit-id="${escapeHtml(unit.id)}" data-unit-side="${unit.side}">
                <div class="stcf-unit-top">
                    <div class="stcf-unit-name-wrap">
                        <span class="stcf-unit-name">${escapeHtml(unit.name)}</span>
                        ${stateTag}
                    </div>
                    <div class="stcf-unit-top-right">
                        <span class="stcf-unit-stats" title="实时攻击/防御（已含状态倍率）">攻${eff.atk} 防${eff.def}</span>
                        ${alive ? `<button type="button" class="stcf-target-pin ${isSelectedTarget ? 'active' : ''}" data-pin-target="${escapeHtml(unit.id)}" title="设为技能瞄准目标">🎯</button>` : ''}
                    </div>
                </div>

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
                    <div class="stcf-gauges-row">
                        <div class="stcf-bar-row stcf-bar-mini">
                            <span class="stcf-bar-label" title="${escapeHtml(gADef.name)}">${escapeHtml(gADef.name)}</span>
                            <div class="stcf-bar-track"><div class="stcf-bar-fill" style="width:${gA}%;background:${escapeHtml(gADef.color)}"></div></div>
                            <span class="stcf-bar-val">${gA}</span>
                        </div>
                        <div class="stcf-bar-row stcf-bar-mini">
                            <span class="stcf-bar-label" title="${escapeHtml(gBDef.name)}">${escapeHtml(gBDef.name)}</span>
                            <div class="stcf-bar-track"><div class="stcf-bar-fill" style="width:${gB}%;background:${escapeHtml(gBDef.color)}"></div></div>
                            <span class="stcf-bar-val">${gB}</span>
                        </div>
                    </div>
                </div>

                ${statusHtml ? `<div class="stcf-statuses-row">${statusHtml}</div>` : ''}
                ${gmHtml}
            </div>
        `;
    }

    /** 渲染整个战斗 HUD */
    function render() {
        const config = deps.getConfig();
        const enabled = config?.general?.enabled !== false;
        root.classList.toggle('stcf-hidden', !enabled);
        if (!enabled) return;

        const state = deps.getBattleState();
        const activePrompts = deps.getActivePrompts() || [];

        // 折叠浮标摘要
        if (!state || !state.active) {
            elPillBadge.textContent = '待机';
            elPhaseBadge.textContent = '未开始';
            elTurnBadge.textContent = 'T0';
            elBtnStartReset.textContent = '开始战斗';
            elIdle.classList.remove('stcf-hidden');
            elBattleArea.classList.add('stcf-hidden');
        } else {
            const phaseLabel = PHASE_LABELS[state.phase] || state.phase;
            elPillBadge.textContent = `T${state.turn} ${phaseLabel}${activePrompts.length ? ` · 📌${activePrompts.length}` : ''}`;
            elPhaseBadge.textContent = phaseLabel;
            elTurnBadge.textContent = `第 ${state.turn} 回合`;
            elBtnStartReset.textContent = '重置战斗';
            elIdle.classList.add('stcf-hidden');
            elBattleArea.classList.remove('stcf-hidden');

            // 渲染双方单位卡片
            elAlliesList.innerHTML = state.allies.map(u => renderUnitCard(u, state, config)).join('');
            elEnemiesList.innerHTML = state.enemies.map(u => renderUnitCard(u, state, config)).join('');

            // 渲染当前行动者与瞄准目标
            const actor = findUnitById(state, state.selectedActorId);
            const target = findUnitById(state, state.selectedTargetId);
            elActorName.textContent = actor ? actor.name : '无';
            elTargetName.textContent = target ? target.name : '自动';

            // 渲染当前选中角色的技能按钮
            const canAct = state.phase === 'player_turn' && actor && actor.side === 'ally' && isAlive(actor) && !actor.hasActed;
            const skillList = actor
                ? (actor.skillIds.length > 0
                    ? actor.skillIds.map(id => findSkillById(config, id)).filter(Boolean)
                    : (config.skills || []))
                : [];

            if (skillList.length === 0) {
                elSkillsBar.innerHTML = '<span class="stcf-muted">该角色尚未配置技能，请到扩展设置中勾选。</span>';
            } else {
                elSkillsBar.innerHTML = skillList.map(sk => {
                    const lackMp = actor && actor.mp < sk.mpCost;
                    const disabled = !canAct || lackMp;
                    const typeBadge = TARGET_TYPE_BADGES[sk.targetType] || '';
                    const tip = `${sk.description || sk.name}｜消耗 ${sk.mpCost} MP｜公式：${sk.formula}`;
                    return `
                        <button type="button" class="stcf-skill-btn" data-skill-id="${escapeHtml(sk.id)}" ${disabled ? 'disabled' : ''} title="${escapeHtml(tip)}">
                            <span class="stcf-skill-name">${escapeHtml(sk.name)}</span>
                            <span class="stcf-skill-meta">${typeBadge}${sk.mpCost > 0 ? ` · ${sk.mpCost}MP` : ''}</span>
                        </button>
                    `;
                }).join('');
            }

            elBtnEndTurn.disabled = state.phase !== 'player_turn';

            // 渲染日志列表（最新在下方）
            const recentLogs = (state.allLogs || []).slice(-20);
            elLogList.innerHTML = recentLogs.length
                ? recentLogs.map(line => `<div class="stcf-log-item">${escapeHtml(line)}</div>`).join('')
                : '<div class="stcf-muted">暂无战斗记录</div>';
            elLogList.scrollTop = elLogList.scrollHeight;
        }

        // 渲染生效的阈值提示词条
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

    // 事件委托：点击角色卡片 / 瞄准图标 / GM 微调按钮
    elBattlefield.addEventListener('click', (e) => {
        const state = deps.getBattleState();
        const config = deps.getConfig();
        if (!state || !state.active) return;

        // 1. GM 微调按钮
        const gmBtn = e.target.closest('.stcf-gm-btn');
        if (gmBtn) {
            e.stopPropagation();
            const unitId = gmBtn.dataset.gmUnit;
            const stat = gmBtn.dataset.gmStat;
            const delta = Number(gmBtn.dataset.gmDelta);
            if (adjustUnitStatManual(state, config, unitId, stat, delta)) {
                deps.onStateMutated();
            }
            return;
        }

        // 2. 专门的 🎯 设为目标按钮（方便给队友加血/加 Buff 时指定某个队友）
        const pinBtn = e.target.closest('.stcf-target-pin');
        if (pinBtn) {
            e.stopPropagation();
            state.selectedTargetId = pinBtn.dataset.pinTarget;
            deps.onStateMutated();
            return;
        }

        // 3. 点击整张角色卡片：点我方 = 切换行动者；点敌方 = 切换瞄准目标
        const card = e.target.closest('.stcf-unit-card');
        if (!card) return;
        const unitId = card.dataset.unitId;
        const side = card.dataset.unitSide;
        const unit = findUnitById(state, unitId);
        if (!unit || !isAlive(unit)) return;

        if (side === 'ally') {
            state.selectedActorId = unitId;
        } else {
            state.selectedTargetId = unitId;
        }
        deps.onStateMutated();
    });

    // 事件委托：点击技能按钮释放技能
    elSkillsBar.addEventListener('click', async (e) => {
        const btn = e.target.closest('.stcf-skill-btn');
        if (!btn || btn.disabled) return;

        const state = deps.getBattleState();
        const config = deps.getConfig();
        const skillId = btn.dataset.skillId;
        const res = executeAllyAction(state, config, state.selectedActorId, skillId, state.selectedTargetId);
        if (!res.ok) {
            showToast(`⚠️ ${res.message}`);
            return;
        }
        deps.onStateMutated();
        await dispatchNewLogs(res.newLogs);
    });

    // 首次应用折叠状态并渲染
    setCollapsed(isCollapsed);
    render();

    return {
        render,
        setCollapsed,
        showToast,
    };
}
