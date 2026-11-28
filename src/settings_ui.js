/**
 * 扩展侧边栏可视化配置面板模块 (src/settings_ui.js) - v1.6
 * 特性：
 * 1. 所有条目卡片与大段多选区均采用原生 <details> 折叠面板，默认全部折叠，彻底解决长列表难翻页问题
 * 2. 新增条目时自动展开该新条目；各分区提供一键「展开全部 / 折叠全部」快捷按钮
 * 3. 全链路多状态与高创作自由度：
 *    - 技能：多附加状态(各自概率与施加对象)、自身卖血/吸血公式、冷却CD、自身与目标前置状态
 *    - 状态/Buff：到期同时转化为多个新状态
 *    - 装备：附带多个常驻 Buff + 解锁多个专属技能
 *    - 道具：附加多个状态
 *    - 阈值规则：达标同时挂载多个 Buff
 */

import {
    MAX_UNITS_PER_SIDE,
    exportConfigAsJson,
    getCurrentProfileInfo,
    getGaugeEntries,
    importConfigFromJsonText,
    loadBuiltinPresetPack,
    loadConfig,
    resetConfigToDefaults,
    sanitizeGaugeId,
    saveAsGlobalTemplate,
    saveConfig,
} from './config.js';

const POOL_LABELS = { class: '🎓职业', universal: '🌐通用', monster: '👹怪物' };
const SLOT_LABELS = { weapon: '武器', head: '头部', body: '防具', accessory: '饰品' };
const TARGET_LABELS = {
    single_enemy: '单敌',
    all_enemies: '群敌',
    self: '自身',
    single_ally: '单友',
    all_allies: '群友',
};

