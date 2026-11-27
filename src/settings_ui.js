/**
 * 扩展侧边栏可视化配置面板模块 (src/settings_ui.js)
 * 职责：
 * 1. 加载 settings.html 挂载到 SillyTavern Extensions 侧边栏
 * 2. 将所有技能、Buff/Debuff、参战角色（最多 4v4）、特殊计量条、阈值触发提示词渲染为可实时增删改的表单
 * 3. 所有修改即时保存到 extension_settings，并同步刷新战斗 HUD 与提示词注入状态
 * 4. 绑定一键导出 JSON、导入 JSON、恢复默认配置
 */

import {
    MAX_UNITS_PER_SIDE,
    exportConfigAsJson,
    importConfigFromJsonText,
    resetConfigToDefaults,
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

/**
 * 初始化 Extensions 侧边栏设置面板
 * @param {{
 *   getConfig: () => object,
 *   setConfig: (nextConfig: object) => void,
 *   onConfigChanged: () => void,
 * }} deps
 */
export async function initSettingsUI(deps) {
    const targetHost = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.body;

    const oldContainer = document.getElementById('stcf-settings-container');
    if (oldContainer) oldContainer.remove();

    const htmlUrl = new URL('../settings.html', import.meta.url);
    const resp = await fetch(htmlUrl);
    if (!resp.ok) {
        throw new Error(`无法加载 settings.html (${resp.status})`);
    }
    const html = await resp.text();
    const temp = document.createElement('div');
    temp.innerHTML = html.trim();
    const container = temp.firstElementChild;
    targetHost.appendChild(container);

    // 折叠抽屉兼容（若酒馆未自动绑定新插入的 inline-drawer）
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

    const elIoStatus = container.querySelector('#stcf-io-status');
    function setIoStatus(msg, isError = false) {
        if (!elIoStatus) return;
        elIoStatus.textContent = msg;
        elIoStatus.classList.toggle('stcf-text-error', isError);
    }

    /** 保存配置并通知外部刷新 HUD 和 Prompt 注入 */
    function commitChange(reRenderLists = false) {
        const cfg = deps.getConfig();
        saveConfig(cfg);
        deps.onConfigChanged();
        if (reRenderLists) {
            renderAll();
        }
    }

    // =========================================================================
    // 一、基础设置绑定
    // =========================================================================
    const elEnabled = container.querySelector('#stcf-set-enabled');
    const elHudCollapsed = container.querySelector('#stcf-set-hud-collapsed');
    const elAutoEndTurn = container.querySelector('#stcf-set-auto-end-turn');
    const elOutputMode = container.querySelector('#stcf-set-output-mode');
    const elFillStrategy = container.querySelector('#stcf-set-fill-strategy');
    const elLogHeader = container.querySelector('#stcf-set-log-header');
    const elGaugeAName = container.querySelector('#stcf-set-gauge-a-name');
    const elGaugeAColor = container.querySelector('#stcf-set-gauge-a-color');
    const elGaugeBName = container.querySelector('#stcf-set-gauge-b-name');
    const elGaugeBColor = container.querySelector('#stcf-set-gauge-b-color');

    elEnabled.addEventListener('change', () => {
        deps.getConfig().general.enabled = elEnabled.checked;
        commitChange();
    });
    elHudCollapsed.addEventListener('change', () => {
        deps.getConfig().general.hudStartCollapsed = elHudCollapsed.checked;
        commitChange();
    });
    elAutoEndTurn.addEventListener('change', () => {
        deps.getConfig().general.autoEndPlayerTurn = elAutoEndTurn.checked;
        commitChange();
    });
    elOutputMode.addEventListener('change', () => {
        deps.getConfig().general.outputMode = elOutputMode.value;
        commitChange();
    });
    elFillStrategy.addEventListener('change', () => {
        deps.getConfig().general.inputFillStrategy = elFillStrategy.value;
        commitChange();
    });
    elLogHeader.addEventListener('input', () => {
        deps.getConfig().general.logHeaderTemplate = elLogHeader.value;
        commitChange();
    });
    elGaugeAName.addEventListener('input', () => {
        deps.getConfig().gauges.gauge_a.name = elGaugeAName.value || '状态槽A';
        commitChange();
    });
    elGaugeAColor.addEventListener('input', () => {
        deps.getConfig().gauges.gauge_a.color = elGaugeAColor.value;
        commitChange();
    });
    elGaugeBName.addEventListener('input', () => {
        deps.getConfig().gauges.gauge_b.name = elGaugeBName.value || '状态槽B';
        commitChange();
    });
    elGaugeBColor.addEventListener('input', () => {
        deps.getConfig().gauges.gauge_b.color = elGaugeBColor.value;
        commitChange();
    });

    // 导出 JSON
    container.querySelector('#stcf-btn-export-json').addEventListener('click', () => {
        exportConfigAsJson(deps.getConfig());
        setIoStatus('✅ 已触发 JSON 文件下载，可用记事本打开批量编辑。');
    });

    // 导入 JSON
    const elFileInput = container.querySelector('#stcf-file-import-json');
    container.querySelector('#stcf-btn-import-json').addEventListener('click', () => {
        elFileInput.value = '';
        elFileInput.click();
    });
    elFileInput.addEventListener('change', async () => {
        const file = elFileInput.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const imported = await importConfigFromJsonText(text);
            deps.setConfig(imported);
            renderAll();
            deps.onConfigChanged();
            setIoStatus(`✅ 成功导入配置文件：${file.name}`);
        } catch (err) {
            setIoStatus(`❌ 导入失败：${err.message}`, true);
        }
    });

    // 恢复默认
    container.querySelector('#stcf-btn-reset-default').addEventListener('click', async () => {
        if (!window.confirm('确定要恢复出厂默认配置吗？你当前未导出的自定义内容会被覆盖。')) return;
        const fresh = await resetConfigToDefaults();
        deps.setConfig(fresh);
        renderAll();
        deps.onConfigChanged();
        setIoStatus('✅ 已恢复为 default_config.json 默认配置。');
    });

    // =========================================================================
    // 二、参战角色（我方 1~4 / 敌方 1~4）可视化编辑器
    // =========================================================================
    const elAlliesEditor = container.querySelector('#stcf-allies-editor');
    const elEnemiesEditor = container.querySelector('#stcf-enemies-editor');
    const btnAddAlly = container.querySelector('#stcf-btn-add-ally');
    const btnAddEnemy = container.querySelector('#stcf-btn-add-enemy');

    function addUnit(side) {
        const cfg = deps.getConfig();
        const list = side === 'ally' ? cfg.allies : cfg.enemies;
        if (list.length >= MAX_UNITS_PER_SIDE) {
            window.alert(`每方最多支持 ${MAX_UNITS_PER_SIDE} 名参战角色（最多 4v4）。`);
            return;
        }
        const id = makeUniqueId(side, list);
        list.push({
            id,
            enabled: true,
            name: side === 'ally' ? `我方角色${list.length + 1}` : `敌方目标${list.length + 1}`,
            maxHp: 100,
            maxMp: 50,
            atk: 20,
            def: 8,
            initialGaugeA: 0,
            initialGaugeB: 0,
            skillIds: cfg.skills[0] ? [cfg.skills[0].id] : [],
        });
        commitChange(true);
    }

    btnAddAlly.addEventListener('click', () => addUnit('ally'));
    btnAddEnemy.addEventListener('click', () => addUnit('enemy'));

    function renderUnitsList(side, hostEl) {
        const cfg = deps.getConfig();
        const list = side === 'ally' ? cfg.allies : cfg.enemies;
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';

        hostEl.innerHTML = list.map((u, idx) => {
            const skillChecks = (cfg.skills || []).map(sk => {
                const checked = (u.skillIds || []).includes(sk.id) ? 'checked' : '';
                return `
                    <label class="stcf-chip-check">
                        <input type="checkbox" data-unit-skill="${escapeHtml(sk.id)}" ${checked}>
                        <span>${escapeHtml(sk.name)}</span>
                    </label>
                `;
            }).join('');

            return `
                <div class="stcf-item-card" data-side="${side}" data-index="${idx}">
                    <div class="stcf-item-head">
                        <label class="stcf-inline-check">
                            <input type="checkbox" data-field="enabled" ${u.enabled ? 'checked' : ''}>
                            <strong>出战</strong>
                        </label>
                        <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(u.name)}" placeholder="角色名称">
                        <span class="stcf-id-tag" title="内部标识 ID">${escapeHtml(u.id)}</span>
                        ${list.length > 1 ? '<button type="button" class="stcf-del-btn" data-action="delete" title="删除角色">🗑️</button>' : ''}
                    </div>
                    <div class="stcf-grid-4">
                        <label class="stcf-mini-field"><span>最大 HP</span><input type="number" min="1" class="text_pole" data-field="maxHp" value="${u.maxHp}"></label>
                        <label class="stcf-mini-field"><span>最大 MP</span><input type="number" min="0" class="text_pole" data-field="maxMp" value="${u.maxMp}"></label>
                        <label class="stcf-mini-field"><span>攻击 ATK</span><input type="number" min="0" class="text_pole" data-field="atk" value="${u.atk}"></label>
                        <label class="stcf-mini-field"><span>防御 DEF</span><input type="number" min="0" class="text_pole" data-field="def" value="${u.def}"></label>
                        <label class="stcf-mini-field"><span>初始${escapeHtml(gAName)}</span><input type="number" min="0" max="100" class="text_pole" data-field="initialGaugeA" value="${u.initialGaugeA}"></label>
                        <label class="stcf-mini-field"><span>初始${escapeHtml(gBName)}</span><input type="number" min="0" max="100" class="text_pole" data-field="initialGaugeB" value="${u.initialGaugeB}"></label>
                    </div>
                    <div class="stcf-skill-assign">
                        <div class="stcf-sub-label">可用技能：</div>
                        <div class="stcf-chips-wrap">${skillChecks || '<span class="stcf-muted">请先在技能库中添加技能</span>'}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function bindUnitsEvents(hostEl) {
        hostEl.addEventListener('input', (e) => {
            const card = e.target.closest('.stcf-item-card');
            if (!card) return;
            const field = e.target.dataset.field;
            if (!field) return;
            const cfg = deps.getConfig();
            const list = card.dataset.side === 'ally' ? cfg.allies : cfg.enemies;
            const unit = list[Number(card.dataset.index)];
            if (!unit) return;

            if (e.target.type === 'number') {
                unit[field] = Number(e.target.value) || 0;
            } else if (e.target.type !== 'checkbox') {
                unit[field] = e.target.value;
            }
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
            } else if (e.target.dataset.unitSkill) {
                const sid = e.target.dataset.unitSkill;
                const set = new Set(unit.skillIds || []);
                if (e.target.checked) set.add(sid);
                else set.delete(sid);
                unit.skillIds = [...set];
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
    // 三、技能库可视化编辑器
    // =========================================================================
    const elSkillsEditor = container.querySelector('#stcf-skills-editor');
    container.querySelector('#stcf-btn-add-skill').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('skill', cfg.skills);
        cfg.skills.push({
            id,
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
        });
        commitChange(true);
    });

    function renderSkillsList() {
        const cfg = deps.getConfig();
        const gAName = cfg.gauges?.gauge_a?.name || '状态槽A';
        const gBName = cfg.gauges?.gauge_b?.name || '状态槽B';

        elSkillsEditor.innerHTML = (cfg.skills || []).map((sk, idx) => {
            const statusOptions = [
                `<option value="">无附加状态</option>`,
                ...(cfg.statuses || []).map(st =>
                    `<option value="${escapeHtml(st.id)}" ${sk.applyStatusId === st.id ? 'selected' : ''}>${escapeHtml(st.icon)} ${escapeHtml(st.name)} (${escapeHtml(st.id)})</option>`
                ),
            ].join('');

            return `
                <div class="stcf-item-card" data-index="${idx}">
                    <div class="stcf-item-head">
                        <input type="text" class="text_pole stcf-grow" data-field="name" value="${escapeHtml(sk.name)}" placeholder="技能名称">
                        <span class="stcf-id-tag">${escapeHtml(sk.id)}</span>
                        <button type="button" class="stcf-del-btn" data-action="delete" title="删除技能">🗑️</button>
                    </div>
                    <div class="stcf-field-row">
                        <input type="text" class="text_pole" data-field="description" value="${escapeHtml(sk.description)}" placeholder="技能描述（鼠标悬停在技能按钮时显示）">
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
                        <input type="text" class="text_pole" data-field="formula" value="${escapeHtml(sk.formula)}" placeholder="例如：max(1, atk * 1.2 - target_def * 0.4)">
                    </div>
                    <div class="stcf-grid-4">
                        <label class="stcf-mini-field"><span>自身${escapeHtml(gAName)}</span><input type="number" class="text_pole" data-field="selfGaugeAChange" value="${sk.selfGaugeAChange}"></label>
                        <label class="stcf-mini-field"><span>自身${escapeHtml(gBName)}</span><input type="number" class="text_pole" data-field="selfGaugeBChange" value="${sk.selfGaugeBChange}"></label>
                        <label class="stcf-mini-field"><span>目标${escapeHtml(gAName)}</span><input type="number" class="text_pole" data-field="targetGaugeAChange" value="${sk.targetGaugeAChange}"></label>
                        <label class="stcf-mini-field"><span>目标${escapeHtml(gBName)}</span><input type="number" class="text_pole" data-field="targetGaugeBChange" value="${sk.targetGaugeBChange}"></label>
                    </div>
                    <div class="stcf-grid-3">
                        <label class="stcf-mini-field"><span>附加状态</span>
                            <select class="text_pole" data-field="applyStatusId">${statusOptions}</select>
                        </label>
                        <label class="stcf-mini-field"><span>附加概率(%)</span><input type="number" min="0" max="100" class="text_pole" data-field="applyStatusChance" value="${sk.applyStatusChance}"></label>
                        <label class="stcf-mini-field"><span>状态施加给</span>
                            <select class="text_pole" data-field="applyStatusTarget">
                                <option value="target" ${sk.applyStatusTarget !== 'self' ? 'selected' : ''}>技能目标</option>
                                <option value="self" ${sk.applyStatusTarget === 'self' ? 'selected' : ''}>释放者自己</option>
                            </select>
                        </label>
                    </div>
                </div>
            `;
        }).join('');
    }

    elSkillsEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card || !e.target.dataset.field) return;
        const skill = deps.getConfig().skills[Number(card.dataset.index)];
        if (!skill) return;
        const field = e.target.dataset.field;
        skill[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange();
    });
    elSkillsEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card || !e.target.dataset.field) return;
        const skill = deps.getConfig().skills[Number(card.dataset.index)];
        if (!skill) return;
        const field = e.target.dataset.field;
        skill[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        // 若改了技能名，同步刷新角色页的技能勾选项
        commitChange(field === 'name');
    });
    elSkillsEditor.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-action="delete"]');
        if (!delBtn) return;
        const card = delBtn.closest('.stcf-item-card');
        deps.getConfig().skills.splice(Number(card.dataset.index), 1);
        commitChange(true);
    });

    // =========================================================================
    // 四、状态 / Buff 编辑器
    // =========================================================================
    const elStatusesEditor = container.querySelector('#stcf-statuses-editor');
    container.querySelector('#stcf-btn-add-status').addEventListener('click', () => {
        const cfg = deps.getConfig();
        const id = makeUniqueId('status', cfg.statuses);
        cfg.statuses.push({
            id,
            name: `新状态_${cfg.statuses.length + 1}`,
            icon: '✨',
            description: '自定义状态说明',
            effectType: 'dot_hot',
            targetStat: 'hp',
            value: -10,
            atkMultiplier: 1,
            defMultiplier: 1,
            duration: 2,
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
                <div class="stcf-grid-3">
                    <label class="stcf-mini-field"><span>效果模板</span>
                        <select class="text_pole" data-field="effectType">
                            <option value="dot_hot" ${st.effectType === 'dot_hot' ? 'selected' : ''}>每回合持续增减属性</option>
                            <option value="skip_turn" ${st.effectType === 'skip_turn' ? 'selected' : ''}>跳过行动回合(控制)</option>
                            <option value="stat_mod" ${st.effectType === 'stat_mod' ? 'selected' : ''}>增减攻击/防御倍率</option>
                        </select>
                    </label>
                    <label class="stcf-mini-field"><span>每回合影响属性</span>
                        <select class="text_pole" data-field="targetStat">
                            <option value="hp" ${st.targetStat === 'hp' ? 'selected' : ''}>生命值 HP</option>
                            <option value="mp" ${st.targetStat === 'mp' ? 'selected' : ''}>体力/MP</option>
                            <option value="gauge_a" ${st.targetStat === 'gauge_a' ? 'selected' : ''}>${escapeHtml(gAName)}</option>
                            <option value="gauge_b" ${st.targetStat === 'gauge_b' ? 'selected' : ''}>${escapeHtml(gBName)}</option>
                        </select>
                    </label>
                    <label class="stcf-mini-field"><span>每回合增减值</span><input type="number" class="text_pole" data-field="value" value="${st.value}" title="负数扣血/降槽，正数回血/加槽"></label>
                </div>
                <div class="stcf-grid-3">
                    <label class="stcf-mini-field"><span>攻击倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="atkMultiplier" value="${st.atkMultiplier}" title="1 为不变，1.3 为 +30%，0.7 为 -30%"></label>
                    <label class="stcf-mini-field"><span>防御倍率</span><input type="number" step="0.1" min="0.1" class="text_pole" data-field="defMultiplier" value="${st.defMultiplier}"></label>
                    <label class="stcf-mini-field"><span>持续回合数</span><input type="number" min="1" class="text_pole" data-field="duration" value="${st.duration}"></label>
                </div>
            </div>
        `).join('');
    }

    elStatusesEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card || !e.target.dataset.field) return;
        const st = deps.getConfig().statuses[Number(card.dataset.index)];
        if (!st) return;
        const field = e.target.dataset.field;
        st[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange();
    });
    elStatusesEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card || !e.target.dataset.field) return;
        const st = deps.getConfig().statuses[Number(card.dataset.index)];
        if (!st) return;
        const field = e.target.dataset.field;
        st[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
        commitChange(field === 'name' || field === 'icon');
    });
    elStatusesEditor.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-action="delete"]');
        if (!delBtn) return;
        const card = delBtn.closest('.stcf-item-card');
        deps.getConfig().statuses.splice(Number(card.dataset.index), 1);
        commitChange(true);
    });

    // =========================================================================
    // 五、阈值触发与 Prompt 注入规则编辑器
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
            const statusOptions = [
                `<option value="">请选择状态...</option>`,
                ...(cfg.statuses || []).map(st =>
                    `<option value="${escapeHtml(st.id)}" ${r.statusId === st.id ? 'selected' : ''}>${escapeHtml(st.icon)} ${escapeHtml(st.name)}</option>`
                ),
            ].join('');

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
                            <label class="stcf-mini-field stcf-span-2"><span>目标状态</span>
                                <select class="text_pole" data-field="statusId">${statusOptions}</select>
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

                    <div class="stcf-grid-3">
                        <label class="stcf-mini-field"><span>注入位置</span>
                            <select class="text_pole" data-field="position">
                                <option value="in_chat" ${r.position === 'in_chat' ? 'selected' : ''}>聊天记录深度插入(推荐)</option>
                                <option value="in_prompt" ${r.position === 'in_prompt' ? 'selected' : ''}>主提示词内</option>
                                <option value="before_prompt" ${r.position === 'before_prompt' ? 'selected' : ''}>主提示词前</option>
                            </select>
                        </label>
                        <label class="stcf-mini-field"><span>插入深度(Depth)</span>
                            <input type="number" min="0" max="20" class="text_pole" data-field="depth" value="${r.depth}">
                        </label>
                        <label class="stcf-mini-field"><span>消息角色</span>
                            <select class="text_pole" data-field="role">
                                <option value="system" ${r.role === 'system' ? 'selected' : ''}>System (系统)</option>
                                <option value="user" ${r.role === 'user' ? 'selected' : ''}>User (用户)</option>
                                <option value="assistant" ${r.role === 'assistant' ? 'selected' : ''}>Assistant (AI)</option>
                            </select>
                        </label>
                    </div>

                    <div class="stcf-field-row">
                        <label>条件达成时自动注入的剧情引导提示词：</label>
                        <textarea class="text_pole stcf-prompt-textarea" rows="3" data-field="promptText" placeholder="写下你想引导 AI 描写的战斗结果或特殊剧情...">${escapeHtml(r.promptText)}</textarea>
                    </div>
                </div>
            `;
        }).join('');
    }

    elRulesEditor.addEventListener('input', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card || !e.target.dataset.field) return;
        const rule = deps.getConfig().triggerRules[Number(card.dataset.index)];
        if (!rule) return;
        const field = e.target.dataset.field;
        if (e.target.type === 'number') rule[field] = Number(e.target.value) || 0;
        else if (e.target.type !== 'checkbox') rule[field] = e.target.value;
        commitChange();
    });
    elRulesEditor.addEventListener('change', (e) => {
        const card = e.target.closest('.stcf-item-card');
        if (!card || !e.target.dataset.field) return;
        const rule = deps.getConfig().triggerRules[Number(card.dataset.index)];
        if (!rule) return;
        const field = e.target.dataset.field;
        if (e.target.type === 'checkbox') {
            rule[field] = e.target.checked;
            commitChange();
        } else {
            rule[field] = e.target.type === 'number' ? (Number(e.target.value) || 0) : e.target.value;
            commitChange(field === 'scope' || field === 'conditionType');
        }
    });
    elRulesEditor.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-action="delete"]');
        if (!delBtn) return;
        const card = delBtn.closest('.stcf-item-card');
        deps.getConfig().triggerRules.splice(Number(card.dataset.index), 1);
        commitChange(true);
    });

    /** 刷新所有设置页控件与列表 */
    function renderAll() {
        const cfg = deps.getConfig();
        elEnabled.checked = cfg.general.enabled !== false;
        elHudCollapsed.checked = cfg.general.hudStartCollapsed !== false;
        elAutoEndTurn.checked = cfg.general.autoEndPlayerTurn !== false;
        elOutputMode.value = cfg.general.outputMode || 'fill_input';
        elFillStrategy.value = cfg.general.inputFillStrategy || 'append';
        elLogHeader.value = cfg.general.logHeaderTemplate || '';
        elGaugeAName.value = cfg.gauges?.gauge_a?.name || '状态槽A';
        elGaugeAColor.value = cfg.gauges?.gauge_a?.color || '#e67e22';
        elGaugeBName.value = cfg.gauges?.gauge_b?.name || '状态槽B';
        elGaugeBColor.value = cfg.gauges?.gauge_b?.color || '#9b59b6';

        renderUnitsList('ally', elAlliesEditor);
        renderUnitsList('enemy', elEnemiesEditor);
        renderSkillsList();
        renderStatusesList();
        renderRulesList();
    }

    renderAll();

    return {
        renderAll,
    };
}
