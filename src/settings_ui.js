/**
 * 扩展侧边栏可视化配置面板模块 (src/settings_ui.js) - v1.1
 * 职责：
 * 1. 全可视化零代码编辑：角色(4v4)、技能、装备（含附带技能与常驻 Buff）、道具、状态、阈值规则（含自动 Buff + Prompt 注入）
 * 2. 支持「按角色卡独立保存方案」与「粘贴 JSON 增量合并导入」（完美配合写卡助手）
 * 3. 所有修改即时保存并同步刷新战斗 HUD 与提示词注入状态
 */

import {
    MAX_UNITS_PER_SIDE,
    exportConfigAsJson,
    getCurrentProfileInfo,
    importConfigFromJsonText,
    loadConfig,
    resetConfigToDefaults,
    saveAsGlobalTemplate,
    saveConfig,
} from './config.js';

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

    const elProfileBanner = container.querySelector('#stcf-profile-banner');
    const elIoStatus = container.querySelector('#stcf-io-status');
    function setIoStatus(msg, isError = false) {
        if (!elIoStatus) return;
        elIoStatus.textContent = msg;
        elIoStatus.classList.toggle('stcf-text-error', isError);
    }

    function commitChange(reRenderLists = false) {
        const cfg = deps.getConfig();
        saveConfig(cfg);
        deps.onConfigChanged();
        if (reRenderLists) renderAll();
    }

    // =========================================================================
    // 一、基础设置与导入导出绑定
    // =========================================================================
    const elEnabled = container.querySelector('#stcf-set-enabled');
    const elPerChar = container.querySelector('#stcf-set-per-char');
    const elMvuSync = container.querySelector('#stcf-set-mvu-sync');
    const elMvuWriteBack = container.querySelector('#stcf-set-mvu-writeback');
    const elMvuInherit = container.querySelector('#stcf-set-mvu-inherit');
    const elListenAi = container.querySelector('#stcf-set-listen-ai');
    const elSyncParty = container.querySelector('#stcf-set-sync-party');
    const elSyncBattle = container.querySelector('#stcf-set-sync-battle');
    const elSyncCatalog = container.querySelector('#stcf-set-sync-catalog');
    const elHudCollapsed = container.querySelector('#stcf-set-hud-collapsed');
    const elAutoEndTurn = container.querySelector('#stcf-set-auto-end-turn');
    const elOutputMode = container.querySelector('#stcf-set-output-mode');
    const elFillStrategy = container.querySelector('#stcf-set-fill-strategy');
    const elLogHeader = container.querySelector('#stcf-set-log-header');
    const elGaugeAName = container.querySelector('#stcf-set-gauge-a-name');
    const elGaugeAColor = container.querySelector('#stcf-set-gauge-a-color');
    const elGaugeATick = container.querySelector('#stcf-set-gauge-a-tick');
    const elGaugeAScope = container.querySelector('#stcf-set-gauge-a-scope');
    const elGaugeBName = container.querySelector('#stcf-set-gauge-b-name');
    const elGaugeBColor = container.querySelector('#stcf-set-gauge-b-color');
    const elGaugeBTick = container.querySelector('#stcf-set-gauge-b-tick');
    const elGaugeBScope = container.querySelector('#stcf-set-gauge-b-scope');
    const elPasteJson = container.querySelector('#stcf-paste-json');

    elEnabled.addEventListener('change', () => { deps.getConfig().general.enabled = elEnabled.checked; commitChange(); });
    elPerChar.addEventListener('change', async () => {
        deps.getConfig().general.usePerCharacterConfig = elPerChar.checked;
        saveConfig(deps.getConfig());
        const reloaded = await loadConfig();
        deps.setConfig(reloaded);
        renderAll();
        deps.onConfigChanged();
        setIoStatus(elPerChar.checked ? '✅ 已开启按角色卡独立保存方案' : '✅ 已切换为全局共用方案');
    });
    elMvuSync.addEventListener('change', () => { deps.getConfig().general.mvuSyncEnabled = elMvuSync.checked; commitChange(); });
    elMvuWriteBack.addEventListener('change', () => { deps.getConfig().general.mvuWriteBack = elMvuWriteBack.checked; commitChange(); });
    elMvuInherit.addEventListener('change', () => { deps.getConfig().general.mvuInheritVitalsOnStart = elMvuInherit.checked; commitChange(); });
    elListenAi.addEventListener('change', () => { deps.getConfig().general.listenAiEvents = elListenAi.checked; commitChange(); });
    elSyncParty.addEventListener('change', () => { deps.getConfig().general.syncPartyToAi = elSyncParty.checked; commitChange(); });
    elSyncBattle.addEventListener('change', () => { deps.getConfig().general.syncBattleToAi = elSyncBattle.checked; commitChange(); });
    elSyncCatalog.addEventListener('change', () => { deps.getConfig().general.syncCatalogToAi = elSyncCatalog.checked; commitChange(); });
    elHudCollapsed.addEventListener('change', () => { deps.getConfig().general.hudStartCollapsed = elHudCollapsed.checked; commitChange(); });
    elAutoEndTurn.addEventListener('change', () => { deps.getConfig().general.autoEndPlayerTurn = elAutoEndTurn.checked; commitChange(); });
    elOutputMode.addEventListener('change', () => { deps.getConfig().general.outputMode = elOutputMode.value; commitChange(); });
    elFillStrategy.addEventListener('change', () => { deps.getConfig().general.inputFillStrategy = elFillStrategy.value; commitChange(); });
    elLogHeader.addEventListener('input', () => { deps.getConfig().general.logHeaderTemplate = elLogHeader.value; commitChange(); });
    elGaugeAName.addEventListener('input', () => { deps.getConfig().gauges.gauge_a.name = elGaugeAName.value || '状态槽A'; commitChange(); });
    elGaugeAColor.addEventListener('input', () => { deps.getConfig().gauges.gauge_a.color = elGaugeAColor.value; commitChange(); });
    elGaugeATick.addEventListener('input', () => { deps.getConfig().gauges.gauge_a.perTurnChange = Math.round(Number(elGaugeATick.value) || 0); commitChange(); });
    elGaugeAScope.addEventListener('change', () => { deps.getConfig().gauges.gauge_a.perTurnScope = elGaugeAScope.value; commitChange(); });
    elGaugeBName.addEventListener('input', () => { deps.getConfig().gauges.gauge_b.name = elGaugeBName.value || '状态槽B'; commitChange(); });
    elGaugeBColor.addEventListener('input', () => { deps.getConfig().gauges.gauge_b.color = elGaugeBColor.value; commitChange(); });
    elGaugeBTick.addEventListener('input', () => { deps.getConfig().gauges.gauge_b.perTurnChange = Math.round(Number(elGaugeBTick.value) || 0); commitChange(); });
    elGaugeBScope.addEventListener('change', () => { deps.getConfig().gauges.gauge_b.perTurnScope = elGaugeBScope.value; commitChange(); });

    // 粘贴 JSON 导入（增量合并 / 完整覆盖）
    async function handlePasteImport(mode) {
        const text = elPasteJson.value.trim();
        if (!text) {
            setIoStatus('⚠️ 请先在文本框里粘贴 JSON 内容。', true);
            return;
        }
        try {
            const { config: nextCfg, summary } = await importConfigFromJsonText(text, mode, deps.getConfig());
            deps.setConfig(nextCfg);
            renderAll();
            deps.onConfigChanged();
            elPasteJson.value = '';
            setIoStatus(`✅ ${summary}`);
        } catch (err) {
            setIoStatus(`❌ 导入失败：${err.message}`, true);
        }
    }

    container.querySelector('#stcf-btn-merge-paste').addEventListener('click', () => handlePasteImport('merge'));
    container.querySelector('#stcf-btn-replace-paste').addEventListener('click', () => {
        if (!window.confirm('完整覆盖会替换当前方案的全部内容，确定继续吗？（若只想追加新装备/技能，请点「增量合并导入」）')) return;
        handlePasteImport('replace');
    });

    // 文件导出/导入
    container.querySelector('#stcf-btn-export-json').addEventListener('click', () => {
        exportConfigAsJson(deps.getConfig());
        setIoStatus('✅ 已触发 JSON 文件下载。');
    });

    let pendingFileMode = 'replace';
    const elFileInput = container.querySelector('#stcf-file-import-json');
    container.querySelector('#stcf-btn-import-merge-file').addEventListener('click', () => {
        pendingFileMode = 'merge';
        elFileInput.value = '';
        elFileInput.click();
    });
    container.querySelector('#stcf-btn-import-json').addEventListener('click', () => {
        pendingFileMode = 'replace';
        elFileInput.value = '';
        elFileInput.click();
    });
    elFileInput.addEventListener('change', async () => {
        const file = elFileInput.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const { config: imported, summary } = await importConfigFromJsonText(text, pendingFileMode, deps.getConfig());
            deps.setConfig(imported);
            renderAll();
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
        renderAll();
        deps.onConfigChanged();
        setIoStatus('✅ 已恢复为 default_config.json 默认配置。');
    });

    // =========================================================================
    // 二、参战角色（我方 1~4 / 敌方 1~4，含技能与装备勾选）
    // =========================================================================
    const elAlliesEditor = container.querySelector('#stcf-allies-editor');
    const elEnemiesEditor = container.querySelector('#stcf-enemies-editor');

    function addUnit(side) {
        const cfg = deps.getConfig();
        const list = side === 'ally' ? cfg.allies : cfg.enemies;
        if (side === 'ally' && list.length >= MAX_UNITS_PER_SIDE) {
            window.alert(`我方最多支持 ${MAX_UNITS_PER_SIDE} 名参战角色（最多 4v4）。`);
            return;
        }
        list.push({
            id: makeUniqueId(side, list),
            enabled: side === 'ally' ? true : list.filter(x => x.enabled).length < MAX_UNITS_PER_SIDE,
            name: side === 'ally' ? `我方角色${list.length + 1}` : `敌方目标${list.length + 1}`,
            description: side === 'ally' ? '我方参战成员简短定位说明' : '敌方单位外观特征与战斗风格简述',
            maxHp: 100,
            maxMp: 50,
            atk: 20,
            def: 8,
            initialGaugeA: 0,
            initialGaugeB: 0,
            skillIds: cfg.skills[0] ? [cfg.skills[0].id] : [],
            equipmentIds: [],
            aiStrategy: 'priority',
            autoControl: false,
        });
        commitChange(true);
    }

    container.querySelector('#stcf-btn-add-ally').addEventListener('click', () => addUnit('ally'));
    container.querySelector('#stcf-btn-add-enemy').addEventListener('click', () => addUnit('enemy'));

    function renderUnitsList(side, hostEl) {
        const cfg = deps.getConfig();
        const list = side === 'ally' ? cfg.allies : cfg.enemies;
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';

        hostEl.innerHTML = list.map((u, idx) => {
            const skillChecks = (cfg.skills || []).map(sk => `
                <label class="stcf-chip-check">
                    <input type="checkbox" data-unit-skill="${escapeHtml(sk.id)}" ${(u.skillIds || []).includes(sk.id) ? 'checked' : ''}>
                    <span>${escapeHtml(sk.name)}</span>
                </label>
            `).join('');

            const equipChecks = (cfg.equipments || []).map(eq => `
                <label class="stcf-chip-check">
                    <input type="checkbox" data-unit-equip="${escapeHtml(eq.id)}" ${(u.equipmentIds || []).includes(eq.id) ? 'checked' : ''}>
                    <span>🛡️ ${escapeHtml(eq.name)}</span>
                </label>
            `).join('');

            return `
                <div class="stcf-item-card" data-side="${side}" data-index="${idx}">
                    <div class="stcf-item-head">
                        <label class="stcf-inline-check">
                            <input type="checkbox" data-field="enabled" ${u.enabled ? 'checked' : ''}>
                            <strong>出战</strong>
                        </label>
                        <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(u.name)}" placeholder="角色名称">
                        <span class="stcf-id-tag">${escapeHtml(u.id)}</span>
                        ${list.length > 1 ? '<button type="button" class="stcf-del-btn" data-action="delete" title="删除角色">🗑️</button>' : ''}
                    </div>
                    <div class="stcf-field-row">
                        <input type="text" class="text_pole" data-field="description" value="${escapeHtml(u.description || '')}" placeholder="一句话简约描述（如：重甲敌兵，擅长破防；会同步给剧情 AI 查阅）">
                    </div>
                    <div class="stcf-grid-4">
                        <label class="stcf-mini-field"><span>基础 HP</span><input type="number" min="1" class="text_pole" data-field="maxHp" value="${u.maxHp}"></label>
                        <label class="stcf-mini-field"><span>基础 MP</span><input type="number" min="0" class="text_pole" data-field="maxMp" value="${u.maxMp}"></label>
                        <label class="stcf-mini-field"><span>基础攻击</span><input type="number" min="0" class="text_pole" data-field="atk" value="${u.atk}"></label>
                        <label class="stcf-mini-field"><span>基础防御</span><input type="number" min="0" class="text_pole" data-field="def" value="${u.def}"></label>
                        <label class="stcf-mini-field"><span>初始${escapeHtml(gAName)}</span><input type="number" min="0" max="100" class="text_pole" data-field="initialGaugeA" value="${u.initialGaugeA}"></label>
                        <label class="stcf-mini-field"><span>初始${escapeHtml(gBName)}</span><input type="number" min="0" max="100" class="text_pole" data-field="initialGaugeB" value="${u.initialGaugeB}"></label>
                    </div>
                    <div class="stcf-grid-2">
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
                                <span>🤖 自动托管 AI（我方自动出招）</span>
                            </label>
                        ` : '<div></div>'}
                    </div>
                    <div class="stcf-skill-assign">
                        <div class="stcf-sub-label">可用技能：</div>
                        <div class="stcf-chips-wrap">${skillChecks || '<span class="stcf-muted">暂无技能</span>'}</div>
                    </div>
                    <div class="stcf-skill-assign" style="margin-top:6px;">
                        <div class="stcf-sub-label">初始穿戴装备：</div>
                        <div class="stcf-chips-wrap">${equipChecks || '<span class="stcf-muted">暂无装备</span>'}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function bindUnitsEvents(hostEl) {
        hostEl.addEventListener('input', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card || !e.target.dataset.field || e.target.type === 'checkbox') return;
            const cfg = deps.getConfig();
            const list = card.dataset.side === 'ally' ? cfg.allies : cfg.enemies;
            const unit = list[Number(card.dataset.index)];
            if (!unit) return;
            const field = e.target.dataset.field;
            unit[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
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
                commitChange();
            } else if (e.target.dataset.field === 'autoControl') {
                unit.autoControl = e.target.checked;
                commitChange();
            } else if (e.target.dataset.field === 'aiStrategy') {
                unit.aiStrategy = e.target.value;
                commitChange();
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
    // 三、技能库编辑器
    // =========================================================================
    const elSkillsEditor = container.querySelector('#stcf-skills-editor');
    container.querySelector('#stcf-btn-add-skill').addEventListener('click', () => {
        const cfg = deps.getConfig();
        cfg.skills.push({
            id: makeUniqueId('skill', cfg.skills),
            name: `新技能_${cfg.skills.length + 1}`,
            description: '自定义技能说明',
            mpCost: 10,
            targetType: 'single_enemy',
            effectType: 'damage',
            formula: 'max(1, atk * 1.2 - target_def * 0.4)',
            selfGaugeAChange: 0,
            selfGaugeBChange: 0,
            targetGaugeAChange: 0,
            targetGaugeBChange: 0,
            applyStatusId: '',
            applyStatusChance: 100,
            applyStatusTarget: 'target',
            requiredTargetStatusIds: [],
            aiPriority: 10,
            aiHpBelowPercent: 100,
        });
        commitChange(true);
    });

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
                `<option value="${escapeHtml(sk.id)}" ${selectedId === sk.id ? 'selected' : ''}>${escapeHtml(sk.name)} (${escapeHtml(sk.id)})</option>`
            ),
        ].join('');
    }

    function renderSkillsList() {
        const cfg = deps.getConfig();
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';

        elSkillsEditor.innerHTML = (cfg.skills || []).map((sk, idx) => `
            <div class="stcf-item-card" data-index="${idx}">
                <div class="stcf-item-head">
                    <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(sk.name)}" placeholder="技能名称">
                    <span class="stcf-id-tag">${escapeHtml(sk.id)}</span>
                    <button type="button" class="stcf-del-btn" data-action="delete" title="删除技能">🗑️</button>
                </div>
                <div class="stcf-field-row">
                    <input type="text" class="text_pole" data-field="description" value="${escapeHtml(sk.description)}" placeholder="技能描述">
                </div>
                <div class="stcf-grid-3">
                    <label class="stcf-mini-field"><span>消耗 MP</span><input type="number" min="0" class="text_pole" data-field="mpCost" value="${sk.mpCost}"></label>
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
                        </select>
                    </label>
                </div>
                <div class="stcf-field-row">
                    <label>数值公式：</label>
                    <input type="text" class="text_pole" data-field="formula" value="${escapeHtml(sk.formula)}">
                </div>
                <div class="stcf-grid-4">
                    <label class="stcf-mini-field"><span>自身${escapeHtml(gAName)}</span><input type="number" class="text_pole" data-field="selfGaugeAChange" value="${sk.selfGaugeAChange}"></label>
                    <label class="stcf-mini-field"><span>自身${escapeHtml(gBName)}</span><input type="number" class="text_pole" data-field="selfGaugeBChange" value="${sk.selfGaugeBChange}"></label>
                    <label class="stcf-mini-field"><span>目标${escapeHtml(gAName)}</span><input type="number" class="text_pole" data-field="targetGaugeAChange" value="${sk.targetGaugeAChange}"></label>
                    <label class="stcf-mini-field"><span>目标${escapeHtml(gBName)}</span><input type="number" class="text_pole" data-field="targetGaugeBChange" value="${sk.targetGaugeBChange}"></label>
                </div>
                <div class="stcf-grid-3">
                    <label class="stcf-mini-field"><span>附加状态</span>
                        <select class="text_pole" data-field="applyStatusId">${buildStatusSelectOptions(cfg, sk.applyStatusId, '无附加状态')}</select>
                    </label>
                    <label class="stcf-mini-field"><span>附加概率(%)</span><input type="number" min="0" max="100" class="text_pole" data-field="applyStatusChance" value="${sk.applyStatusChance}"></label>
                    <label class="stcf-mini-field"><span>状态施加给</span>
                        <select class="text_pole" data-field="applyStatusTarget">
                            <option value="target" ${sk.applyStatusTarget !== 'self' ? 'selected' : ''}>技能目标</option>
                            <option value="self" ${sk.applyStatusTarget === 'self' ? 'selected' : ''}>释放者自己</option>
                        </select>
                    </label>
                </div>
                <div class="stcf-grid-2">
                    <label class="stcf-mini-field"><span>AI 释放优先级（越大越优先）</span><input type="number" min="1" class="text_pole" data-field="aiPriority" value="${sk.aiPriority ?? 10}"></label>
                    <label class="stcf-mini-field"><span>AI 仅在 HP ≤ (%) 时释放（100=不限）</span><input type="number" min="1" max="100" class="text_pole" data-field="aiHpBelowPercent" value="${sk.aiHpBelowPercent ?? 100}" title="治疗技判断友方血量%，攻击/自身技判断释放者自身血量%"></label>
                </div>
                <div class="stcf-skill-assign" style="margin-top:6px;">
                    <div class="stcf-sub-label">🔒 释放前置状态（目标持有以下<strong>任意 1 个</strong>才可释放，全不勾则无限制）：</div>
                    <div class="stcf-chips-wrap">
                        ${(cfg.statuses || []).map(st => `
                            <label class="stcf-chip-check">
                                <input type="checkbox" data-skill-req-status="${escapeHtml(st.id)}" ${(sk.requiredTargetStatusIds || []).includes(st.id) ? 'checked' : ''}>
                                <span>${escapeHtml(st.icon)} ${escapeHtml(st.name)}</span>
                            </label>
                        `).join('') || '<span class="stcf-muted">暂无状态</span>'}
                    </div>
                </div>
            </div>
        `).join('');
    }

    elSkillsEditor.addEventListener('change', (e) => {
        if (!e.target.dataset.skillReqStatus) return;
        const card = e.target.closest('.stcf-item-card');
        if (!card) return;
        const skill = deps.getConfig().skills[Number(card.dataset.index)];
        if (!skill) return;
        const set = new Set(skill.requiredTargetStatusIds || []);
        if (e.target.checked) set.add(e.target.dataset.skillReqStatus);
        else set.delete(e.target.dataset.skillReqStatus);
        skill.requiredTargetStatusIds = [...set];
        commitChange();
    });

    bindSimpleListEvents(elSkillsEditor, () => deps.getConfig().skills, ['name']);

    // =========================================================================
    // 四、装备库编辑器（v1.1 新增：含附带技能与常驻 Buff）
    // =========================================================================
    const elEquipsEditor = container.querySelector('#stcf-equipments-editor');
    container.querySelector('#stcf-btn-add-equip').addEventListener('click', () => {
        const cfg = deps.getConfig();
        cfg.equipments.push({
            id: makeUniqueId('equip', cfg.equipments),
            name: `新装备_${cfg.equipments.length + 1}`,
            slot: 'head',
            description: '自定义装备说明',
            bonusHp: 0,
            bonusMp: 0,
            bonusAtk: 0,
            bonusDef: 5,
            grantSkillId: '',
            passiveStatusId: '',
        });
        commitChange(true);
    });

    function renderEquipmentsList() {
        const cfg = deps.getConfig();
        elEquipsEditor.innerHTML = (cfg.equipments || []).map((eq, idx) => `
            <div class="stcf-item-card" data-index="${idx}">
                <div class="stcf-item-head">
                    <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(eq.name)}" placeholder="装备名称（如：铁帽子）">
                    <span class="stcf-id-tag">${escapeHtml(eq.id)}</span>
                    <button type="button" class="stcf-del-btn" data-action="delete" title="删除装备">🗑️</button>
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
                    <label class="stcf-mini-field"><span>说明</span>
                        <input type="text" class="text_pole" data-field="description" value="${escapeHtml(eq.description)}" placeholder="装备描述">
                    </label>
                </div>
                <div class="stcf-grid-4">
                    <label class="stcf-mini-field"><span>生命加成 HP</span><input type="number" class="text_pole" data-field="bonusHp" value="${eq.bonusHp}"></label>
                    <label class="stcf-mini-field"><span>体力加成 MP</span><input type="number" class="text_pole" data-field="bonusMp" value="${eq.bonusMp}"></label>
                    <label class="stcf-mini-field"><span>攻击加成 ATK</span><input type="number" class="text_pole" data-field="bonusAtk" value="${eq.bonusAtk}"></label>
                    <label class="stcf-mini-field"><span>防御加成 DEF</span><input type="number" class="text_pole" data-field="bonusDef" value="${eq.bonusDef}"></label>
                </div>
                <div class="stcf-grid-2">
                    <label class="stcf-mini-field"><span>穿戴附带常驻 Buff</span>
                        <select class="text_pole" data-field="passiveStatusId">${buildStatusSelectOptions(cfg, eq.passiveStatusId, '无常驻 Buff')}</select>
                    </label>
                    <label class="stcf-mini-field"><span>穿戴解锁专属技能</span>
                        <select class="text_pole" data-field="grantSkillId">${buildSkillSelectOptions(cfg, eq.grantSkillId, '无附带技能')}</select>
                    </label>
                </div>
            </div>
        `).join('');
    }

    bindSimpleListEvents(elEquipsEditor, () => deps.getConfig().equipments, ['name']);

    // =========================================================================
    // 五、道具库编辑器（v1.1 新增）
    // =========================================================================
    const elItemsEditor = container.querySelector('#stcf-items-editor');
    container.querySelector('#stcf-btn-add-item').addEventListener('click', () => {
        const cfg = deps.getConfig();
        cfg.items.push({
            id: makeUniqueId('item', cfg.items),
            name: `新道具_${cfg.items.length + 1}`,
            icon: '🧪',
            description: '自定义消耗品说明',
            quantity: 3,
            targetType: 'single_ally',
            effectType: 'heal',
            formula: '40',
            targetGaugeAChange: 0,
            targetGaugeBChange: 0,
            applyStatusId: '',
            applyStatusChance: 100,
            consumesTurn: true,
        });
        commitChange(true);
    });

    function renderItemsList() {
        const cfg = deps.getConfig();
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';

        elItemsEditor.innerHTML = (cfg.items || []).map((it, idx) => `
            <div class="stcf-item-card" data-index="${idx}">
                <div class="stcf-item-head">
                    <input type="text" class="text_pole stcf-icon-input" data-field="icon" value="${escapeHtml(it.icon)}" title="图标">
                    <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(it.name)}" placeholder="道具名称">
                    <span class="stcf-id-tag">${escapeHtml(it.id)}</span>
                    <button type="button" class="stcf-del-btn" data-action="delete" title="删除道具">🗑️</button>
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
                    <label class="stcf-mini-field"><span>目标${escapeHtml(gAName)}</span><input type="number" class="text_pole" data-field="targetGaugeAChange" value="${it.targetGaugeAChange}"></label>
                    <label class="stcf-mini-field"><span>目标${escapeHtml(gBName)}</span><input type="number" class="text_pole" data-field="targetGaugeBChange" value="${it.targetGaugeBChange}"></label>
                </div>
                <div class="stcf-grid-2">
                    <label class="stcf-mini-field"><span>附加状态</span>
                        <select class="text_pole" data-field="applyStatusId">${buildStatusSelectOptions(cfg, it.applyStatusId, '无附加状态')}</select>
                    </label>
                    <label class="stcf-inline-check" style="margin-top:16px;">
                        <input type="checkbox" data-field="consumesTurn" ${it.consumesTurn !== false ? 'checked' : ''}>
                        <span>使用消耗行动回合</span>
                    </label>
                </div>
            </div>
        `).join('');
    }

    bindSimpleListEvents(elItemsEditor, () => deps.getConfig().items, []);

    // =========================================================================
    // 六、状态 / Buff 编辑器（v1.2：自由组合效果 + 多属性每回合变化 + 到期转化）
    // =========================================================================
    const elStatusesEditor = container.querySelector('#stcf-statuses-editor');
    container.querySelector('#stcf-btn-add-status').addEventListener('click', () => {
        const cfg = deps.getConfig();
        cfg.statuses.push({
            id: makeUniqueId('status', cfg.statuses),
            name: `新状态_${cfg.statuses.length + 1}`,
            icon: '✨',
            description: '自定义组合状态说明',
            skipTurn: false,
            perTurnHp: -10,
            perTurnMp: 0,
            perTurnGaugeA: 0,
            perTurnGaugeB: 0,
            atkMultiplier: 1,
            defMultiplier: 1,
            duration: 2,
            onExpireStatusId: '',
        });
        commitChange(true);
    });

    function renderStatusesList() {
        const cfg = deps.getConfig();
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';

        elStatusesEditor.innerHTML = (cfg.statuses || []).map((st, idx) => `
            <div class="stcf-item-card" data-index="${idx}">
                <div class="stcf-item-head">
                    <input type="text" class="text_pole stcf-icon-input" data-field="icon" value="${escapeHtml(st.icon)}" title="图标 Emoji">
                    <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(st.name)}" placeholder="状态名称">
                    <span class="stcf-id-tag">${escapeHtml(st.id)}</span>
                    <button type="button" class="stcf-del-btn" data-action="delete" title="删除状态">🗑️</button>
                </div>
                <div class="stcf-field-row">
                    <input type="text" class="text_pole" data-field="description" value="${escapeHtml(st.description)}" placeholder="状态效果说明">
                </div>
                <label class="stcf-checkbox-row" style="margin-bottom:6px;">
                    <input type="checkbox" data-field="skipTurn" ${st.skipTurn ? 'checked' : ''}>
                    <span>💫 跳过行动回合（眩晕/控制效果，可与下方任意属性效果自由叠加）</span>
                </label>
                <div class="stcf-grid-4">
                    <label class="stcf-mini-field"><span>每回合 HP</span><input type="number" class="text_pole" data-field="perTurnHp" value="${st.perTurnHp ?? 0}" title="负数扣血，正数回血"></label>
                    <label class="stcf-mini-field"><span>每回合 MP</span><input type="number" class="text_pole" data-field="perTurnMp" value="${st.perTurnMp ?? 0}" title="负数耗蓝，正数回蓝"></label>
                    <label class="stcf-mini-field"><span>每回合${escapeHtml(gAName)}</span><input type="number" class="text_pole" data-field="perTurnGaugeA" value="${st.perTurnGaugeA ?? 0}"></label>
                    <label class="stcf-mini-field"><span>每回合${escapeHtml(gBName)}</span><input type="number" class="text_pole" data-field="perTurnGaugeB" value="${st.perTurnGaugeB ?? 0}"></label>
                </div>
                <div class="stcf-grid-3">
                    <label class="stcf-mini-field"><span>攻击倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="atkMultiplier" value="${st.atkMultiplier}" title="1不变，1.3为+30%，0.7为-30%"></label>
                    <label class="stcf-mini-field"><span>防御倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="defMultiplier" value="${st.defMultiplier}"></label>
                    <label class="stcf-mini-field"><span>持续回合数</span><input type="number" min="1" class="text_pole" data-field="duration" value="${st.duration}"></label>
                </div>
                <div class="stcf-field-row" style="margin-bottom:0;">
                    <label>🔄 倒计时结束后自动转化为另一个状态：</label>
                    <select class="text_pole" data-field="onExpireStatusId">${buildStatusSelectOptions(cfg, st.onExpireStatusId, '无（结束直接移除）')}</select>
                </div>
            </div>
        `).join('');
    }

    bindSimpleListEvents(elStatusesEditor, () => deps.getConfig().statuses, ['name', 'icon']);

    // =========================================================================
    // 七、阈值触发规则编辑器（Prompt 注入 + 自动挂载 Buff + 触发后清零状态槽）
    // =========================================================================
    const elRulesEditor = container.querySelector('#stcf-rules-editor');
    container.querySelector('#stcf-btn-add-rule').addEventListener('click', () => {
        const cfg = deps.getConfig();
        cfg.triggerRules.push({
            id: makeUniqueId('rule', cfg.triggerRules),
            name: `新触发规则_${cfg.triggerRules.length + 1}`,
            enabled: true,
            scope: 'any_ally',
            unitId: cfg.allies[0]?.id || '',
            conditionType: 'gauge_a',
            operator: '>=',
            threshold: 100,
            statusId: '',
            grantStatusId: '',
            grantStatusMode: 'while_condition',
            resetGaugeOnTrigger: '',
            position: 'in_chat',
            depth: 1,
            role: 'system',
            promptText: '[系统战斗事件] {{unit_name}} 触发了特殊阈值条件，请在接下来的剧情中描写对应变化。',
        });
        commitChange(true);
    });

    function renderRulesList() {
        const cfg = deps.getConfig();
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';
        const allUnits = [...(cfg.allies || []), ...(cfg.enemies || [])];

        elRulesEditor.innerHTML = (cfg.triggerRules || []).map((r, idx) => {
            const unitOptions = allUnits.map(u =>
                `<option value="${escapeHtml(u.id)}" ${r.unitId === u.id ? 'selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(u.id)})</option>`
            ).join('');
            const isStatusCond = r.conditionType === 'has_status';
            const isSpecificUnit = r.scope === 'specific_unit';

            return `
                <div class="stcf-item-card" data-index="${idx}">
                    <div class="stcf-item-head">
                        <label class="stcf-inline-check">
                            <input type="checkbox" data-field="enabled" ${r.enabled ? 'checked' : ''}>
                            <strong>启用</strong>
                        </label>
                        <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(r.name)}" placeholder="规则名称">
                        <button type="button" class="stcf-del-btn" data-action="delete" title="删除规则">🗑️</button>
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
                                <option value="gauge_a" ${r.conditionType === 'gauge_a' ? 'selected' : ''}>${escapeHtml(gAName)} (0-100)</option>
                                <option value="gauge_b" ${r.conditionType === 'gauge_b' ? 'selected' : ''}>${escapeHtml(gBName)} (0-100)</option>
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

                    <!-- v1.1 新增：达标自动挂载 Buff/Debuff -->
                    <div class="stcf-grid-3">
                        <label class="stcf-mini-field"><span>⚡ 达标自动附加状态</span>
                            <select class="text_pole" data-field="grantStatusId">${buildStatusSelectOptions(cfg, r.grantStatusId, '不附加状态')}</select>
                        </label>
                        <label class="stcf-mini-field"><span>状态挂载模式</span>
                            <select class="text_pole" data-field="grantStatusMode">
                                <option value="while_condition" ${r.grantStatusMode !== 'on_enter' ? 'selected' : ''}>条件维持期间生效(解除即移除)</option>
                                <option value="on_enter" ${r.grantStatusMode === 'on_enter' ? 'selected' : ''}>刚达标时挂载一次(按回合倒计时)</option>
                            </select>
                        </label>
                        <label class="stcf-mini-field"><span>触发后清零状态槽(仅达标一次)</span>
                            <select class="text_pole" data-field="resetGaugeOnTrigger">
                                <option value="" ${!r.resetGaugeOnTrigger ? 'selected' : ''}>不清零</option>
                                <option value="gauge_a" ${r.resetGaugeOnTrigger === 'gauge_a' ? 'selected' : ''}>清零 ${escapeHtml(gAName)}</option>
                                <option value="gauge_b" ${r.resetGaugeOnTrigger === 'gauge_b' ? 'selected' : ''}>清零 ${escapeHtml(gBName)}</option>
                            </select>
                        </label>
                    </div>

                    <div class="stcf-grid-3">
                        <label class="stcf-mini-field"><span>提示词注入位置</span>
                            <select class="text_pole" data-field="position">
                                <option value="in_chat" ${r.position === 'in_chat' ? 'selected' : ''}>聊天深度插入(推荐)</option>
                                <option value="in_prompt" ${r.position === 'in_prompt' ? 'selected' : ''}>主提示词内</option>
                                <option value="before_prompt" ${r.position === 'before_prompt' ? 'selected' : ''}>主提示词前</option>
                            </select>
                        </label>
                        <label class="stcf-mini-field"><span>插入深度(Depth)</span>
                            <input type="number" min="0" max="20" class="text_pole" data-field="depth" value="${r.depth}">
                        </label>
                        <label class="stcf-mini-field"><span>消息角色</span>
                            <select class="text_pole" data-field="role">
                                <option value="system" ${r.role === 'system' ? 'selected' : ''}>System</option>
                                <option value="user" ${r.role === 'user' ? 'selected' : ''}>User</option>
                                <option value="assistant" ${r.role === 'assistant' ? 'selected' : ''}>Assistant</option>
                            </select>
                        </label>
                    </div>

                    <div class="stcf-field-row">
                        <label>条件达成时自动注入的剧情引导提示词（留空则仅触发 Buff，不注入提示词）：</label>
                        <textarea class="text_pole stcf-prompt-textarea" rows="3" data-field="promptText" placeholder="写下你想引导 AI 描写的战斗结果或特殊剧情...">${escapeHtml(r.promptText)}</textarea>
                    </div>
                </div>
            `;
        }).join('');
    }

    bindSimpleListEvents(elRulesEditor, () => deps.getConfig().triggerRules, ['scope', 'conditionType']);

    /** 通用列表事件绑定助手（避免重复样板代码） */
    function bindSimpleListEvents(hostEl, getListFn, reRenderFields = []) {
        hostEl.addEventListener('input', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card || !e.target.dataset.field || e.target.type === 'checkbox') return;
            const item = getListFn()[Number(card.dataset.index)];
            if (!item) return;
            const field = e.target.dataset.field;
            item[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
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
            const delBtn = e.target.closest('[data-action="delete"]');
            if (!delBtn) return;
            const card = delBtn.closest('.stcf-item-card');
            getListFn().splice(Number(card.dataset.index), 1);
            commitChange(true);
        });
    }

    function renderAll() {
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
        elListenAi.checked = cfg.general.listenAiEvents !== false;
        elSyncParty.checked = cfg.general.syncPartyToAi !== false;
        elSyncBattle.checked = cfg.general.syncBattleToAi !== false;
        elSyncCatalog.checked = cfg.general.syncCatalogToAi !== false;
        elHudCollapsed.checked = cfg.general.hudStartCollapsed !== false;
        elAutoEndTurn.checked = cfg.general.autoEndPlayerTurn !== false;
        elOutputMode.value = cfg.general.outputMode || 'fill_input';
        elFillStrategy.value = cfg.general.inputFillStrategy || 'append';
        elLogHeader.value = cfg.general.logHeaderTemplate || '';
        elGaugeAName.value = cfg.gauges?.gauge_a?.name || '状态槽A';
        elGaugeAColor.value = cfg.gauges?.gauge_a?.color || '#e67e22';
        elGaugeATick.value = String(cfg.gauges?.gauge_a?.perTurnChange ?? 0);
        elGaugeAScope.value = cfg.gauges?.gauge_a?.perTurnScope || 'all';
        elGaugeBName.value = cfg.gauges?.gauge_b?.name || '状态槽B';
        elGaugeBColor.value = cfg.gauges?.gauge_b?.color || '#9b59b6';
        elGaugeBTick.value = String(cfg.gauges?.gauge_b?.perTurnChange ?? 0);
        elGaugeBScope.value = cfg.gauges?.gauge_b?.perTurnScope || 'all';

        renderUnitsList('ally', elAlliesEditor);
        renderUnitsList('enemy', elEnemiesEditor);
        renderSkillsList();
        renderEquipmentsList();
        renderItemsList();
        renderStatusesList();
        renderRulesList();
    }

    renderAll();

    return { renderAll };
}