function escapeHtml(str) {
    return String(str ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function makeUniqueId(prefix, existingItems) {
    const used = new Set((existingItems || []).map(item => item.id));
    let n = (existingItems || []).length + 1;
    while (used.has(`${prefix}_${String(n).padStart(2, '0')}`)) {
        n++;
    }
    return `${prefix}_${String(n).padStart(2, '0')}`;
}

/** 收集某个容器里当前展开的卡片 key，避免增删内部子项时误合上正在编辑的卡片 */
function captureOpenCardKeys(hostEl) {
    const openSet = new Set();
    hostEl?.querySelectorAll('details.stcf-fold[open][data-card-key]').forEach(d => {
        openSet.add(d.dataset.cardKey);
    });
    return openSet;
}

export async function initSettingsUI(deps) {
    const targetHost = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.body;

    const oldContainer = document.getElementById('stcf-settings-container');
    if (oldContainer) oldContainer.remove();

    const htmlUrl = new URL('../settings.html', import.meta.url);
    const resp = await fetch(htmlUrl);
    if (!resp.ok) throw new Error(`无法加载 settings.html (${resp.status})`);
    const html = await resp.text();
    const temp = document.createElement('div');
    temp.innerHTML = html.trim();
    const container = temp.firstElementChild;
    targetHost.appendChild(container);

    // 折叠抽屉兼容
    const drawerToggle = container.querySelector('.inline-drawer-toggle');
    const drawerContent = container.querySelector('.inline-drawer-content');
    const drawerIcon = container.querySelector('.inline-drawer-icon');
    if (drawerToggle && drawerContent && typeof window.jQuery === 'undefined') {
        drawerToggle.addEventListener('click', () => {
            const isOpen = drawerContent.style.display === 'block';
            drawerContent.style.display = isOpen ? 'none' : 'block';
            drawerIcon?.classList.toggle('up', !isOpen);
            drawerIcon?.classList.toggle('down', isOpen);
        });
    }

    // 分类标签切换
    container.querySelectorAll('.stcf-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            container.querySelectorAll('.stcf-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            container.querySelectorAll('.stcf-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
        });
    });

    // 为所有编辑列表头部自动注入「全部展开 / 全部折叠」快捷小按钮
    const editorHostIds = [
        'stcf-gauges-editor',
        'stcf-classes-editor',
        'stcf-allies-editor',
        'stcf-enemies-editor',
        'stcf-skills-editor',
        'stcf-equipments-editor',
        'stcf-items-editor',
        'stcf-statuses-editor',
        'stcf-rules-editor',
    ];
    for (const hostId of editorHostIds) {
        const host = container.querySelector(`#${hostId}`);
        const header = host?.parentElement?.querySelector('.stcf-section-header');
        if (!host || !header) continue;
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'menu_button stcf-sm-btn';
        toggleBtn.textContent = '↕ 展开/折叠';
        toggleBtn.title = '一键展开或折叠本列表中的所有卡片';
        toggleBtn.addEventListener('click', () => {
            const cards = [...host.querySelectorAll('details.stcf-fold')];
            const anyClosed = cards.some(d => !d.open);
            cards.forEach(d => { d.open = anyClosed; });
        });
        header.appendChild(toggleBtn);
    }

    const elProfileBanner = container.querySelector('#stcf-profile-banner');
    const elIoStatus = container.querySelector('#stcf-io-status');
    function setIoStatus(msg, isError = false) {
        if (!elIoStatus) return;
        elIoStatus.textContent = msg;
        elIoStatus.classList.toggle('stcf-text-error', isError);
    }

    /** 刚新增或正在编辑的卡片键（用于重绘后自动展开指定卡片，其余保持默认折叠） */
    let forceOpenKey = '';

    function commitChange(reRenderLists = false, openKey = '') {
        if (openKey) forceOpenKey = openKey;
        const cfg = deps.getConfig();
        saveConfig(cfg);
        deps.onConfigChanged();
        if (reRenderLists) {
            renderAll(true);
            forceOpenKey = '';
        }
    }

    // =========================================================================
    // 一、基础设置与导入导出绑定
    // =========================================================================
    const elEnabled = container.querySelector('#stcf-set-enabled');
    const elPerChar = container.querySelector('#stcf-set-per-char');
    const elMvuSync = container.querySelector('#stcf-set-mvu-sync');
    const elMvuWriteBack = container.querySelector('#stcf-set-mvu-writeback');
    const elMvuInherit = container.querySelector('#stcf-set-mvu-inherit');
    const elMvuStatuses = container.querySelector('#stcf-set-mvu-statuses');
    const elListenAi = container.querySelector('#stcf-set-listen-ai');
    const elSyncParty = container.querySelector('#stcf-set-sync-party');
    const elSyncBattle = container.querySelector('#stcf-set-sync-battle');
    const elSyncCatalog = container.querySelector('#stcf-set-sync-catalog');
    const elAuthoringMode = container.querySelector('#stcf-set-authoring-mode');
    const elHudCollapsed = container.querySelector('#stcf-set-hud-collapsed');
    const elAutoEndTurn = container.querySelector('#stcf-set-auto-end-turn');
    const elOutputMode = container.querySelector('#stcf-set-output-mode');
    const elFillStrategy = container.querySelector('#stcf-set-fill-strategy');
    const elLogHeader = container.querySelector('#stcf-set-log-header');
    const elGaugesEditor = container.querySelector('#stcf-gauges-editor');
    const elPasteJson = container.querySelector('#stcf-paste-json');

    elEnabled.addEventListener('change', () => { deps.getConfig().general.enabled = elEnabled.checked; commitChange(); });
    elPerChar.addEventListener('change', async () => {
        deps.getConfig().general.usePerCharacterConfig = elPerChar.checked;
        saveConfig(deps.getConfig());
        const reloaded = await loadConfig();
        deps.setConfig(reloaded);
        renderAll(false);
        deps.onConfigChanged();
        setIoStatus(elPerChar.checked ? '✅ 已开启按角色卡独立保存方案' : '✅ 已切换为全局共用方案');
    });
    elMvuSync.addEventListener('change', () => { deps.getConfig().general.mvuSyncEnabled = elMvuSync.checked; commitChange(); });
    elMvuWriteBack.addEventListener('change', () => { deps.getConfig().general.mvuWriteBack = elMvuWriteBack.checked; commitChange(); });
    elMvuInherit.addEventListener('change', () => { deps.getConfig().general.mvuInheritVitalsOnStart = elMvuInherit.checked; commitChange(); });
    elMvuStatuses.addEventListener('change', () => { deps.getConfig().general.mvuSyncStatuses = elMvuStatuses.checked; commitChange(); });
    elListenAi.addEventListener('change', () => { deps.getConfig().general.listenAiEvents = elListenAi.checked; commitChange(); });
    elSyncParty.addEventListener('change', () => { deps.getConfig().general.syncPartyToAi = elSyncParty.checked; commitChange(); });
    elSyncBattle.addEventListener('change', () => { deps.getConfig().general.syncBattleToAi = elSyncBattle.checked; commitChange(); });
    elSyncCatalog.addEventListener('change', () => { deps.getConfig().general.syncCatalogToAi = elSyncCatalog.checked; commitChange(); });
    elAuthoringMode?.addEventListener('change', () => {
        deps.getConfig().general.authoringMode = elAuthoringMode.checked;
        commitChange();
        setIoStatus(elAuthoringMode.checked
            ? '✍️ 已开启创作模式：写卡助手现可直接看见当前全部技能/状态/装备/敌人完整配置！'
            : '🎮 已关闭创作模式：已切回日常游玩省 Token 模式');
    });
    elHudCollapsed.addEventListener('change', () => { deps.getConfig().general.hudStartCollapsed = elHudCollapsed.checked; commitChange(); });
    elAutoEndTurn.addEventListener('change', () => { deps.getConfig().general.autoEndPlayerTurn = elAutoEndTurn.checked; commitChange(); });
    elOutputMode.addEventListener('change', () => { deps.getConfig().general.outputMode = elOutputMode.value; commitChange(); });
    elFillStrategy.addEventListener('change', () => { deps.getConfig().general.inputFillStrategy = elFillStrategy.value; commitChange(); });
    elLogHeader.addEventListener('input', () => { deps.getConfig().general.logHeaderTemplate = elLogHeader.value; commitChange(); });

    // =========================================================================
    // 一点二、动态自定义特殊状态槽编辑器（v1.8：不限数量，支持自定义范围与增删）
    // =========================================================================
    const GAUGE_PALETTE = ['#e67e22', '#9b59b6', '#1abc9c', '#3498db', '#e74c3c', '#f1c40f', '#ec4899'];

    function renameGaugeKeyInMap(map, oldId, newId) {
        if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, oldId)) return;
        map[newId] = map[oldId];
        delete map[oldId];
    }

    function renameGaugeAcrossConfig(cfg, oldId, newId) {
        if (!oldId || !newId || oldId === newId) return false;
        if (cfg.gauges?.[newId]) return false;
        const nextGauges = {};
        for (const [k, v] of Object.entries(cfg.gauges || {})) {
            if (k === oldId) nextGauges[newId] = { ...v, id: newId };
            else nextGauges[k] = v;
        }
        cfg.gauges = nextGauges;
        for (const u of [...(cfg.allies || []), ...(cfg.enemies || [])]) {
            renameGaugeKeyInMap(u.initialGauges, oldId, newId);
        }
        for (const sk of cfg.skills || []) {
            renameGaugeKeyInMap(sk.selfGaugeChanges, oldId, newId);
            renameGaugeKeyInMap(sk.targetGaugeChanges, oldId, newId);
            if (sk.requiredGaugeId === oldId) sk.requiredGaugeId = newId;
            for (const ef of sk.extraEffects || []) {
                renameGaugeKeyInMap(ef?.gaugeChanges, oldId, newId);
            }
            for (const pg of sk.prereqGroups || []) {
                for (const pc of pg?.conditions || []) {
                    if (pc && pc.gaugeId === oldId) pc.gaugeId = newId;
                }
            }
        }
        for (const it of cfg.items || []) {
            renameGaugeKeyInMap(it.targetGaugeChanges, oldId, newId);
        }
        for (const st of cfg.statuses || []) {
            renameGaugeKeyInMap(st.perTurnGauges, oldId, newId);
            for (const rule of st.gaugeChangeMultipliers || []) {
                if (rule && rule.gaugeId === oldId) rule.gaugeId = newId;
            }
        }
        for (const r of cfg.triggerRules || []) {
            if (r.conditionType === oldId) r.conditionType = newId;
            if (r.resetGaugeOnTrigger === oldId) r.resetGaugeOnTrigger = newId;
        }
        return true;
    }

    container.querySelector('#stcf-btn-add-gauge')?.addEventListener('click', () => {
        const cfg = deps.getConfig();
        if (!cfg.gauges || typeof cfg.gauges !== 'object') cfg.gauges = {};
        const existingKeys = Object.keys(cfg.gauges);
        let idx = existingKeys.length + 1;
        let newId = `gauge_${idx}`;
        while (cfg.gauges[newId]) newId = `gauge_${++idx}`;
        cfg.gauges[newId] = {
            id: newId,
            name: `自定义槽${idx}`,
            color: GAUGE_PALETTE[existingKeys.length % GAUGE_PALETTE.length],
            min: 0,
            max: 100,
            perTurnChange: 0,
            perTurnScope: 'all',
        };
        commitChange(true, `gg:${newId}`);
    });

    function renderGaugesList(preserveOpen) {
        if (!elGaugesEditor) return;
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elGaugesEditor) : new Set();
        const entries = getGaugeEntries(cfg);

        if (entries.length === 0) {
            elGaugesEditor.innerHTML = '<div class="stcf-muted">当前无特殊状态槽，可点击右上角「➕ 新增状态槽」添加。</div>';
            return;
        }

        elGaugesEditor.innerHTML = entries.map(g => {
            const cardKey = `gg:${g.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const tickBadge = g.perTurnChange ? ` · 每回合${g.perTurnChange > 0 ? '+' : ''}${g.perTurnChange}` : '';
            return `
                <details class="stcf-item-card stcf-fold" data-gauge-id="${escapeHtml(g.id)}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${escapeHtml(g.color)};margin-right:4px;"></span>
                            <strong>${escapeHtml(g.name)}</strong>
                            <small class="stcf-muted">(${g.min}~${g.max}${tickBadge})</small>
                        </span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(g.id)}</span>
                            <button type="button" class="stcf-del-btn" data-gauge-action="delete" title="删除此状态槽">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>槽位 ID（公式变量名）</span><input type="text" class="text_pole" data-gauge-field="id" value="${escapeHtml(g.id)}" placeholder="如 sanity / holy"></label>
                            <label class="stcf-mini-field"><span>显示名称</span><input type="text" class="text_pole" data-gauge-field="name" value="${escapeHtml(g.name)}" placeholder="如 理智值"></label>
                            <label class="stcf-mini-field"><span>进度条颜色</span><input type="color" class="stcf-color-input" data-gauge-field="color" value="${escapeHtml(g.color)}"></label>
                        </div>
                        <div class="stcf-grid-4">
                            <label class="stcf-mini-field"><span>最小值 min</span><input type="number" class="text_pole" data-gauge-field="min" value="${g.min}"></label>
                            <label class="stcf-mini-field"><span>最大值 max</span><input type="number" class="text_pole" data-gauge-field="max" value="${g.max}"></label>
                            <label class="stcf-mini-field"><span>每回合增减</span><input type="number" class="text_pole" data-gauge-field="perTurnChange" value="${g.perTurnChange}"></label>
                            <label class="stcf-mini-field"><span>自动变化阵营</span>
                                <select class="text_pole" data-gauge-field="perTurnScope">
                                    <option value="all" ${g.perTurnScope === 'all' ? 'selected' : ''}>敌我全员</option>
                                    <option value="allies" ${g.perTurnScope === 'allies' ? 'selected' : ''}>仅我方</option>
                                    <option value="enemies" ${g.perTurnScope === 'enemies' ? 'selected' : ''}>仅敌方</option>
                                </select>
                            </label>
                        </div>
                    </div>
                </details>
            `;
        }).join('');
    }

    elGaugesEditor?.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        const field = e.target.dataset.gaugeField;
        if (!card || !field || field === 'id') return;
        const cfg = deps.getConfig();
        const gid = card.dataset.gaugeId;
        const gObj = cfg.gauges?.[gid];
        if (!gObj) return;
        if (field === 'min' || field === 'max' || field === 'perTurnChange') {
            gObj[field] = Math.round(Number(e.target.value) || 0);
            if (gObj.max <= gObj.min) gObj.max = gObj.min + 1;
        } else {
            gObj[field] = e.target.value || (field === 'name' ? gid : '#3498db');
        }
        commitChange();
    });

    elGaugesEditor?.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        const field = e.target.dataset.gaugeField;
        if (!card || !field) return;
        const cfg = deps.getConfig();
        const gid = card.dataset.gaugeId;
        const gObj = cfg.gauges?.[gid];
        if (!gObj) return;
        if (field === 'id') {
            const nextId = sanitizeGaugeId(e.target.value, gid);
            if (nextId !== gid) {
                if (cfg.gauges[nextId]) {
                    window.alert(`状态槽 ID「${nextId}」已存在，请换一个英文 ID。`);
                    e.target.value = gid;
                    return;
                }
                renameGaugeAcrossConfig(cfg, gid, nextId);
                commitChange(true, `gg:${nextId}`);
                return;
            }
            e.target.value = gid;
            return;
        }
        if (field === 'perTurnScope') {
            gObj.perTurnScope = e.target.value;
            commitChange();
        } else if (field === 'name' || field === 'min' || field === 'max' || field === 'color') {
            commitChange(true);
        }
    });

    elGaugesEditor?.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-gauge-action="delete"]');
        if (!delBtn) return;
        e.preventDefault();
        const card = delBtn.closest('.stcf-item-card');
        const gid = card?.dataset.gaugeId;
        const cfg = deps.getConfig();
        if (!gid || !cfg.gauges?.[gid]) return;
        if (!window.confirm(`确定要删除状态槽「${cfg.gauges[gid].name} (${gid})」吗？`)) return;
        delete cfg.gauges[gid];
        commitChange(true);
    });

    // 内置西幻扩展包一键载入
    async function handleLoadWesternFantasy(mode) {
        if (mode === 'replace' && !window.confirm('确定要用「西幻」完整开团预设覆盖当前角色卡方案吗？（若想保留现有内容，请点增量合并）')) {
            return;
        }
        try {
            const { config: nextCfg, summary } = await loadBuiltinPresetPack('western_fantasy_pack.json', mode, deps.getConfig());
            deps.setConfig(nextCfg);
            renderAll(false);
            deps.onConfigChanged();
            setIoStatus(`🏰 已载入西幻扩展包：${summary}`);
        } catch (err) {
            setIoStatus(`❌ 载入西幻包失败：${err.message}`, true);
        }
    }
    container.querySelector('#stcf-btn-load-wf-merge')?.addEventListener('click', () => handleLoadWesternFantasy('merge'));
    container.querySelector('#stcf-btn-load-wf-replace')?.addEventListener('click', () => handleLoadWesternFantasy('replace'));

    // 粘贴 JSON 导入
    async function handlePasteImport(mode) {
        const text = elPasteJson.value.trim();
        if (!text) { setIoStatus('⚠️ 请先在文本框里粘贴 JSON 内容。', true); return; }
        try {
            const { config: nextCfg, summary } = await importConfigFromJsonText(text, mode, deps.getConfig());
            deps.setConfig(nextCfg);
            renderAll(false);
            deps.onConfigChanged();
            elPasteJson.value = '';
            setIoStatus(`✅ ${summary}`);
        } catch (err) {
            setIoStatus(`❌ 导入失败：${err.message}`, true);
        }
    }
    container.querySelector('#stcf-btn-merge-paste').addEventListener('click', () => handlePasteImport('patch'));
    container.querySelector('#stcf-btn-addonly-paste')?.addEventListener('click', () => handlePasteImport('add_only'));
    container.querySelector('#stcf-btn-replace-paste').addEventListener('click', () => {
        if (!window.confirm('完整覆盖会替换当前方案的全部内容，确定继续吗？')) return;
        handlePasteImport('replace');
    });
    container.querySelector('#stcf-btn-copy-config')?.addEventListener('click', async () => {
        const text = JSON.stringify(deps.getConfig(), null, 2);
        try {
            await navigator.clipboard.writeText(text);
            setIoStatus(`📋 已复制当前完整配置 JSON（共 ${text.length} 字），可直接发给写卡助手！`);
        } catch {
            elPasteJson.value = text;
            elPasteJson.select();
            setIoStatus('📋 已将当前完整配置填入文本框，请按 Ctrl+C 复制。');
        }
    });

    // 文件导出/导入
    container.querySelector('#stcf-btn-export-json').addEventListener('click', () => {
        exportConfigAsJson(deps.getConfig());
        setIoStatus('✅ 已触发 JSON 文件下载。');
    });

    let pendingFileMode = 'replace';
    const elFileInput = container.querySelector('#stcf-file-import-json');
    container.querySelector('#stcf-btn-import-merge-file').addEventListener('click', () => {
        pendingFileMode = 'merge'; elFileInput.value = ''; elFileInput.click();
    });
    container.querySelector('#stcf-btn-import-json').addEventListener('click', () => {
        pendingFileMode = 'replace'; elFileInput.value = ''; elFileInput.click();
    });
    elFileInput.addEventListener('change', async () => {
        const file = elFileInput.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const { config: imported, summary } = await importConfigFromJsonText(text, pendingFileMode, deps.getConfig());
            deps.setConfig(imported);
            renderAll(false);
            deps.onConfigChanged();
            setIoStatus(`✅ ${file.name}：${summary}`);
        } catch (err) {
            setIoStatus(`❌ 导入失败：${err.message}`, true);
        }
    });

    container.querySelector('#stcf-btn-save-global').addEventListener('click', () => {
        saveAsGlobalTemplate(deps.getConfig());
        setIoStatus('⭐ 已将当前配置设为新角色卡的默认模板。');
    });
    container.querySelector('#stcf-btn-reset-default').addEventListener('click', async () => {
        if (!window.confirm('确定要恢复出厂默认配置吗？当前方案未导出的自定义内容将被覆盖。')) return;
        const fresh = await resetConfigToDefaults();
        deps.setConfig(fresh);
        renderAll(false);
        deps.onConfigChanged();
        setIoStatus('✅ 已恢复为 default_config.json 默认配置。');
    });

    // =========================================================================
    // 公共辅助渲染函数
    // =========================================================================
    function collectAllWorldviews(cfg) {
        const set = new Set(['通用']);
        for (const c of cfg.classTrees || []) if (c.worldview) set.add(c.worldview);
        for (const s of cfg.skills || []) if (s.worldview) set.add(s.worldview);
        for (const w of cfg.progression?.enabledWorldviews || []) if (w) set.add(w);
        return [...set];
    }

    function buildStatusSelectOptions(cfg, selectedId, emptyLabel = '无') {
        return [
            `<option value="">${emptyLabel}</option>`,
            ...(cfg.statuses || []).map(st =>
                `<option value="${escapeHtml(st.id)}" ${selectedId === st.id ? 'selected' : ''}>${escapeHtml(st.icon)} ${escapeHtml(st.name)} (${escapeHtml(st.id)})</option>`
            ),
        ].join('');
    }

    function buildSkillSelectOptions(cfg, selectedId, emptyLabel = '无') {
        return [
            `<option value="">${emptyLabel}</option>`,
            ...(cfg.skills || []).map(sk =>
                `<option value="${escapeHtml(sk.id)}" ${selectedId === sk.id ? 'selected' : ''}>[${escapeHtml(sk.worldview)}] ${escapeHtml(sk.name)} (${escapeHtml(sk.id)})</option>`
            ),
        ].join('');
    }

    function renderStatusCheckChips(cfg, selectedIds, attrName) {
        const set = new Set(selectedIds || []);
        return (cfg.statuses || []).map(st => `
            <label class="stcf-chip-check">
                <input type="checkbox" ${attrName}="${escapeHtml(st.id)}" ${set.has(st.id) ? 'checked' : ''}>
                <span>${escapeHtml(st.icon)} ${escapeHtml(st.name)}</span>
            </label>
        `).join('') || '<span class="stcf-muted">暂无状态</span>';
    }

    // =========================================================================
    // 一点五、职业树、世界观开关与自由属性点设置
    // =========================================================================
    const elProgEnabled = container.querySelector('#stcf-set-prog-enabled');
    const elPtsPerLv = container.querySelector('#stcf-set-pts-per-lv');
    const elGainVit = container.querySelector('#stcf-set-gain-vit');
    const elGainStr = container.querySelector('#stcf-set-gain-str');
    const elGainSpiMag = container.querySelector('#stcf-set-gain-spimag');
    const elGainSpiMp = container.querySelector('#stcf-set-gain-spimp');
    const elGainDef = container.querySelector('#stcf-set-gain-def');
    const elGainMdef = container.querySelector('#stcf-set-gain-mdef');
    const elWorldviewsPicker = container.querySelector('#stcf-worldviews-picker');
    const elClassesEditor = container.querySelector('#stcf-classes-editor');

    elProgEnabled.addEventListener('change', () => { deps.getConfig().progression.enabled = elProgEnabled.checked; commitChange(); });
    elPtsPerLv.addEventListener('input', () => { deps.getConfig().progression.pointsPerLevel = Math.max(0, Math.round(Number(elPtsPerLv.value) || 0)); commitChange(); });
    elGainVit.addEventListener('input', () => { deps.getConfig().progression.statGains.vitHp = Math.max(1, Math.round(Number(elGainVit.value) || 15)); commitChange(); });
    elGainStr.addEventListener('input', () => { deps.getConfig().progression.statGains.strAtk = Math.max(1, Math.round(Number(elGainStr.value) || 2)); commitChange(); });
    elGainSpiMag.addEventListener('input', () => { deps.getConfig().progression.statGains.spiMag = Math.max(1, Math.round(Number(elGainSpiMag.value) || 2)); commitChange(); });
    elGainSpiMp.addEventListener('input', () => { deps.getConfig().progression.statGains.spiMp = Math.max(0, Math.round(Number(elGainSpiMp.value) || 8)); commitChange(); });
    elGainDef.addEventListener('input', () => { deps.getConfig().progression.statGains.defPhys = Math.max(1, Math.round(Number(elGainDef.value) || 2)); commitChange(); });
    elGainMdef.addEventListener('input', () => { deps.getConfig().progression.statGains.mdefMag = Math.max(1, Math.round(Number(elGainMdef.value) || 2)); commitChange(); });

    container.querySelector('#stcf-btn-add-class').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('class', cfg.classTrees);
        cfg.classTrees.push({
            id,
            worldview: '西幻',
            name: `新职业_${cfg.classTrees.length + 1}`,
            description: '自定义职业简介',
            parentClassId: '',
            requiredLevel: 1,
            bonusHp: 10, bonusMp: 0, bonusAtk: 2, bonusSpi: 2, bonusDef: 1, bonusMdef: 1,
            unlockSkills: [],
        });
        commitChange(true, `cls:${id}`);
    });

    function renderWorldviewsPicker() {
        const cfg = deps.getConfig();
        const allWvs = collectAllWorldviews(cfg);
        const enabledSet = new Set(cfg.progression?.enabledWorldviews || []);
        elWorldviewsPicker.innerHTML = allWvs.map(wv => `
            <label class="stcf-chip-check">
                <input type="checkbox" data-toggle-wv="${escapeHtml(wv)}" ${enabledSet.has(wv) ? 'checked' : ''}>
                <span>🌍 ${escapeHtml(wv)}</span>
            </label>
        `).join('');
    }

    elWorldviewsPicker.addEventListener('change', (e) => {
        if (!e.target.dataset.toggleWv) return;
        const cfg = deps.getConfig();
        const set = new Set(cfg.progression.enabledWorldviews || []);
        if (e.target.checked) set.add(e.target.dataset.toggleWv);
        else set.delete(e.target.dataset.toggleWv);
        cfg.progression.enabledWorldviews = [...set];
        commitChange();
    });

    function renderClassesList(preserveOpen) {
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elClassesEditor) : new Set();

        elClassesEditor.innerHTML = (cfg.classTrees || []).map((cls, idx) => {
            const cardKey = `cls:${cls.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const parentObj = cls.parentClassId ? (cfg.classTrees || []).find(x => x.id === cls.parentClassId) : null;
            const parentOpts = [
                '<option value="">无（基础起始职业）</option>',
                ...(cfg.classTrees || [])
                    .filter(other => other.id !== cls.id)
                    .map(other => `<option value="${escapeHtml(other.id)}" ${cls.parentClassId === other.id ? 'selected' : ''}>[${escapeHtml(other.worldview)}] ${escapeHtml(other.name)}</option>`),
            ].join('');

            const unlockRows = (cls.unlockSkills || []).map((u, uIdx) => `
                <div class="stcf-unlock-row" data-unlock-index="${uIdx}">
                    <span class="stcf-muted">Lv.</span>
                    <input type="number" min="1" class="text_pole" data-unlock-field="level" value="${u.level}">
                    <select class="text_pole" data-unlock-field="skillId">${buildSkillSelectOptions(cfg, u.skillId, '选择技能...')}</select>
                    <button type="button" class="stcf-del-btn" data-unlock-action="remove" title="移除该解锁技能">✖</button>
                </div>
            `).join('');

            return `
                <details class="stcf-item-card stcf-fold" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">🎓 [${escapeHtml(cls.worldview)}] ${parentObj ? `${escapeHtml(parentObj.name)}→` : ''}<strong>${escapeHtml(cls.name)}</strong> <small class="stcf-muted">Lv.${cls.requiredLevel} · ${(cls.unlockSkills || []).length}技</small></span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(cls.id)}</span>
                            <button type="button" class="stcf-del-btn" data-action="delete" title="删除职业">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="name" value="${escapeHtml(cls.name)}" placeholder="职业名称">
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>世界观大组</span><input type="text" class="text_pole" data-field="worldview" value="${escapeHtml(cls.worldview)}"></label>
                            <label class="stcf-mini-field"><span>前置父职业</span><select class="text_pole" data-field="parentClassId">${parentOpts}</select></label>
                            <label class="stcf-mini-field"><span>转职等级</span><input type="number" min="1" class="text_pole" data-field="requiredLevel" value="${cls.requiredLevel}"></label>
                        </div>
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="description" value="${escapeHtml(cls.description)}" placeholder="职业定位简述">
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>职业+HP</span><input type="number" class="text_pole" data-field="bonusHp" value="${cls.bonusHp}"></label>
                            <label class="stcf-mini-field"><span>职业+MP</span><input type="number" class="text_pole" data-field="bonusMp" value="${cls.bonusMp}"></label>
                            <label class="stcf-mini-field"><span>职业+物攻</span><input type="number" class="text_pole" data-field="bonusAtk" value="${cls.bonusAtk}"></label>
                            <label class="stcf-mini-field"><span>职业+精神</span><input type="number" class="text_pole" data-field="bonusSpi" value="${cls.bonusSpi}"></label>
                            <label class="stcf-mini-field"><span>职业+物防</span><input type="number" class="text_pole" data-field="bonusDef" value="${cls.bonusDef}"></label>
                            <label class="stcf-mini-field"><span>职业+法抗</span><input type="number" class="text_pole" data-field="bonusMdef" value="${cls.bonusMdef}"></label>
                        </div>
                        <details class="stcf-sub-fold">
                            <summary>🎓 等级解锁技能列表（已配 ${(cls.unlockSkills || []).length} 项）</summary>
                            <div class="stcf-sub-body">
                                <button type="button" class="menu_button stcf-sm-btn" data-action="add_unlock" style="margin-bottom:6px;">➕ 添加解锁技能</button>
                                ${unlockRows || '<div class="stcf-muted">暂未配置职业解锁技能</div>'}
                            </div>
                        </details>
                    </div>
                </details>
            `;
        }).join('');
    }

    elClassesEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const cls = deps.getConfig().classTrees[Number(card.dataset.index)];
        if (!cls) return;
        if (e.target.dataset.unlockField === 'level') {
            const row = e.target.closest('.stcf-unlock-row');
            const u = cls.unlockSkills[Number(row.dataset.unlockIndex)];
            if (u) { u.level = Math.max(1, Math.round(Number(e.target.value) || 1)); commitChange(); }
            return;
        }
        if (!e.target.dataset.field) return;
        cls[e.target.dataset.field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange();
    });
    elClassesEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const cls = deps.getConfig().classTrees[Number(card.dataset.index)];
        if (!cls) return;
        if (e.target.dataset.unlockField) {
            const row = e.target.closest('.stcf-unlock-row');
            const u = cls.unlockSkills[Number(row.dataset.unlockIndex)];
            if (u) {
                u[e.target.dataset.unlockField] = e.target.type === 'number' ? Math.max(1, Number(e.target.value) || 1) : e.target.value;
                commitChange();
            }
            return;
        }
        if (!e.target.dataset.field) return;
        const field = e.target.dataset.field;
        cls[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange(field === 'worldview' || field === 'name' || field === 'parentClassId');
    });
    elClassesEditor.addEventListener('click', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const idx = Number(card.dataset.index);
        const cls = deps.getConfig().classTrees[idx];
        if (!cls) return;
        if (e.target.closest('[data-action="delete"]')) {
            e.preventDefault();
            deps.getConfig().classTrees.splice(idx, 1);
            commitChange(true);
        } else if (e.target.closest('[data-action="add_unlock"]')) {
            const firstSk = deps.getConfig().skills[0]?.id || '';
            cls.unlockSkills.push({ skillId: firstSk, level: cls.requiredLevel || 1 });
            commitChange(true);
        } else if (e.target.closest('[data-unlock-action="remove"]')) {
            const row = e.target.closest('.stcf-unlock-row');
            cls.unlockSkills.splice(Number(row.dataset.unlockIndex), 1);
            commitChange(true);
        }
    });

    // =========================================================================
    // 二、参战角色（我方 1~4 / 敌方图鉴，默认折叠）
    // =========================================================================
    const elAlliesEditor = container.querySelector('#stcf-allies-editor');
    const elEnemiesEditor = container.querySelector('#stcf-enemies-editor');

    function addUnit(side) {
        const cfg = deps.getConfig();
        const list = side === 'ally' ? cfg.allies : cfg.enemies;
        if (side === 'ally' && list.length >= MAX_UNITS_PER_SIDE) {
            window.alert(`我方最多支持 ${MAX_UNITS_PER_SIDE} 名参战角色（最多 ${MAX_UNITS_PER_SIDE}v${MAX_UNITS_PER_SIDE}）。`);
            return;
        }
        const id = makeUniqueId(side, list);
        list.push({
            id,
            enabled: side === 'ally' ? true : list.filter(x => x.enabled).length < MAX_UNITS_PER_SIDE,
            name: side === 'ally' ? `我方角色${list.length + 1}` : `敌方目标${list.length + 1}`,
            description: side === 'ally' ? '我方参战成员简短定位说明' : '敌方单位外观特征与战斗风格简述',
            level: 1,
            classId: side === 'ally' ? (cfg.classTrees?.[0]?.id || '') : '',
            freePoints: side === 'ally' ? (cfg.progression?.pointsPerLevel ?? 3) : 0,
            allocated: { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 },
            maxHp: 100, maxMp: 50, atk: 20, spi: 15, def: 8, mdef: 6,
            initialGaugeA: 0, initialGaugeB: 0,
            skillIds: cfg.skills[0] ? [cfg.skills[0].id] : [],
            equipmentIds: [],
            aiStrategy: 'priority',
            aiTargetMode: 'target_first',
            autoControl: false,
        });
        commitChange(true, `${side}:${id}`);
    }
    container.querySelector('#stcf-btn-add-ally').addEventListener('click', () => addUnit('ally'));
    container.querySelector('#stcf-btn-add-enemy').addEventListener('click', () => addUnit('enemy'));

    function renderUnitsList(side, hostEl, preserveOpen) {
        const cfg = deps.getConfig();
        const list = side === 'ally' ? cfg.allies : cfg.enemies;
        const openSet = preserveOpen ? captureOpenCardKeys(hostEl) : new Set();
        const gaugeEntries = getGaugeEntries(cfg);

        hostEl.innerHTML = list.map((u, idx) => {
            const cardKey = `${side}:${u.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const clsName = (cfg.classTrees || []).find(c => c.id === u.classId)?.name || '';
            const initGaugesHtml = gaugeEntries.map(g => {
                const initVal = u.initialGauges?.[g.id] ?? (g.id === 'gauge_a' ? u.initialGaugeA : (g.id === 'gauge_b' ? u.initialGaugeB : g.min));
                return `<label class="stcf-mini-field"><span>初始${escapeHtml(g.name)}</span><input type="number" min="${g.min}" max="${g.max}" class="text_pole" data-unit-init-gauge="${escapeHtml(g.id)}" value="${initVal ?? g.min}"></label>`;
            }).join('');
            const poolLabelMap = { universal: '🌐', class: '🎓', monster: '👹' };
            const skillListForSide = side === 'ally'
                ? (cfg.skills || []).filter(sk => sk.poolType !== 'monster')
                : (cfg.skills || []);
            const skillChecks = skillListForSide.map(sk => `
                <label class="stcf-chip-check" title="[${escapeHtml(sk.worldview)}/${escapeHtml(sk.poolType)}] ${escapeHtml(sk.description)}">
                    <input type="checkbox" data-unit-skill="${escapeHtml(sk.id)}" ${(u.skillIds || []).includes(sk.id) ? 'checked' : ''}>
                    <span>${poolLabelMap[sk.poolType] || ''}${escapeHtml(sk.name)}</span>
                </label>
            `).join('');

            const equipChecks = (cfg.equipments || []).map(eq => `
                <label class="stcf-chip-check">
                    <input type="checkbox" data-unit-equip="${escapeHtml(eq.id)}" ${(u.equipmentIds || []).includes(eq.id) ? 'checked' : ''}>
                    <span>🛡️ ${escapeHtml(eq.name)}</span>
                </label>
            `).join('');

            const classOpts = [
                '<option value="">无职业</option>',
                ...(cfg.classTrees || []).map(c => `<option value="${escapeHtml(c.id)}" ${u.classId === c.id ? 'selected' : ''}>[${escapeHtml(c.worldview)}] ${escapeHtml(c.name)} (Lv.${c.requiredLevel})</option>`),
            ].join('');

            return `
                <details class="stcf-item-card stcf-fold" data-side="${side}" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            ${u.enabled ? '✅' : '⬜'} <strong>${escapeHtml(u.name)}</strong>
                            <small class="stcf-muted">${side === 'ally' ? `Lv.${u.level || 1}${clsName ? ` ${escapeHtml(clsName)}` : ''} · ` : ''}HP ${u.maxHp} · 攻${u.atk}/精${u.spi ?? 15}</small>
                        </span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(u.id)}</span>
                            ${list.length > 1 ? '<button type="button" class="stcf-del-btn" data-action="delete" title="删除角色">🗑️</button>' : ''}
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-item-head">
                            <label class="stcf-inline-check">
                                <input type="checkbox" data-field="enabled" ${u.enabled ? 'checked' : ''}>
                                <strong>出战</strong>
                            </label>
                            <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(u.name)}" placeholder="角色名称">
                        </div>
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="description" value="${escapeHtml(u.description || '')}" placeholder="一句话简约描述（会同步给剧情 AI 查阅）">
                        </div>
                        ${side === 'ally' ? `
                            <div class="stcf-grid-3">
                                <label class="stcf-mini-field"><span>当前等级 Lv</span><input type="number" min="1" class="text_pole" data-field="level" value="${u.level || 1}"></label>
                                <label class="stcf-mini-field"><span>所属职业</span><select class="text_pole" data-field="classId">${classOpts}</select></label>
                                <label class="stcf-mini-field"><span>未分配自由点</span><input type="number" min="0" class="text_pole" data-field="freePoints" value="${u.freePoints || 0}"></label>
                            </div>
                        ` : ''}
                        <div class="stcf-grid-4">
                            <label class="stcf-mini-field"><span>基础 HP</span><input type="number" min="1" class="text_pole" data-field="maxHp" value="${u.maxHp}"></label>
                            <label class="stcf-mini-field"><span>基础 MP</span><input type="number" min="0" class="text_pole" data-field="maxMp" value="${u.maxMp}"></label>
                            <label class="stcf-mini-field"><span>物理攻击 ATK</span><input type="number" min="0" class="text_pole" data-field="atk" value="${u.atk}"></label>
                            <label class="stcf-mini-field"><span>精神法攻 SPI</span><input type="number" min="0" class="text_pole" data-field="spi" value="${u.spi ?? 15}"></label>
                            <label class="stcf-mini-field"><span>物理防御 DEF</span><input type="number" min="0" class="text_pole" data-field="def" value="${u.def}"></label>
                            <label class="stcf-mini-field"><span>法术抗性 MDEF</span><input type="number" min="0" class="text_pole" data-field="mdef" value="${u.mdef ?? 5}"></label>
                            ${initGaugesHtml}
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>AI 选目标模式</span>
                                <select class="text_pole" data-field="aiTargetMode">
                                    <option value="target_first" ${u.aiTargetMode !== 'skill_first' && u.aiTargetMode !== 'lowest_hp' ? 'selected' : ''}>分散缠斗(先随机选人再出招·推荐小怪)</option>
                                    <option value="skill_first" ${u.aiTargetMode === 'skill_first' ? 'selected' : ''}>全图集火(先选大招再找破甲目标·适合Boss)</option>
                                    <option value="lowest_hp" ${u.aiTargetMode === 'lowest_hp' ? 'selected' : ''}>残血斩杀(优先锁定HP%最低目标)</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>AI 出招策略</span>
                                <select class="text_pole" data-field="aiStrategy">
                                    <option value="priority" ${u.aiStrategy !== 'weighted' && u.aiStrategy !== 'random' ? 'selected' : ''}>高优先级优先(推荐)</option>
                                    <option value="weighted" ${u.aiStrategy === 'weighted' ? 'selected' : ''}>按优先级权重随机</option>
                                    <option value="random" ${u.aiStrategy === 'random' ? 'selected' : ''}>完全随机</option>
                                </select>
                            </label>
                            ${side === 'ally' ? `
                                <label class="stcf-inline-check" style="margin-top:16px;">
                                    <input type="checkbox" data-field="autoControl" ${u.autoControl ? 'checked' : ''}>
                                    <span>🤖 自动托管 AI</span>
                                </label>
                            ` : '<div></div>'}
                        </div>
                        <details class="stcf-sub-fold">
                            <summary>⚔️ 手动/通用技能勾选（已选 ${(u.skillIds || []).length} 项）</summary>
                            <div class="stcf-sub-body stcf-chips-wrap">${skillChecks || '<span class="stcf-muted">暂无技能</span>'}</div>
                        </details>
                        <details class="stcf-sub-fold">
                            <summary>🛡️ 初始穿戴装备勾选（已选 ${(u.equipmentIds || []).length} 件）</summary>
                            <div class="stcf-sub-body stcf-chips-wrap">${equipChecks || '<span class="stcf-muted">暂无装备</span>'}</div>
                        </details>
                    </div>
                </details>
            `;
        }).join('');
    }

    function bindUnitsEvents(hostEl) {
        hostEl.addEventListener('input', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card) return;
            const cfg = deps.getConfig();
            const list = card.dataset.side === 'ally' ? cfg.allies : cfg.enemies;
            const unit = list[Number(card.dataset.index)];
            if (!unit) return;
            if (e.target.dataset.unitInitGauge) {
                const gid = e.target.dataset.unitInitGauge;
                const val = Math.round(Number(e.target.value) || 0);
                if (!unit.initialGauges || typeof unit.initialGauges !== 'object') unit.initialGauges = {};
                unit.initialGauges[gid] = val;
                if (gid === 'gauge_a') unit.initialGaugeA = val;
                if (gid === 'gauge_b') unit.initialGaugeB = val;
                commitChange();
                return;
            }
            if (!e.target.dataset.field || e.target.type === 'checkbox') return;
            unit[e.target.dataset.field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
            commitChange();
        });
        hostEl.addEventListener('change', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card) return;
            const cfg = deps.getConfig();
            const list = card.dataset.side === 'ally' ? cfg.allies : cfg.enemies;
            const unit = list[Number(card.dataset.index)];
            if (!unit) return;

            if (e.target.dataset.field === 'enabled') {
                unit.enabled = e.target.checked;
                commitChange(true);
            } else if (e.target.dataset.field === 'autoControl') {
                unit.autoControl = e.target.checked;
                commitChange();
            } else if (e.target.dataset.field === 'aiStrategy' || e.target.dataset.field === 'aiTargetMode' || e.target.dataset.field === 'classId') {
                unit[e.target.dataset.field] = e.target.value;
                commitChange(e.target.dataset.field === 'classId');
            } else if (e.target.dataset.unitSkill) {
                const set = new Set(unit.skillIds || []);
                if (e.target.checked) set.add(e.target.dataset.unitSkill);
                else set.delete(e.target.dataset.unitSkill);
                unit.skillIds = [...set];
                commitChange();
            } else if (e.target.dataset.unitEquip) {
                const set = new Set(unit.equipmentIds || []);
                if (e.target.checked) set.add(e.target.dataset.unitEquip);
                else set.delete(e.target.dataset.unitEquip);
                unit.equipmentIds = [...set];
                commitChange();
            }
        });
        hostEl.addEventListener('click', (e) => {
            const delBtn = e.target.closest('[data-action="delete"]');
            if (!delBtn) return;
            e.preventDefault();
            const card = delBtn.closest('.stcf-item-card');
            const cfg = deps.getConfig();
            const list = card.dataset.side === 'ally' ? cfg.allies : cfg.enemies;
            if (list.length <= 1) return;
            list.splice(Number(card.dataset.index), 1);
            commitChange(true);
        });
    }
    bindUnitsEvents(elAlliesEditor);
    bindUnitsEvents(elEnemiesEditor);

    // =========================================================================
    // 三、技能库编辑器（默认折叠 + 多附加状态 + 卖血/吸血公式 + CD + 双前置状态）
    // =========================================================================
    const elSkillsEditor = container.querySelector('#stcf-skills-editor');
    const elFilterSkillWv = container.querySelector('#stcf-filter-skill-wv');
    const elFilterSkillPool = container.querySelector('#stcf-filter-skill-pool');
    const elSearchSkill = container.querySelector('#stcf-search-skill');
    let skillFilterWv = 'all';
    let skillFilterPool = 'all';
    let skillSearchKw = '';

    elFilterSkillWv.addEventListener('change', () => { skillFilterWv = elFilterSkillWv.value || 'all'; renderSkillsList(false); });
    elFilterSkillPool.addEventListener('change', () => { skillFilterPool = elFilterSkillPool.value || 'all'; renderSkillsList(false); });
    elSearchSkill?.addEventListener('input', () => { skillSearchKw = (elSearchSkill.value || '').trim().toLowerCase(); renderSkillsList(false); });

    container.querySelector('#stcf-btn-add-skill').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('skill', cfg.skills);
        cfg.skills.push({
            id,
            worldview: skillFilterWv !== 'all' ? skillFilterWv : '西幻',
            poolType: skillFilterPool !== 'all' ? skillFilterPool : 'universal',
            name: `新技能_${cfg.skills.length + 1}`,
            description: '自定义技能说明',
            mpCost: 10,
            cooldown: 0,
            targetType: 'single_enemy',
            effectType: 'damage',
            formula: 'max(1, atk * 1.2 - target_def * 0.4)',
            selfHpFormula: '0',
            selfGaugeAChange: 0,
            selfGaugeBChange: 0,
            targetGaugeAChange: 0,
            targetGaugeBChange: 0,
            selfGaugeChanges: {},
            targetGaugeChanges: {},
            extraEffects: [],
            applyStatuses: [],
            requiredTargetStatusIds: [],
            requiredSelfStatusIds: [],
            requiredGaugeId: '',
            requiredGaugeMin: 0,
            prereqGroupLogic: 'and',
            prereqGroups: [],
            hitRate: 100,
            critRate: 0,
            critMultiplier: 1.5,
            aiPriority: 10,
            aiHpBelowPercent: 100,
        });
        commitChange(true, `sk:${id}`);
    });

    function renderSkillsList(preserveOpen) {
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elSkillsEditor) : new Set();
        const gaugeEntries = getGaugeEntries(cfg);

        const allWvs = collectAllWorldviews(cfg);
        elFilterSkillWv.innerHTML = [
            '<option value="all">全部世界观</option>',
            ...allWvs.map(wv => `<option value="${escapeHtml(wv)}" ${skillFilterWv === wv ? 'selected' : ''}>🌍 ${escapeHtml(wv)}</option>`),
        ].join('');

        const entries = (cfg.skills || [])
            .map((sk, idx) => ({ sk, idx }))
            .filter(({ sk }) => {
                if (skillFilterWv !== 'all' && (sk.worldview || '通用') !== skillFilterWv) return false;
                if (skillFilterPool !== 'all' && (sk.poolType || 'universal') !== skillFilterPool) return false;
                if (skillSearchKw) {
                    const hay = `${sk.name || ''} ${sk.id || ''} ${sk.description || ''}`.toLowerCase();
                    if (!hay.includes(skillSearchKw)) return false;
                }
                return true;
            });

        elSkillsEditor.innerHTML = entries.map(({ sk, idx }) => {
            const cardKey = `sk:${sk.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const applyList = Array.isArray(sk.applyStatuses) ? sk.applyStatuses : [];
            const extraList = Array.isArray(sk.extraEffects) ? sk.extraEffects : [];
            const prereqGroups = Array.isArray(sk.prereqGroups) ? sk.prereqGroups : [];
            const reqTgtCount = (sk.requiredTargetStatusIds || []).length;
            const reqSelfCount = (sk.requiredSelfStatusIds || []).length;
            const cdTag = (sk.cooldown || 0) > 0 ? ` · CD${sk.cooldown}` : '';
            const extraTag = extraList.length > 0 ? ` · 🔀+${extraList.length}复合` : '';

            const prereqGroupsHtml = prereqGroups.map((pg, gIdx) => {
                const condRows = (pg.conditions || []).map((pc, cIdx) => {
                    const isStatusType = pc.type === 'has_status' || pc.type === 'not_has_status';
                    const stOpts = [
                        `<option value="_any" ${pc.statusId === '_any' ? 'selected' : ''}>任意状态</option>`,
                        `<option value="_any_restraint" ${pc.statusId === '_any_restraint' ? 'selected' : ''}>⛓️任意束缚状态</option>`,
                        ...(cfg.statuses || []).map(st => `<option value="${escapeHtml(st.id)}" ${pc.statusId === st.id ? 'selected' : ''}>${escapeHtml(st.icon)} ${escapeHtml(st.name)}</option>`),
                    ].join('');
                    const detailHtml = isStatusType ? `
                        <select class="text_pole" data-pc-field="statusId">${stOpts}</select>
                        <select class="text_pole" data-pc-field="sourceFilter" title="筛选该 Buff 的添加来源">
                            <option value="any" ${pc.sourceFilter === 'any' ? 'selected' : ''}>任意来源</option>
                            <option value="self" ${pc.sourceFilter === 'self' ? 'selected' : ''}>仅自己添加的</option>
                            <option value="other" ${pc.sourceFilter === 'other' ? 'selected' : ''}>仅别人添加的</option>
                            <option value="ally" ${pc.sourceFilter === 'ally' ? 'selected' : ''}>我方添加的</option>
                            <option value="enemy" ${pc.sourceFilter === 'enemy' ? 'selected' : ''}>敌方添加的</option>
                        </select>
                    ` : `
                        ${pc.type === 'gauge' ? `
                            <select class="text_pole" data-pc-field="gaugeId">
                                ${gaugeEntries.map(g => `<option value="${escapeHtml(g.id)}" ${pc.gaugeId === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
                            </select>
                        ` : '<span class="stcf-muted" style="align-self:center;">HP%</span>'}
                        <select class="text_pole" data-pc-field="operator" style="max-width:64px;">
                            <option value=">=" ${pc.operator === '>=' ? 'selected' : ''}>&gt;=</option>
                            <option value=">" ${pc.operator === '>' ? 'selected' : ''}>&gt;</option>
                            <option value="<=" ${pc.operator === '<=' ? 'selected' : ''}>&lt;=</option>
                            <option value="<" ${pc.operator === '<' ? 'selected' : ''}>&lt;</option>
                            <option value="==" ${pc.operator === '==' ? 'selected' : ''}>==</option>
                        </select>
                        <input type="number" class="text_pole stcf-pct-input" data-pc-field="value" value="${pc.value ?? 0}">
                    `;
                    return `
                        <div class="stcf-apply-row" data-pc-idx="${cIdx}" style="flex-wrap:wrap;margin-bottom:4px;">
                            <select class="text_pole" data-pc-field="subject" style="max-width:92px;">
                                <option value="target" ${pc.subject === 'target' ? 'selected' : ''}>目标</option>
                                <option value="self" ${pc.subject === 'self' ? 'selected' : ''}>自身</option>
                                <option value="any_ally" ${pc.subject === 'any_ally' ? 'selected' : ''}>任意友方</option>
                                <option value="any_enemy" ${pc.subject === 'any_enemy' ? 'selected' : ''}>任意敌方</option>
                            </select>
                            <select class="text_pole" data-pc-field="type" style="max-width:112px;">
                                <option value="has_status" ${pc.type === 'has_status' ? 'selected' : ''}>必须有状态</option>
                                <option value="not_has_status" ${pc.type === 'not_has_status' ? 'selected' : ''}>不可有状态</option>
                                <option value="gauge" ${pc.type === 'gauge' ? 'selected' : ''}>状态槽满足</option>
                                <option value="hp_percent" ${pc.type === 'hp_percent' ? 'selected' : ''}>HP%满足</option>
                            </select>
                            ${detailHtml}
                            <button type="button" class="stcf-del-btn" data-pg-action="del_cond" title="删除该条件">✖</button>
                        </div>
                    `;
                }).join('');

                return `
                    <div class="stcf-sub-card" data-pg-idx="${gIdx}" style="padding:6px;border:1px solid rgba(255,255,255,0.14);border-radius:6px;margin-bottom:6px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
                            <div style="display:flex;align-items:center;gap:6px;">
                                <strong>条件组 #${gIdx + 1}</strong>
                                <select class="text_pole" data-pg-logic="1" style="width:auto;padding:2px 6px;">
                                    <option value="and" ${pg.logic !== 'or' ? 'selected' : ''}>组内全部满足 (且 AND)</option>
                                    <option value="or" ${pg.logic === 'or' ? 'selected' : ''}>组内满足任一 (或 OR)</option>
                                </select>
                            </div>
                            <div style="display:flex;gap:4px;">
                                <button type="button" class="menu_button stcf-sm-btn" data-pg-action="add_cond">➕ 加条件</button>
                                <button type="button" class="stcf-del-btn" data-pg-action="del_group" title="删除条件组">🗑️</button>
                            </div>
                        </div>
                        ${condRows || '<div class="stcf-muted">请点击「➕ 加条件」添加前提条款</div>'}
                    </div>
                `;
            }).join('');

            const extraRowsHtml = extraList.map((ef, eIdx) => `
                <div class="stcf-sub-card" data-extra-index="${eIdx}" style="padding:6px;border:1px solid rgba(255,255,255,0.12);border-radius:6px;margin-bottom:6px;">
                    <div class="stcf-grid-3" style="margin-bottom:4px;">
                        <label class="stcf-mini-field"><span>附加目标</span>
                            <select class="text_pole" data-extra-field="targetType">
                                <option value="self" ${ef.targetType === 'self' ? 'selected' : ''}>仅自身</option>
                                <option value="same" ${ef.targetType === 'same' ? 'selected' : ''}>同主目标</option>
                                <option value="single_enemy" ${ef.targetType === 'single_enemy' ? 'selected' : ''}>单体敌方</option>
                                <option value="all_enemies" ${ef.targetType === 'all_enemies' ? 'selected' : ''}>全体敌方</option>
                                <option value="single_ally" ${ef.targetType === 'single_ally' ? 'selected' : ''}>单体友方</option>
                                <option value="all_allies" ${ef.targetType === 'all_allies' ? 'selected' : ''}>全体友方</option>
                            </select>
                        </label>
                        <label class="stcf-mini-field"><span>附加效果</span>
                            <select class="text_pole" data-extra-field="effectType">
                                <option value="heal" ${ef.effectType === 'heal' ? 'selected' : ''}>回复 HP</option>
                                <option value="mp_restore" ${ef.effectType === 'mp_restore' ? 'selected' : ''}>回复 MP</option>
                                <option value="damage" ${ef.effectType === 'damage' ? 'selected' : ''}>造成伤害</option>
                                <option value="cleanse" ${ef.effectType === 'cleanse' ? 'selected' : ''}>净化异常状态</option>
                                <option value="utility" ${ef.effectType === 'utility' ? 'selected' : ''}>仅改状态槽</option>
                            </select>
                        </label>
                        <div style="display:flex;align-items:flex-end;gap:4px;">
                            <label class="stcf-mini-field stcf-grow"><span>公式(可用 last_amount)</span>
                                <input type="text" class="text_pole" data-extra-field="formula" value="${escapeHtml(ef.formula || '0')}" placeholder="如 last_amount*0.4 或 20">
                            </label>
                            <button type="button" class="stcf-del-btn" data-extra-action="remove" title="删除此复合效果">✖</button>
                        </div>
                    </div>
                    ${gaugeEntries.length > 0 ? `
                        <div class="stcf-grid-4">
                            ${gaugeEntries.map(g => `
                                <label class="stcf-mini-field"><span>该目标${escapeHtml(g.name)}</span>
                                    <input type="number" class="text_pole" data-extra-gauge="${escapeHtml(g.id)}" value="${ef.gaugeChanges?.[g.id] ?? 0}">
                                </label>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            `).join('');

            const applyRowsHtml = applyList.map((ap, aIdx) => `
                <div class="stcf-apply-row" data-apply-index="${aIdx}">
                    <select class="text_pole" data-apply-field="statusId">${buildStatusSelectOptions(cfg, ap.statusId, '选择状态...')}</select>
                    <input type="number" min="0" max="100" class="text_pole stcf-pct-input" data-apply-field="chance" value="${ap.chance ?? 100}" title="触发概率 %">
                    <select class="text_pole stcf-tgt-select" data-apply-field="target">
                        <option value="target" ${!ap.target || ap.target === 'target' ? 'selected' : ''}>给主目标</option>
                        <option value="self" ${ap.target === 'self' ? 'selected' : ''}>仅给自己</option>
                        <option value="all_allies" ${ap.target === 'all_allies' ? 'selected' : ''}>给全体友方</option>
                        <option value="all_enemies" ${ap.target === 'all_enemies' ? 'selected' : ''}>给全体敌方</option>
                    </select>
                    <button type="button" class="stcf-del-btn" data-apply-action="remove" title="删除此附加状态">✖</button>
                </div>
            `).join('');

            return `
                <details class="stcf-item-card stcf-fold" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            ${POOL_LABELS[sk.poolType] || '🌐'} [${escapeHtml(sk.worldview || '通用')}] <strong>${escapeHtml(sk.name)}</strong>
                            <small class="stcf-muted">${sk.mpCost}MP · ${TARGET_LABELS[sk.targetType] || ''}${cdTag}${extraTag}</small>
                        </span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(sk.id)}</span>
                            <button type="button" class="stcf-del-btn" data-action="duplicate" title="复制一个相同技能方便微调">📋</button>
                            <button type="button" class="stcf-del-btn" data-action="delete" title="删除技能">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="name" value="${escapeHtml(sk.name)}" placeholder="技能名称">
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>世界观大组</span><input type="text" class="text_pole" data-field="worldview" value="${escapeHtml(sk.worldview || '通用')}"></label>
                            <label class="stcf-mini-field"><span>所属技能池</span>
                                <select class="text_pole" data-field="poolType">
                                    <option value="class" ${sk.poolType === 'class' ? 'selected' : ''}>🎓 职业技能池 (class)</option>
                                    <option value="universal" ${sk.poolType === 'universal' ? 'selected' : ''}>🌐 通用技能池 (universal)</option>
                                    <option value="monster" ${sk.poolType === 'monster' ? 'selected' : ''}>👹 怪物技能池 (monster)</option>
                                </select>
                            </label>
                        </div>
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="description" value="${escapeHtml(sk.description)}" placeholder="技能简述（10~25字）">
                        </div>
                        <div class="stcf-grid-4">
                            <label class="stcf-mini-field"><span>消耗 MP</span><input type="number" min="0" class="text_pole" data-field="mpCost" value="${sk.mpCost}"></label>
                            <label class="stcf-mini-field"><span>冷却回合 CD</span><input type="number" min="0" class="text_pole" data-field="cooldown" value="${sk.cooldown ?? 0}" title="0=无冷却"></label>
                            <label class="stcf-mini-field"><span>目标范围</span>
                                <select class="text_pole" data-field="targetType">
                                    <option value="single_enemy" ${sk.targetType === 'single_enemy' ? 'selected' : ''}>单体敌方</option>
                                    <option value="all_enemies" ${sk.targetType === 'all_enemies' ? 'selected' : ''}>全体敌方</option>
                                    <option value="self" ${sk.targetType === 'self' ? 'selected' : ''}>仅自身</option>
                                    <option value="single_ally" ${sk.targetType === 'single_ally' ? 'selected' : ''}>单体友方</option>
                                    <option value="all_allies" ${sk.targetType === 'all_allies' ? 'selected' : ''}>全体友方</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>效果类型</span>
                                <select class="text_pole" data-field="effectType">
                                    <option value="damage" ${sk.effectType === 'damage' ? 'selected' : ''}>造成伤害</option>
                                    <option value="heal" ${sk.effectType === 'heal' ? 'selected' : ''}>回复 HP</option>
                                    <option value="mp_restore" ${sk.effectType === 'mp_restore' ? 'selected' : ''}>回复 MP</option>
                                    <option value="utility" ${sk.effectType === 'utility' ? 'selected' : ''}>纯状态/特殊槽</option>
                                    <option value="struggle" ${sk.effectType === 'struggle' ? 'selected' : ''}>⛓️ 挣扎脱离束缚</option>
                                </select>
                            </label>
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>主效果数值公式</span><input type="text" class="text_pole" data-field="formula" value="${escapeHtml(sk.formula)}"></label>
                            <label class="stcf-mini-field"><span>自身 HP 变化公式(负卖血/正吸血)</span><input type="text" class="text_pole" data-field="selfHpFormula" value="${escapeHtml(sk.selfHpFormula || '0')}" placeholder="0 / -20 / spi*0.5"></label>
                        </div>
                        <div class="stcf-grid-4">
                            ${gaugeEntries.map(g => {
                                const sv = sk.selfGaugeChanges?.[g.id] ?? (g.id === 'gauge_a' ? sk.selfGaugeAChange : (g.id === 'gauge_b' ? sk.selfGaugeBChange : 0));
                                return `<label class="stcf-mini-field"><span>自身${escapeHtml(g.name)}</span><input type="number" class="text_pole" data-skill-self-gauge="${escapeHtml(g.id)}" value="${sv ?? 0}"></label>`;
                            }).join('')}
                            ${gaugeEntries.map(g => {
                                const tv = sk.targetGaugeChanges?.[g.id] ?? (g.id === 'gauge_a' ? sk.targetGaugeAChange : (g.id === 'gauge_b' ? sk.targetGaugeBChange : 0));
                                return `<label class="stcf-mini-field"><span>目标${escapeHtml(g.name)}</span><input type="number" class="text_pole" data-skill-target-gauge="${escapeHtml(g.id)}" value="${tv ?? 0}"></label>`;
                            }).join('')}
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>命中率 (%)</span><input type="number" min="1" max="100" class="text_pole" data-field="hitRate" value="${sk.hitRate ?? 100}"></label>
                            <label class="stcf-mini-field"><span>暴击率 (%)</span><input type="number" min="0" max="100" class="text_pole" data-field="critRate" value="${sk.critRate ?? 0}"></label>
                            <label class="stcf-mini-field"><span>暴击倍率</span><input type="number" step="0.1" min="1" class="text_pole" data-field="critMultiplier" value="${sk.critMultiplier ?? 1.5}"></label>
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>AI 优先级（越大越优先）</span><input type="number" min="1" class="text_pole" data-field="aiPriority" value="${sk.aiPriority ?? 10}"></label>
                            <label class="stcf-mini-field"><span>AI 仅在 HP ≤ (%) 释放</span><input type="number" min="1" max="100" class="text_pole" data-field="aiHpBelowPercent" value="${sk.aiHpBelowPercent ?? 100}"></label>
                        </div>

                        <!-- 折叠子区：附加复合效果（额外目标与效果） -->
                        <details class="stcf-sub-fold">
                            <summary>🔀 附加复合效果（对其他目标或自身同时生效 · 已配 ${extraList.length} 项）</summary>
                            <div class="stcf-sub-body">
                                <div class="stcf-muted" style="margin-bottom:5px;">可让同一技能在打敌人的同时给自己回血/回蓝/净化，或给全队治疗/加槽；公式中可用 <code>last_amount</code> 代表主效果刚造成的数值。</div>
                                <button type="button" class="menu_button stcf-sm-btn" data-extra-action="add" style="margin-bottom:6px;">➕ 添加附加复合效果</button>
                                ${extraRowsHtml || '<div class="stcf-muted">暂无附加复合效果</div>'}
                            </div>
                        </details>

                        <!-- 折叠子区：附加多个状态 -->
                        <details class="stcf-sub-fold">
                            <summary>✨ 附加状态列表（支持同时附加多个 · 已配 ${applyList.length} 项）</summary>
                            <div class="stcf-sub-body">
                                <button type="button" class="menu_button stcf-sm-btn" data-apply-action="add" style="margin-bottom:6px;">➕ 添加附加状态</button>
                                ${applyRowsHtml || '<div class="stcf-muted">暂无附加状态</div>'}
                            </div>
                        </details>

                        <!-- 折叠子区：目标与自身前置状态 / 状态槽门槛 / 高级与或组合前提 -->
                        <details class="stcf-sub-fold">
                            <summary>🔒 释放前置条件（目标 ${reqTgtCount} ｜ 自身 ${reqSelfCount}${sk.requiredGaugeId ? ' ｜ 槽门槛' : ''}${prereqGroups.length ? ` ｜ 🔀高级${prereqGroups.length}组` : ''}）</summary>
                            <div class="stcf-sub-body">
                                <div style="padding:6px;border:1px solid rgba(94,163,255,0.28);border-radius:6px;margin-bottom:8px;background:rgba(94,163,255,0.06);">
                                    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
                                        <span style="font-weight:700;">🔀 高级组合前提（多组 与/或 逻辑 + 按 Buff 添加来源筛选）</span>
                                        <div style="display:flex;align-items:center;gap:4px;">
                                            <select class="text_pole" data-field="prereqGroupLogic" style="width:auto;padding:2px 6px;" title="多个条件组之间的逻辑关系">
                                                <option value="and" ${sk.prereqGroupLogic !== 'or' ? 'selected' : ''}>组间：全部满足 (AND)</option>
                                                <option value="or" ${sk.prereqGroupLogic === 'or' ? 'selected' : ''}>组间：满足任一组 (OR)</option>
                                            </select>
                                            <button type="button" class="menu_button stcf-sm-btn" data-pg-action="add_group">➕ 新增条件组</button>
                                        </div>
                                    </div>
                                    ${prereqGroupsHtml || '<div class="stcf-muted">可组合「目标需有自己添加的某 Buff」「目标不可有别人添加的某 Buff」「自身 HP%/状态槽」等任意 与/或 组合。</div>'}
                                </div>

                                <div class="stcf-grid-2" style="margin-bottom:8px;">
                                    <label class="stcf-mini-field"><span>前置状态槽门槛（可选）</span>
                                        <select class="text_pole" data-field="requiredGaugeId">
                                            <option value="" ${!sk.requiredGaugeId ? 'selected' : ''}>不限状态槽</option>
                                            ${gaugeEntries.map(g => `<option value="${escapeHtml(g.id)}" ${sk.requiredGaugeId === g.id ? 'selected' : ''}>需 ${escapeHtml(g.name)} (${escapeHtml(g.id)}) ≥</option>`).join('')}
                                        </select>
                                    </label>
                                    <label class="stcf-mini-field"><span>所需最低槽位数值</span>
                                        <input type="number" class="text_pole" data-field="requiredGaugeMin" value="${sk.requiredGaugeMin ?? 0}">
                                    </label>
                                </div>
                                <div class="stcf-sub-label">目标持有以下<strong>任意 1 个</strong>状态才可释放（全不勾不限）：</div>
                                <div class="stcf-chips-wrap" style="margin-bottom:8px;">${renderStatusCheckChips(cfg, sk.requiredTargetStatusIds, 'data-skill-req-target')}</div>
                                <div class="stcf-sub-label">自身持有以下<strong>任意 1 个</strong>状态才可释放（如狂暴/魔力涌动，全不勾不限）：</div>
                                <div class="stcf-chips-wrap">${renderStatusCheckChips(cfg, sk.requiredSelfStatusIds, 'data-skill-req-self')}</div>
                            </div>
                        </details>
                    </div>
                </details>
            `;
        }).join('');
    }

    elSkillsEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const skill = deps.getConfig().skills[Number(card.dataset.index)];
        if (!skill) return;
        if (e.target.dataset.pcField === 'value') {
            const gEl = e.target.closest('[data-pg-idx]');
            const cEl = e.target.closest('[data-pc-idx]');
            const pc = skill.prereqGroups?.[Number(gEl?.dataset.pgIdx)]?.conditions?.[Number(cEl?.dataset.pcIdx)];
            if (pc) { pc.value = Number(e.target.value) || 0; commitChange(); }
            return;
        }
        if (e.target.dataset.applyField === 'chance') {
            const row = e.target.closest('.stcf-apply-row');
            const ap = skill.applyStatuses[Number(row.dataset.applyIndex)];
            if (ap) { ap.chance = Math.max(0, Math.min(100, Number(e.target.value) || 0)); commitChange(); }
            return;
        }
        if (e.target.dataset.extraField === 'formula') {
            const row = e.target.closest('[data-extra-index]');
            const ef = skill.extraEffects?.[Number(row?.dataset.extraIndex)];
            if (ef) { ef.formula = e.target.value; commitChange(); }
            return;
        }
        if (e.target.dataset.extraGauge) {
            const row = e.target.closest('[data-extra-index]');
            const ef = skill.extraEffects?.[Number(row?.dataset.extraIndex)];
            if (ef) {
                const gid = e.target.dataset.extraGauge;
                const val = Number(e.target.value) || 0;
                if (!ef.gaugeChanges || typeof ef.gaugeChanges !== 'object') ef.gaugeChanges = {};
                if (val === 0) delete ef.gaugeChanges[gid]; else ef.gaugeChanges[gid] = val;
                commitChange();
            }
            return;
        }
        if (e.target.dataset.skillSelfGauge) {
            const gid = e.target.dataset.skillSelfGauge;
            const val = Number(e.target.value) || 0;
            if (!skill.selfGaugeChanges || typeof skill.selfGaugeChanges !== 'object') skill.selfGaugeChanges = {};
            if (val === 0) delete skill.selfGaugeChanges[gid]; else skill.selfGaugeChanges[gid] = val;
            if (gid === 'gauge_a') skill.selfGaugeAChange = val;
            if (gid === 'gauge_b') skill.selfGaugeBChange = val;
            commitChange();
            return;
        }
        if (e.target.dataset.skillTargetGauge) {
            const gid = e.target.dataset.skillTargetGauge;
            const val = Number(e.target.value) || 0;
            if (!skill.targetGaugeChanges || typeof skill.targetGaugeChanges !== 'object') skill.targetGaugeChanges = {};
            if (val === 0) delete skill.targetGaugeChanges[gid]; else skill.targetGaugeChanges[gid] = val;
            if (gid === 'gauge_a') skill.targetGaugeAChange = val;
            if (gid === 'gauge_b') skill.targetGaugeBChange = val;
            commitChange();
            return;
        }
        if (!e.target.dataset.field || e.target.type === 'checkbox') return;
        skill[e.target.dataset.field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange();
    });
    elSkillsEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const skill = deps.getConfig().skills[Number(card.dataset.index)];
        if (!skill) return;

        if (e.target.dataset.pgLogic) {
            const gEl = e.target.closest('[data-pg-idx]');
            const pg = skill.prereqGroups?.[Number(gEl?.dataset.pgIdx)];
            if (pg) { pg.logic = e.target.value === 'or' ? 'or' : 'and'; commitChange(); }
            return;
        }
        if (e.target.dataset.pcField) {
            const gEl = e.target.closest('[data-pg-idx]');
            const cEl = e.target.closest('[data-pc-idx]');
            const pc = skill.prereqGroups?.[Number(gEl?.dataset.pgIdx)]?.conditions?.[Number(cEl?.dataset.pcIdx)];
            if (pc) {
                const f = e.target.dataset.pcField;
                pc[f] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
                if (f === 'type') {
                    if (pc.type === 'gauge' && !pc.gaugeId) pc.gaugeId = getGaugeEntries(deps.getConfig())[0]?.id || 'gauge_a';
                    if ((pc.type === 'has_status' || pc.type === 'not_has_status') && !pc.statusId) pc.statusId = deps.getConfig().statuses[0]?.id || '_any';
                }
                commitChange(f === 'type');
            }
            return;
        }
        if (e.target.dataset.applyField) {
            const row = e.target.closest('.stcf-apply-row');
            const ap = skill.applyStatuses[Number(row.dataset.applyIndex)];
            if (ap) {
                ap[e.target.dataset.applyField] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
                commitChange();
            }
            return;
        }
        if (e.target.dataset.extraField) {
            const row = e.target.closest('[data-extra-index]');
            const ef = skill.extraEffects?.[Number(row?.dataset.extraIndex)];
            if (ef) {
                ef[e.target.dataset.extraField] = e.target.value;
                commitChange();
            }
            return;
        }
        if (e.target.dataset.skillReqTarget) {
            const set = new Set(skill.requiredTargetStatusIds || []);
            if (e.target.checked) set.add(e.target.dataset.skillReqTarget);
            else set.delete(e.target.dataset.skillReqTarget);
            skill.requiredTargetStatusIds = [...set];
            commitChange();
            return;
        }
        if (e.target.dataset.skillReqSelf) {
            const set = new Set(skill.requiredSelfStatusIds || []);
            if (e.target.checked) set.add(e.target.dataset.skillReqSelf);
            else set.delete(e.target.dataset.skillReqSelf);
            skill.requiredSelfStatusIds = [...set];
            commitChange();
            return;
        }
        if (!e.target.dataset.field) return;
        const field = e.target.dataset.field;
        skill[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange(['name', 'worldview', 'poolType'].includes(field));
    });
    elSkillsEditor.addEventListener('click', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const idx = Number(card.dataset.index);
        const skill = deps.getConfig().skills[idx];
        if (!skill) return;
        if (e.target.closest('[data-action="delete"]')) {
            e.preventDefault();
            deps.getConfig().skills.splice(idx, 1);
            commitChange(true);
        } else if (e.target.closest('[data-action="duplicate"]')) {
            e.preventDefault();
            const cfg = deps.getConfig();
            const clone = JSON.parse(JSON.stringify(skill));
            clone.id = makeUniqueId('skill', cfg.skills);
            clone.name = `${skill.name}(副本)`;
            cfg.skills.splice(idx + 1, 0, clone);
            commitChange(true, `sk:${clone.id}`);
        } else if (e.target.closest('[data-pg-action="add_group"]')) {
            if (!Array.isArray(skill.prereqGroups)) skill.prereqGroups = [];
            skill.prereqGroups.push({
                logic: 'and',
                conditions: [{
                    subject: 'target',
                    type: 'has_status',
                    statusId: deps.getConfig().statuses[0]?.id || '_any',
                    sourceFilter: 'self',
                    gaugeId: '',
                    operator: '>=',
                    value: 0,
                }],
            });
            commitChange(true);
        } else if (e.target.closest('[data-pg-action="del_group"]')) {
            const gEl = e.target.closest('[data-pg-idx]');
            skill.prereqGroups.splice(Number(gEl.dataset.pgIdx), 1);
            commitChange(true);
        } else if (e.target.closest('[data-pg-action="add_cond"]')) {
            const gEl = e.target.closest('[data-pg-idx]');
            const pg = skill.prereqGroups?.[Number(gEl?.dataset.pgIdx)];
            if (pg) {
                if (!Array.isArray(pg.conditions)) pg.conditions = [];
                pg.conditions.push({
                    subject: 'target',
                    type: 'has_status',
                    statusId: deps.getConfig().statuses[0]?.id || '_any',
                    sourceFilter: 'any',
                    gaugeId: '',
                    operator: '>=',
                    value: 0,
                });
                commitChange(true);
            }
        } else if (e.target.closest('[data-pg-action="del_cond"]')) {
            const gEl = e.target.closest('[data-pg-idx]');
            const cEl = e.target.closest('[data-pc-idx]');
            const pg = skill.prereqGroups?.[Number(gEl?.dataset.pgIdx)];
            if (pg && Array.isArray(pg.conditions)) {
                pg.conditions.splice(Number(cEl.dataset.pcIdx), 1);
                commitChange(true);
            }
        } else if (e.target.closest('[data-extra-action="add"]')) {
            if (!Array.isArray(skill.extraEffects)) skill.extraEffects = [];
            skill.extraEffects.push({
                targetType: 'self',
                effectType: 'heal',
                formula: 'max(10, last_amount * 0.4)',
                gaugeChanges: {},
            });
            commitChange(true);
        } else if (e.target.closest('[data-extra-action="remove"]')) {
            const row = e.target.closest('[data-extra-index]');
            skill.extraEffects.splice(Number(row.dataset.extraIndex), 1);
            commitChange(true);
        } else if (e.target.closest('[data-apply-action="add"]')) {
            if (!Array.isArray(skill.applyStatuses)) skill.applyStatuses = [];
            skill.applyStatuses.push({
                statusId: deps.getConfig().statuses[0]?.id || '',
                chance: 100,
                target: 'target',
            });
            commitChange(true);
        } else if (e.target.closest('[data-apply-action="remove"]')) {
            const row = e.target.closest('.stcf-apply-row');
            skill.applyStatuses.splice(Number(row.dataset.applyIndex), 1);
            commitChange(true);
        }
    });

    // =========================================================================
    // 四、装备库编辑器（默认折叠 + 多常驻 Buff + 多解锁技能）
    // =========================================================================
    const elEquipsEditor = container.querySelector('#stcf-equipments-editor');
    container.querySelector('#stcf-btn-add-equip').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('equip', cfg.equipments);
        cfg.equipments.push({
            id,
            name: `新装备_${cfg.equipments.length + 1}`,
            slot: 'head',
            description: '自定义装备说明',
            bonusHp: 0, bonusMp: 0, bonusAtk: 0, bonusSpi: 0, bonusDef: 5, bonusMdef: 0,
            grantSkillIds: [],
            passiveStatusIds: [],
        });
        commitChange(true, `eq:${id}`);
    });

    function renderEquipmentsList(preserveOpen) {
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elEquipsEditor) : new Set();

        elEquipsEditor.innerHTML = (cfg.equipments || []).map((eq, idx) => {
            const cardKey = `eq:${eq.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const pCount = (eq.passiveStatusIds || []).length;
            const gCount = (eq.grantSkillIds || []).length;
            const skillChecks = (cfg.skills || []).filter(s => s.poolType !== 'monster').map(sk => `
                <label class="stcf-chip-check">
                    <input type="checkbox" data-eq-grant-skill="${escapeHtml(sk.id)}" ${(eq.grantSkillIds || []).includes(sk.id) ? 'checked' : ''}>
                    <span>${escapeHtml(sk.name)}</span>
                </label>
            `).join('');

            return `
                <details class="stcf-item-card stcf-fold" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            🛡️ [${SLOT_LABELS[eq.slot] || eq.slot}] <strong>${escapeHtml(eq.name)}</strong>
                            <small class="stcf-muted">${pCount ? `常驻${pCount}状态` : ''}${gCount ? ` 附${gCount}技` : ''}</small>
                        </span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(eq.id)}</span>
                            <button type="button" class="stcf-del-btn" data-action="duplicate" title="复制装备">📋</button>
                            <button type="button" class="stcf-del-btn" data-action="delete" title="删除装备">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="name" value="${escapeHtml(eq.name)}" placeholder="装备名称">
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>装备部位</span>
                                <select class="text_pole" data-field="slot">
                                    <option value="weapon" ${eq.slot === 'weapon' ? 'selected' : ''}>武器 (weapon)</option>
                                    <option value="head" ${eq.slot === 'head' ? 'selected' : ''}>头部/帽子 (head)</option>
                                    <option value="body" ${eq.slot === 'body' ? 'selected' : ''}>防具/衣服 (body)</option>
                                    <option value="accessory" ${eq.slot === 'accessory' ? 'selected' : ''}>饰品 (accessory·可多戴)</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>简述</span><input type="text" class="text_pole" data-field="description" value="${escapeHtml(eq.description)}"></label>
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>+HP</span><input type="number" class="text_pole" data-field="bonusHp" value="${eq.bonusHp}"></label>
                            <label class="stcf-mini-field"><span>+MP</span><input type="number" class="text_pole" data-field="bonusMp" value="${eq.bonusMp}"></label>
                            <label class="stcf-mini-field"><span>+物攻</span><input type="number" class="text_pole" data-field="bonusAtk" value="${eq.bonusAtk}"></label>
                            <label class="stcf-mini-field"><span>+精神</span><input type="number" class="text_pole" data-field="bonusSpi" value="${eq.bonusSpi ?? 0}"></label>
                            <label class="stcf-mini-field"><span>+物防</span><input type="number" class="text_pole" data-field="bonusDef" value="${eq.bonusDef}"></label>
                            <label class="stcf-mini-field"><span>+法抗</span><input type="number" class="text_pole" data-field="bonusMdef" value="${eq.bonusMdef ?? 0}"></label>
                        </div>
                        <details class="stcf-sub-fold">
                            <summary>✨ 穿戴附带常驻 Buff（支持多选 · 已选 ${pCount} 项）</summary>
                            <div class="stcf-sub-body stcf-chips-wrap">${renderStatusCheckChips(cfg, eq.passiveStatusIds, 'data-eq-passive-status')}</div>
                        </details>
                        <details class="stcf-sub-fold">
                            <summary>⚔️ 穿戴解锁专属技能（支持多选 · 已选 ${gCount} 项）</summary>
                            <div class="stcf-sub-body stcf-chips-wrap">${skillChecks || '<span class="stcf-muted">暂无技能</span>'}</div>
                        </details>
                    </div>
                </details>
            `;
        }).join('');
    }

    elEquipsEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const eq = deps.getConfig().equipments[Number(card.dataset.index)];
        if (!eq) return;
        if (e.target.dataset.eqPassiveStatus) {
            const set = new Set(eq.passiveStatusIds || []);
            if (e.target.checked) set.add(e.target.dataset.eqPassiveStatus);
            else set.delete(e.target.dataset.eqPassiveStatus);
            eq.passiveStatusIds = [...set];
            commitChange();
        } else if (e.target.dataset.eqGrantSkill) {
            const set = new Set(eq.grantSkillIds || []);
            if (e.target.checked) set.add(e.target.dataset.eqGrantSkill);
            else set.delete(e.target.dataset.eqGrantSkill);
            eq.grantSkillIds = [...set];
            commitChange();
        }
    });
    bindSimpleListEvents(elEquipsEditor, () => deps.getConfig().equipments, ['name', 'slot']);

    // =========================================================================
    // 五、道具库编辑器（默认折叠 + 附加多个状态）
    // =========================================================================
    const elItemsEditor = container.querySelector('#stcf-items-editor');
    container.querySelector('#stcf-btn-add-item').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('item', cfg.items);
        cfg.items.push({
            id,
            name: `新道具_${cfg.items.length + 1}`,
            icon: '🧪',
            description: '自定义消耗品说明',
            quantity: 3,
            targetType: 'single_ally',
            effectType: 'heal',
            formula: '40',
            targetGaugeAChange: 0,
            targetGaugeBChange: 0,
            applyStatuses: [],
            consumesTurn: true,
        });
        commitChange(true, `it:${id}`);
    });

    function renderItemsList(preserveOpen) {
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elItemsEditor) : new Set();
        const gaugeEntries = getGaugeEntries(cfg);

        elItemsEditor.innerHTML = (cfg.items || []).map((it, idx) => {
            const cardKey = `it:${it.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const applyList = Array.isArray(it.applyStatuses) ? it.applyStatuses : [];
            const applyRows = applyList.map((ap, aIdx) => `
                <div class="stcf-apply-row" data-apply-index="${aIdx}">
                    <select class="text_pole" data-apply-field="statusId">${buildStatusSelectOptions(cfg, ap.statusId, '选择状态...')}</select>
                    <input type="number" min="0" max="100" class="text_pole stcf-pct-input" data-apply-field="chance" value="${ap.chance ?? 100}" title="触发概率 %">
                    <button type="button" class="stcf-del-btn" data-apply-action="remove">✖</button>
                </div>
            `).join('');

            return `
                <details class="stcf-item-card stcf-fold" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            ${escapeHtml(it.icon || '🎒')} <strong>${escapeHtml(it.name)}</strong>
                            <small class="stcf-muted">×${it.quantity} · ${TARGET_LABELS[it.targetType] || ''}${it.consumesTurn === false ? ' · 不占回合' : ''}</small>
                        </span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(it.id)}</span>
                            <button type="button" class="stcf-del-btn" data-action="duplicate" title="复制道具">📋</button>
                            <button type="button" class="stcf-del-btn" data-action="delete" title="删除道具">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-item-head">
                            <input type="text" class="text_pole stcf-icon-input" data-field="icon" value="${escapeHtml(it.icon)}">
                            <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(it.name)}" placeholder="道具名称">
                        </div>
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="description" value="${escapeHtml(it.description)}" placeholder="道具效果说明">
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>库存数量</span><input type="number" min="0" class="text_pole" data-field="quantity" value="${it.quantity}"></label>
                            <label class="stcf-mini-field"><span>目标范围</span>
                                <select class="text_pole" data-field="targetType">
                                    <option value="single_ally" ${it.targetType === 'single_ally' ? 'selected' : ''}>单体友方</option>
                                    <option value="all_allies" ${it.targetType === 'all_allies' ? 'selected' : ''}>全体友方</option>
                                    <option value="self" ${it.targetType === 'self' ? 'selected' : ''}>仅自身</option>
                                    <option value="single_enemy" ${it.targetType === 'single_enemy' ? 'selected' : ''}>单体敌方</option>
                                    <option value="all_enemies" ${it.targetType === 'all_enemies' ? 'selected' : ''}>全体敌方</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>效果类型</span>
                                <select class="text_pole" data-field="effectType">
                                    <option value="heal" ${it.effectType === 'heal' ? 'selected' : ''}>回复 HP</option>
                                    <option value="mp_restore" ${it.effectType === 'mp_restore' ? 'selected' : ''}>回复 MP</option>
                                    <option value="damage" ${it.effectType === 'damage' ? 'selected' : ''}>造成伤害</option>
                                    <option value="cleanse" ${it.effectType === 'cleanse' ? 'selected' : ''}>净化异常状态</option>
                                    <option value="utility" ${it.effectType === 'utility' ? 'selected' : ''}>纯状态/特殊槽</option>
                                </select>
                            </label>
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>数值公式</span><input type="text" class="text_pole" data-field="formula" value="${escapeHtml(it.formula)}"></label>
                            ${gaugeEntries.map(g => {
                                const tv = it.targetGaugeChanges?.[g.id] ?? (g.id === 'gauge_a' ? it.targetGaugeAChange : (g.id === 'gauge_b' ? it.targetGaugeBChange : 0));
                                return `<label class="stcf-mini-field"><span>目标${escapeHtml(g.name)}</span><input type="number" class="text_pole" data-item-target-gauge="${escapeHtml(g.id)}" value="${tv ?? 0}"></label>`;
                            }).join('')}
                        </div>
                        <label class="stcf-checkbox-row">
                            <input type="checkbox" data-field="consumesTurn" ${it.consumesTurn !== false ? 'checked' : ''}>
                            <span>使用消耗行动回合</span>
                        </label>
                        <details class="stcf-sub-fold">
                            <summary>✨ 附加状态列表（支持多选 · 已配 ${applyList.length} 项）</summary>
                            <div class="stcf-sub-body">
                                <button type="button" class="menu_button stcf-sm-btn" data-apply-action="add" style="margin-bottom:6px;">➕ 添加附加状态</button>
                                ${applyRows || '<div class="stcf-muted">暂无附加状态</div>'}
                            </div>
                        </details>
                    </div>
                </details>
            `;
        }).join('');
    }

    elItemsEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const item = deps.getConfig().items[Number(card.dataset.index)];
        if (!item) return;
        if (e.target.dataset.applyField === 'chance') {
            const row = e.target.closest('.stcf-apply-row');
            const ap = item.applyStatuses[Number(row.dataset.applyIndex)];
            if (ap) { ap.chance = Math.max(0, Math.min(100, Number(e.target.value) || 0)); commitChange(); }
        } else if (e.target.dataset.itemTargetGauge) {
            const gid = e.target.dataset.itemTargetGauge;
            const val = Number(e.target.value) || 0;
            if (!item.targetGaugeChanges || typeof item.targetGaugeChanges !== 'object') item.targetGaugeChanges = {};
            if (val === 0) delete item.targetGaugeChanges[gid]; else item.targetGaugeChanges[gid] = val;
            if (gid === 'gauge_a') item.targetGaugeAChange = val;
            if (gid === 'gauge_b') item.targetGaugeBChange = val;
            commitChange();
        }
    });
    elItemsEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const item = deps.getConfig().items[Number(card.dataset.index)];
        if (!item) return;
        if (e.target.dataset.applyField) {
            const row = e.target.closest('.stcf-apply-row');
            const ap = item.applyStatuses[Number(row.dataset.applyIndex)];
            if (ap) { ap[e.target.dataset.applyField] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value; commitChange(); }
        }
    });
    elItemsEditor.addEventListener('click', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const item = deps.getConfig().items[Number(card.dataset.index)];
        if (!item) return;
        if (e.target.closest('[data-apply-action="add"]')) {
            if (!Array.isArray(item.applyStatuses)) item.applyStatuses = [];
            item.applyStatuses.push({ statusId: deps.getConfig().statuses[0]?.id || '', chance: 100, target: 'target' });
            commitChange(true);
        } else if (e.target.closest('[data-apply-action="remove"]')) {
            const row = e.target.closest('.stcf-apply-row');
            item.applyStatuses.splice(Number(row.dataset.applyIndex), 1);
            commitChange(true);
        }
    });
    bindSimpleListEvents(elItemsEditor, () => deps.getConfig().items, ['name']);

    // =========================================================================
    // 六、状态 / Buff 编辑器（默认折叠 + 到期转化为多个状态）
    // =========================================================================
    const elStatusesEditor = container.querySelector('#stcf-statuses-editor');
    container.querySelector('#stcf-btn-add-status').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('status', cfg.statuses);
        cfg.statuses.push({
            id,
            name: `新状态_${cfg.statuses.length + 1}`,
            icon: '✨',
            description: '自定义组合状态说明',
            skipTurn: false,
            perTurnHp: -10, perTurnMp: 0, perTurnGaugeA: 0, perTurnGaugeB: 0, perTurnGauges: {},
            gaugeChangeMultipliers: [],
            atkMultiplier: 1, spiMultiplier: 1, defMultiplier: 1, mdefMultiplier: 1, damageTakenMultiplier: 1,
            duration: 2,
            onExpireStatusIds: [],
            restraintType: '',
            restraintSourceMode: 'caster',
            restraintPower: 0,
            restraintObjectHp: 50,
            restraintObjectName: '',
            sourceTrackingMode: 'auto',
            defaultSourceLabel: '',
        });
        commitChange(true, `st:${id}`);
    });

    function renderStatusesList(preserveOpen) {
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elStatusesEditor) : new Set();
        const gaugeEntries = getGaugeEntries(cfg);

        elStatusesEditor.innerHTML = (cfg.statuses || []).map((st, idx) => {
            const cardKey = `st:${st.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const expIds = Array.isArray(st.onExpireStatusIds) ? st.onExpireStatusIds : [];
            const gmList = Array.isArray(st.gaugeChangeMultipliers) ? st.gaugeChangeMultipliers : [];
            const gmTag = gmList.length > 0 ? ` · 📊槽倍率×${gmList.length}` : '';
            const bindTag = st.restraintType === 'physical'
                ? ' · ⛓️物理束缚'
                : (st.restraintType === 'magical' ? ' · ⛓️法术束缚' : '');

            const gmRowsHtml = gmList.map((gm, gIdx) => {
                const gaugeOpts = [
                    `<option value="_all" ${gm.gaugeId === '_all' ? 'selected' : ''}>全部状态槽</option>`,
                    ...gaugeEntries.map(g => `<option value="${escapeHtml(g.id)}" ${gm.gaugeId === g.id ? 'selected' : ''}>${escapeHtml(g.name)} (${escapeHtml(g.id)})</option>`),
                ].join('');
                return `
                    <div class="stcf-apply-row" data-gm-index="${gIdx}">
                        <select class="text_pole" data-gm-field="gaugeId">${gaugeOpts}</select>
                        <select class="text_pole stcf-tgt-select" data-gm-field="direction">
                            <option value="both" ${gm.direction === 'both' ? 'selected' : ''}>增减全部</option>
                            <option value="gain" ${gm.direction === 'gain' ? 'selected' : ''}>仅增加(+)</option>
                            <option value="loss" ${gm.direction === 'loss' ? 'selected' : ''}>仅减少(-)</option>
                        </select>
                        <input type="number" step="0.1" min="0" class="text_pole stcf-pct-input" data-gm-field="multiplier" value="${gm.multiplier ?? 1}" title="变化倍率（1.5=增加50%，0.5=减半，0=免疫该变化）">
                        <button type="button" class="stcf-del-btn" data-gm-action="remove" title="删除倍率规则">✖</button>
                    </div>
                `;
            }).join('');

            return `
                <details class="stcf-item-card stcf-fold" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            ${escapeHtml(st.icon || '✨')} <strong>${escapeHtml(st.name)}</strong>
                            <small class="stcf-muted">${st.duration}回合${st.skipTurn ? ' · 💫跳回合' : ''}${bindTag}${gmTag}${expIds.length ? ` · 结束转${expIds.length}态` : ''}</small>
                        </span>
                        <span class="stcf-fold-right">
                            <span class="stcf-id-tag">${escapeHtml(st.id)}</span>
                            <button type="button" class="stcf-del-btn" data-action="duplicate" title="复制状态">📋</button>
                            <button type="button" class="stcf-del-btn" data-action="delete" title="删除状态">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-item-head">
                            <input type="text" class="text_pole stcf-icon-input" data-field="icon" value="${escapeHtml(st.icon)}" title="图标 Emoji">
                            <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(st.name)}" placeholder="状态名称">
                        </div>
                        <div class="stcf-field-row">
                            <input type="text" class="text_pole" data-field="description" value="${escapeHtml(st.description)}" placeholder="状态效果说明">
                        </div>
                        <label class="stcf-checkbox-row" style="margin-bottom:6px;">
                            <input type="checkbox" data-field="skipTurn" ${st.skipTurn ? 'checked' : ''}>
                            <span>💫 跳过行动回合（眩晕/冰冻/控制，可与下方属性自由叠加）</span>
                        </label>
                        <div class="stcf-grid-4">
                            <label class="stcf-mini-field"><span>每回合 HP</span><input type="number" class="text_pole" data-field="perTurnHp" value="${st.perTurnHp ?? 0}"></label>
                            <label class="stcf-mini-field"><span>每回合 MP</span><input type="number" class="text_pole" data-field="perTurnMp" value="${st.perTurnMp ?? 0}"></label>
                            ${gaugeEntries.map(g => {
                                const gv = st.perTurnGauges?.[g.id] ?? (g.id === 'gauge_a' ? st.perTurnGaugeA : (g.id === 'gauge_b' ? st.perTurnGaugeB : 0));
                                return `<label class="stcf-mini-field"><span>每回合${escapeHtml(g.name)}</span><input type="number" class="text_pole" data-status-tick-gauge="${escapeHtml(g.id)}" value="${gv ?? 0}"></label>`;
                            }).join('')}
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>物攻倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="atkMultiplier" value="${st.atkMultiplier}"></label>
                            <label class="stcf-mini-field"><span>精神倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="spiMultiplier" value="${st.spiMultiplier ?? 1}"></label>
                            <label class="stcf-mini-field"><span>物防倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="defMultiplier" value="${st.defMultiplier}"></label>
                            <label class="stcf-mini-field"><span>法抗倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="mdefMultiplier" value="${st.mdefMultiplier ?? 1}"></label>
                            <label class="stcf-mini-field"><span>承伤倍率(0.7减伤/1.3易伤)</span><input type="number" step="0.1" min="0" class="text_pole" data-field="damageTakenMultiplier" value="${st.damageTakenMultiplier ?? 1}"></label>
                            <label class="stcf-mini-field"><span>持续回合数</span><input type="number" min="1" class="text_pole" data-field="duration" value="${st.duration}"></label>
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>Buff 添加来源追踪（配合技能来源前提）</span>
                                <select class="text_pole" data-field="sourceTrackingMode">
                                    <option value="auto" ${st.sourceTrackingMode !== 'per_caster' && st.sourceTrackingMode !== 'fixed' ? 'selected' : ''}>自动记录施法者（同名刷新）</option>
                                    <option value="per_caster" ${st.sourceTrackingMode === 'per_caster' ? 'selected' : ''}>按施法者独立共存（不同人挂的互不覆盖）</option>
                                    <option value="fixed" ${st.sourceTrackingMode === 'fixed' ? 'selected' : ''}>固定自定义来源标签</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>自定义来源标签（可选）</span>
                                <input type="text" class="text_pole" data-field="defaultSourceLabel" value="${escapeHtml(st.defaultSourceLabel || '')}" placeholder="留空自动记录施法者名">
                            </label>
                        </div>
                        <details class="stcf-sub-fold">
                            <summary>📊 状态槽增减倍率（Buff 加成 · 已配 ${gmList.length} 项）</summary>
                            <div class="stcf-sub-body">
                                <div class="stcf-muted" style="margin-bottom:5px;">当此角色的状态槽数值增加或减少时乘以对应倍率（如 1.5=增幅50%，2=翻倍，0.5=减半，0=完全阻挡变化；多条 Buff 累乘）。</div>
                                <button type="button" class="menu_button stcf-sm-btn" data-gm-action="add" style="margin-bottom:6px;">➕ 添加状态槽倍率</button>
                                ${gmRowsHtml || '<div class="stcf-muted">未设置额外倍率（默认 ×1）</div>'}
                            </div>
                        </details>
                        <details class="stcf-sub-fold">
                            <summary>⛓️ 束缚/禁锢机制（${st.restraintType ? (st.restraintType === 'magical' ? '法术类束缚' : '物理类束缚') : '未开启'}）</summary>
                            <div class="stcf-sub-body">
                                <div class="stcf-grid-2">
                                    <label class="stcf-mini-field"><span>束缚类型（开启后无法放普通技能，只能挣扎）</span>
                                        <select class="text_pole" data-field="restraintType">
                                            <option value="" ${!st.restraintType ? 'selected' : ''}>非束缚状态</option>
                                            <option value="physical" ${st.restraintType === 'physical' ? 'selected' : ''}>物理类束缚（HP% × 自身力量/对抗值）</option>
                                            <option value="magical" ${st.restraintType === 'magical' ? 'selected' : ''}>法术类束缚（MP% × 自身精神/对抗值）</option>
                                        </select>
                                    </label>
                                    <label class="stcf-mini-field"><span>束缚维持来源</span>
                                        <select class="text_pole" data-field="restraintSourceMode">
                                            <option value="caster" ${st.restraintSourceMode !== 'object' ? 'selected' : ''}>施法者维持（攻击施法者即立刻释放）</option>
                                            <option value="object" ${st.restraintSourceMode === 'object' ? 'selected' : ''}>禁锢道具/牢笼（拥有独立血量，打破释放）</option>
                                        </select>
                                    </label>
                                </div>
                                <div class="stcf-grid-3">
                                    <label class="stcf-mini-field"><span>道具对抗强度值</span><input type="number" min="0" class="text_pole" data-field="restraintPower" value="${st.restraintPower ?? 0}" title="道具模式必填（如25）；施法者模式填0则自动读取施法者实时有效力量/精神"></label>
                                    <label class="stcf-mini-field"><span>禁锢道具血量 HP</span><input type="number" min="1" class="text_pole" data-field="restraintObjectHp" value="${st.restraintObjectHp ?? 50}"></label>
                                    <label class="stcf-mini-field"><span>禁锢道具显示名</span><input type="text" class="text_pole" data-field="restraintObjectName" value="${escapeHtml(st.restraintObjectName || '')}" placeholder="留空默认用状态名"></label>
                                </div>
                            </div>
                        </details>
                        <details class="stcf-sub-fold">
                            <summary>🔄 倒计时结束后转化为新状态（支持多选 · 已选 ${expIds.length} 项）</summary>
                            <div class="stcf-sub-body stcf-chips-wrap">${renderStatusCheckChips(cfg, expIds, 'data-status-expire-id')}</div>
                        </details>
                    </div>
                </details>
            `;
        }).join('');
    }

    elStatusesEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const st = deps.getConfig().statuses[Number(card.dataset.index)];
        if (!st) return;
        if (e.target.dataset.statusTickGauge) {
            const gid = e.target.dataset.statusTickGauge;
            const val = Math.round(Number(e.target.value) || 0);
            if (!st.perTurnGauges || typeof st.perTurnGauges !== 'object') st.perTurnGauges = {};
            if (val === 0) delete st.perTurnGauges[gid]; else st.perTurnGauges[gid] = val;
            if (gid === 'gauge_a') st.perTurnGaugeA = val;
            if (gid === 'gauge_b') st.perTurnGaugeB = val;
            commitChange();
            return;
        }
        if (e.target.dataset.gmField === 'multiplier') {
            const row = e.target.closest('[data-gm-index]');
            const gm = st.gaugeChangeMultipliers?.[Number(row?.dataset.gmIndex)];
            if (gm) {
                const v = Number(e.target.value);
                gm.multiplier = Number.isFinite(v) && v >= 0 ? v : 1;
                commitChange();
            }
        }
    });
    elStatusesEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const st = deps.getConfig().statuses[Number(card.dataset.index)];
        if (!st) return;
        if (e.target.dataset.gmField) {
            const row = e.target.closest('[data-gm-index]');
            const gm = st.gaugeChangeMultipliers?.[Number(row?.dataset.gmIndex)];
            if (gm) {
                gm[e.target.dataset.gmField] = e.target.type === 'number'
                    ? Math.max(0, Number(e.target.value) || 0)
                    : e.target.value;
                commitChange();
            }
            return;
        }
        if (!e.target.dataset.statusExpireId) return;
        const set = new Set(st.onExpireStatusIds || []);
        if (e.target.checked) set.add(e.target.dataset.statusExpireId);
        else set.delete(e.target.dataset.statusExpireId);
        st.onExpireStatusIds = [...set];
        commitChange();
    });
    elStatusesEditor.addEventListener('click', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const st = deps.getConfig().statuses[Number(card.dataset.index)];
        if (!st) return;
        if (e.target.closest('[data-gm-action="add"]')) {
            if (!Array.isArray(st.gaugeChangeMultipliers)) st.gaugeChangeMultipliers = [];
            const firstG = getGaugeEntries(deps.getConfig())[0]?.id || '_all';
            st.gaugeChangeMultipliers.push({ gaugeId: firstG, direction: 'gain', multiplier: 1.5 });
            commitChange(true);
        } else if (e.target.closest('[data-gm-action="remove"]')) {
            const row = e.target.closest('[data-gm-index]');
            st.gaugeChangeMultipliers.splice(Number(row.dataset.gmIndex), 1);
            commitChange(true);
        }
    });
    bindSimpleListEvents(elStatusesEditor, () => deps.getConfig().statuses, ['name', 'icon', 'restraintType']);

    // =========================================================================
    // 七、阈值触发规则编辑器（默认折叠 + 达标同时挂载多个 Buff + Prompt 注入）
    // =========================================================================
    const elRulesEditor = container.querySelector('#stcf-rules-editor');
    container.querySelector('#stcf-btn-add-rule').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('rule', cfg.triggerRules);
        cfg.triggerRules.push({
            id,
            name: `新触发规则_${cfg.triggerRules.length + 1}`,
            enabled: true,
            scope: 'any_ally',
            unitId: cfg.allies[0]?.id || '',
            conditionType: 'gauge_a',
            operator: '>=',
            threshold: 100,
            statusId: '',
            grantStatusIds: [],
            grantStatusMode: 'while_condition',
            resetGaugeOnTrigger: '',
            position: 'in_chat',
            depth: 1,
            role: 'system',
            promptText: '[系统战斗事件] {{unit_name}} 触发了特殊阈值条件，请在接下来的剧情中描写对应变化。',
        });
        commitChange(true, `rl:${id}`);
    });

    function renderRulesList(preserveOpen) {
        const cfg = deps.getConfig();
        const openSet = preserveOpen ? captureOpenCardKeys(elRulesEditor) : new Set();
        const gaugeEntries = getGaugeEntries(cfg);
        const allUnits = [...(cfg.allies || []), ...(cfg.enemies || [])];

        elRulesEditor.innerHTML = (cfg.triggerRules || []).map((r, idx) => {
            const cardKey = `rl:${r.id}`;
            const isOpen = openSet.has(cardKey) || forceOpenKey === cardKey;
            const unitOptions = allUnits.map(u =>
                `<option value="${escapeHtml(u.id)}" ${r.unitId === u.id ? 'selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(u.id)})</option>`
            ).join('');
            const isStatusCond = r.conditionType === 'has_status';
            const isSpecificUnit = r.scope === 'specific_unit';
            const grantIds = Array.isArray(r.grantStatusIds) ? r.grantStatusIds : [];

            return `
                <details class="stcf-item-card stcf-fold" data-index="${idx}" data-card-key="${escapeHtml(cardKey)}" ${isOpen ? 'open' : ''}>
                    <summary class="stcf-fold-summary">
                        <span class="stcf-fold-title">
                            ${r.enabled ? '📌' : '⬜'} <strong>${escapeHtml(r.name)}</strong>
                            <small class="stcf-muted">${grantIds.length ? `附${grantIds.length}状态` : ''}${r.promptText?.trim() ? ' · 含Prompt' : ''}</small>
                        </span>
                        <span class="stcf-fold-right">
                            <button type="button" class="stcf-del-btn" data-action="delete" title="删除规则">🗑️</button>
                        </span>
                    </summary>
                    <div class="stcf-fold-body">
                        <div class="stcf-item-head">
                            <label class="stcf-inline-check">
                                <input type="checkbox" data-field="enabled" ${r.enabled ? 'checked' : ''}>
                                <strong>启用</strong>
                            </label>
                            <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(r.name)}" placeholder="规则名称">
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>监测对象范围</span>
                                <select class="text_pole" data-field="scope">
                                    <option value="any_ally" ${r.scope === 'any_ally' ? 'selected' : ''}>任意我方角色</option>
                                    <option value="all_allies" ${r.scope === 'all_allies' ? 'selected' : ''}>全体我方角色</option>
                                    <option value="any_enemy" ${r.scope === 'any_enemy' ? 'selected' : ''}>任意敌方角色</option>
                                    <option value="all_enemies" ${r.scope === 'all_enemies' ? 'selected' : ''}>全体敌方角色</option>
                                    <option value="specific_unit" ${r.scope === 'specific_unit' ? 'selected' : ''}>指定某个角色</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field ${isSpecificUnit ? '' : 'stcf-hidden'}"><span>指定角色</span>
                                <select class="text_pole" data-field="unitId">${unitOptions}</select>
                            </label>
                        </div>
                        <div class="stcf-grid-3">
                            <label class="stcf-mini-field"><span>监测条件</span>
                                <select class="text_pole" data-field="conditionType">
                                    <option value="hp" ${r.conditionType === 'hp' ? 'selected' : ''}>当前 HP 数值</option>
                                    <option value="hp_percent" ${r.conditionType === 'hp_percent' ? 'selected' : ''}>当前 HP 百分比(%)</option>
                                    <option value="mp" ${r.conditionType === 'mp' ? 'selected' : ''}>当前 MP 数值</option>
                                    ${gaugeEntries.map(g => `<option value="${escapeHtml(g.id)}" ${r.conditionType === g.id ? 'selected' : ''}>${escapeHtml(g.name)} (${g.min}~${g.max})</option>`).join('')}
                                    <option value="has_status" ${r.conditionType === 'has_status' ? 'selected' : ''}>持有指定状态</option>
                                </select>
                            </label>
                            ${isStatusCond ? `
                                <label class="stcf-mini-field stcf-span-2"><span>监测状态</span>
                                    <select class="text_pole" data-field="statusId">${buildStatusSelectOptions(cfg, r.statusId, '请选择状态...')}</select>
                                </label>
                            ` : `
                                <label class="stcf-mini-field"><span>判断符号</span>
                                    <select class="text_pole" data-field="operator">
                                        <option value="<=" ${r.operator === '<=' ? 'selected' : ''}>&lt;= 小于等于</option>
                                        <option value="<" ${r.operator === '<' ? 'selected' : ''}>&lt; 小于</option>
                                        <option value=">=" ${r.operator === '>=' ? 'selected' : ''}>&gt;= 大于等于</option>
                                        <option value=">" ${r.operator === '>' ? 'selected' : ''}>&gt; 大于</option>
                                        <option value="==" ${r.operator === '==' ? 'selected' : ''}>== 等于</option>
                                    </select>
                                </label>
                                <label class="stcf-mini-field"><span>触发阈值</span>
                                    <input type="number" class="text_pole" data-field="threshold" value="${r.threshold}">
                                </label>
                            `}
                        </div>
                        <div class="stcf-grid-2">
                            <label class="stcf-mini-field"><span>状态挂载模式</span>
                                <select class="text_pole" data-field="grantStatusMode">
                                    <option value="while_condition" ${r.grantStatusMode !== 'on_enter' ? 'selected' : ''}>条件维持期间生效(解除即移除)</option>
                                    <option value="on_enter" ${r.grantStatusMode === 'on_enter' ? 'selected' : ''}>刚达标时挂载一次(按回合倒计时)</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>触发后清零状态槽(仅达标一次)</span>
                                <select class="text_pole" data-field="resetGaugeOnTrigger">
                                    <option value="" ${!r.resetGaugeOnTrigger ? 'selected' : ''}>不清零</option>
                                    ${gaugeEntries.map(g => `<option value="${escapeHtml(g.id)}" ${r.resetGaugeOnTrigger === g.id ? 'selected' : ''}>重置 ${escapeHtml(g.name)} 为 ${g.min}</option>`).join('')}
                                </select>
                            </label>
                        </div>
                        <details class="stcf-sub-fold">
                            <summary>⚡ 达标自动附加状态（支持多选 · 已选 ${grantIds.length} 项）</summary>
                            <div class="stcf-sub-body stcf-chips-wrap">${renderStatusCheckChips(cfg, grantIds, 'data-rule-grant-status')}</div>
                        </details>
                        <div class="stcf-grid-3" style="margin-top:6px;">
                            <label class="stcf-mini-field"><span>提示词注入位置</span>
                                <select class="text_pole" data-field="position">
                                    <option value="in_chat" ${r.position === 'in_chat' ? 'selected' : ''}>聊天深度插入(推荐)</option>
                                    <option value="in_prompt" ${r.position === 'in_prompt' ? 'selected' : ''}>主提示词内</option>
                                    <option value="before_prompt" ${r.position === 'before_prompt' ? 'selected' : ''}>主提示词前</option>
                                </select>
                            </label>
                            <label class="stcf-mini-field"><span>插入深度</span><input type="number" min="0" max="20" class="text_pole" data-field="depth" value="${r.depth}"></label>
                            <label class="stcf-mini-field"><span>消息角色</span>
                                <select class="text_pole" data-field="role">
                                    <option value="system" ${r.role === 'system' ? 'selected' : ''}>System</option>
                                    <option value="user" ${r.role === 'user' ? 'selected' : ''}>User</option>
                                    <option value="assistant" ${r.role === 'assistant' ? 'selected' : ''}>Assistant</option>
                                </select>
                            </label>
                        </div>
                        <div class="stcf-field-row" style="margin-bottom:0;">
                            <label>自动注入的剧情引导提示词（留空则仅触发 Buff）：</label>
                            <textarea class="text_pole stcf-prompt-textarea" rows="3" data-field="promptText">${escapeHtml(r.promptText)}</textarea>
                        </div>
                    </div>
                </details>
            `;
        }).join('');
    }

    elRulesEditor.addEventListener('change', (e) => {
        if (!e.target.dataset.ruleGrantStatus) return;
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const rule = deps.getConfig().triggerRules[Number(card.dataset.index)];
        if (!rule) return;
        const set = new Set(rule.grantStatusIds || []);
        if (e.target.checked) set.add(e.target.dataset.ruleGrantStatus);
        else set.delete(e.target.dataset.ruleGrantStatus);
        rule.grantStatusIds = [...set];
        commitChange();
    });
    bindSimpleListEvents(elRulesEditor, () => deps.getConfig().triggerRules, ['scope', 'conditionType', 'enabled']);

    function bindSimpleListEvents(hostEl, getListFn, reRenderFields = []) {
        hostEl.addEventListener('input', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card || !e.target.dataset.field || e.target.type === 'checkbox') return;
            const item = getListFn()[Number(card.dataset.index)];
            if (!item) return;
            item[e.target.dataset.field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
            commitChange();
        });
        hostEl.addEventListener('change', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card || !e.target.dataset.field) return;
            const item = getListFn()[Number(card.dataset.index)];
            if (!item) return;
            const field = e.target.dataset.field;
            if (e.target.type === 'checkbox') item[field] = e.target.checked;
            else item[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
            commitChange(reRenderFields.includes(field));
        });
        hostEl.addEventListener('click', (e) => {
            const dupBtn = e.target.closest('[data-action="duplicate"]');
            if (dupBtn) {
                e.preventDefault();
                const card = dupBtn.closest('.stcf-item-card');
                const list = getListFn();
                const idx = Number(card.dataset.index);
                const orig = list[idx];
                if (!orig) return;
                const clone = JSON.parse(JSON.stringify(orig));
                const prefix = (orig.id || 'item').split('_')[0] || 'copy';
                clone.id = makeUniqueId(prefix, list);
                clone.name = `${orig.name}(副本)`;
                list.splice(idx + 1, 0, clone);
                commitChange(true);
                return;
            }
            const delBtn = e.target.closest('[data-action="delete"]');
            if (!delBtn) return;
            e.preventDefault();
            const card = delBtn.closest('.stcf-item-card');
            getListFn().splice(Number(card.dataset.index), 1);
            commitChange(true);
        });
    }

    function renderAll(preserveOpen = false) {
        const cfg = deps.getConfig();
        const profileInfo = getCurrentProfileInfo();
        const usePerChar = cfg.general.usePerCharacterConfig !== false;
        elProfileBanner.textContent = usePerChar && profileInfo.key
            ? `📂 当前编辑：${profileInfo.label}`
            : '🌐 当前编辑：全局共用方案（所有角色卡共享）';

        elEnabled.checked = cfg.general.enabled !== false;
        elPerChar.checked = usePerChar;
        elMvuSync.checked = cfg.general.mvuSyncEnabled !== false;
        elMvuWriteBack.checked = cfg.general.mvuWriteBack !== false;
        elMvuInherit.checked = cfg.general.mvuInheritVitalsOnStart !== false;
        elMvuStatuses.checked = cfg.general.mvuSyncStatuses !== false;
        elListenAi.checked = cfg.general.listenAiEvents !== false;
        elSyncParty.checked = cfg.general.syncPartyToAi !== false;
        elSyncBattle.checked = cfg.general.syncBattleToAi !== false;
        elSyncCatalog.checked = cfg.general.syncCatalogToAi !== false;
        if (elAuthoringMode) elAuthoringMode.checked = Boolean(cfg.general.authoringMode);
        elHudCollapsed.checked = cfg.general.hudStartCollapsed !== false;
        elAutoEndTurn.checked = cfg.general.autoEndPlayerTurn !== false;
        elOutputMode.value = cfg.general.outputMode || 'fill_input';
        elFillStrategy.value = cfg.general.inputFillStrategy || 'append';
        elLogHeader.value = cfg.general.logHeaderTemplate || '';

        const prog = cfg.progression || { enabled: true, pointsPerLevel: 3, statGains: {} };
        const gains = prog.statGains || {};
        elProgEnabled.checked = prog.enabled !== false;
        elPtsPerLv.value = String(prog.pointsPerLevel ?? 3);
        elGainVit.value = String(gains.vitHp ?? 15);
        elGainStr.value = String(gains.strAtk ?? 2);
        elGainSpiMag.value = String(gains.spiMag ?? 2);
        elGainSpiMp.value = String(gains.spiMp ?? 8);
        elGainDef.value = String(gains.defPhys ?? 2);
        elGainMdef.value = String(gains.mdefMag ?? 2);

        renderGaugesList(preserveOpen);
        renderWorldviewsPicker();
        renderClassesList(preserveOpen);
        renderUnitsList('ally', elAlliesEditor, preserveOpen);
        renderUnitsList('enemy', elEnemiesEditor, preserveOpen);
        renderSkillsList(preserveOpen);
        renderEquipmentsList(preserveOpen);
        renderItemsList(preserveOpen);
        renderStatusesList(preserveOpen);
        renderRulesList(preserveOpen);
    }

    renderAll(false);

    return { renderAll: () => renderAll(true) };
}
