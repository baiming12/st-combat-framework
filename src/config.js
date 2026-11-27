/**
 * 配置管理模块 (src/config.js)
 * 职责：
 * 1. 从 default_config.json 读取初始配置（完全不依赖 Node.js 后端）
 * 2. 通过 SillyTavern 原生 extension_settings 持久化保存用户的零代码修改
 * 3. 按当前聊天记录隔离保存战斗进度（chatMetadata），切换对话不串数据
 * 4. 提供一键导出 JSON、导入 JSON、恢复默认配置功能，并做数据兜底校验
 */

export const EXTENSION_KEY = 'st_combat_framework';
export const MAX_UNITS_PER_SIDE = 4; // 最多支持 4v4

/** 缓存读取到的默认配置 */
let cachedDefaultConfig = null;

/**
 * 获取 SillyTavern / TauriTavern 全局上下文
 * @returns {object}
 */
export function getSTContext() {
    if (typeof window !== 'undefined' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        return window.SillyTavern.getContext();
    }
    return {};
}

/**
 * 深拷贝普通 JSON 对象
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * 将数值安全限制在 [min, max] 范围内
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
}

/**
 * 加载默认配置文件 default_config.json
 * 使用 import.meta.url 自动定位相对路径，兼容任意安装目录与 TauriTavern
 * @returns {Promise<object>}
 */
export async function loadDefaultConfig() {
    if (cachedDefaultConfig) {
        return deepClone(cachedDefaultConfig);
    }
    const url = new URL('../default_config.json', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`无法加载默认配置文件 (${response.status}): ${url.href}`);
    }
    cachedDefaultConfig = await response.json();
    return deepClone(cachedDefaultConfig);
}

/**
 * 对单个角色配置进行字段兜底与规范化，防止手工改 JSON 时缺字段导致报错
 * @param {object} rawUnit
 * @param {'ally'|'enemy'} side
 * @param {number} index
 * @returns {object}
 */
function normalizeUnitTemplate(rawUnit, side, index) {
    const prefix = side === 'ally' ? 'ally' : 'enemy';
    const defaultId = `${prefix}_0${index + 1}`;
    const maxHp = Math.max(1, Math.round(Number(rawUnit?.maxHp ?? 100) || 100));
    const maxMp = Math.max(0, Math.round(Number(rawUnit?.maxMp ?? 50) || 0));
    return {
        id: String(rawUnit?.id || defaultId).trim() || defaultId,
        enabled: rawUnit?.enabled !== false,
        name: String(rawUnit?.name ?? defaultId).trim() || defaultId,
        maxHp,
        maxMp,
        atk: Math.max(0, Number(rawUnit?.atk ?? 15) || 0),
        def: Math.max(0, Number(rawUnit?.def ?? 5) || 0),
        initialGaugeA: clamp(rawUnit?.initialGaugeA ?? 0, 0, 100),
        initialGaugeB: clamp(rawUnit?.initialGaugeB ?? 0, 0, 100),
        skillIds: Array.isArray(rawUnit?.skillIds) ? rawUnit.skillIds.map(String) : [],
    };
}

/**
 * 对完整配置进行结构合并与安全兜底
 * @param {object} rawConfig
 * @param {object} defaults
 * @returns {object}
 */
export function normalizeConfig(rawConfig, defaults) {
    const base = deepClone(defaults);
    const src = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

    // 1. 全局设置合并
    const general = {
        ...base.general,
        ...(src.general && typeof src.general === 'object' ? src.general : {}),
    };
    // 严格确保输出模式不会自动发送，仅允许 fill_input / clipboard / manual
    if (!['fill_input', 'clipboard', 'manual'].includes(general.outputMode)) {
        general.outputMode = 'fill_input';
    }
    if (!['append', 'replace'].includes(general.inputFillStrategy)) {
        general.inputFillStrategy = 'append';
    }
    general.enabled = general.enabled !== false;
    general.autoEndPlayerTurn = general.autoEndPlayerTurn !== false;
    general.hudStartCollapsed = general.hudStartCollapsed !== false;

    // 2. 特殊计量条定义（固定 2 个：gauge_a、gauge_b，范围 0-100）
    const gauges = {
        gauge_a: {
            ...base.gauges.gauge_a,
            ...(src.gauges?.gauge_a || {}),
            min: 0,
            max: 100,
        },
        gauge_b: {
            ...base.gauges.gauge_b,
            ...(src.gauges?.gauge_b || {}),
            min: 0,
            max: 100,
        },
    };

    // 3. 状态（Buff/Debuff）列表
    const rawStatuses = Array.isArray(src.statuses) ? src.statuses : base.statuses;
    const statuses = rawStatuses.map((st, idx) => ({
        id: String(st?.id || `status_${idx + 1}`).trim() || `status_${idx + 1}`,
        name: String(st?.name ?? `status_${idx + 1}`).trim() || `status_${idx + 1}`,
        icon: String(st?.icon || '✨'),
        description: String(st?.description || ''),
        effectType: ['dot_hot', 'skip_turn', 'stat_mod'].includes(st?.effectType) ? st.effectType : 'dot_hot',
        targetStat: ['hp', 'mp', 'gauge_a', 'gauge_b'].includes(st?.targetStat) ? st.targetStat : 'hp',
        value: Number.isFinite(Number(st?.value)) ? Number(st.value) : 0,
        atkMultiplier: Number.isFinite(Number(st?.atkMultiplier)) ? Number(st.atkMultiplier) : 1,
        defMultiplier: Number.isFinite(Number(st?.defMultiplier)) ? Number(st.defMultiplier) : 1,
        duration: Math.max(1, Math.round(Number(st?.duration ?? 1) || 1)),
    }));

    // 4. 技能列表
    const rawSkills = Array.isArray(src.skills) ? src.skills : base.skills;
    const skills = rawSkills.map((sk, idx) => ({
        id: String(sk?.id || `skill_${idx + 1}`).trim() || `skill_${idx + 1}`,
        name: String(sk?.name ?? `skill_${idx + 1}`).trim() || `skill_${idx + 1}`,
        description: String(sk?.description || ''),
        mpCost: Math.max(0, Math.round(Number(sk?.mpCost ?? 0) || 0)),
        targetType: ['single_enemy', 'all_enemies', 'self', 'single_ally', 'all_allies'].includes(sk?.targetType)
            ? sk.targetType
            : 'single_enemy',
        effectType: ['damage', 'heal', 'mp_restore', 'utility'].includes(sk?.effectType)
            ? sk.effectType
            : 'damage',
        formula: String(sk?.formula ?? '10'),
        selfGaugeAChange: Number.isFinite(Number(sk?.selfGaugeAChange)) ? Number(sk.selfGaugeAChange) : 0,
        selfGaugeBChange: Number.isFinite(Number(sk?.selfGaugeBChange)) ? Number(sk.selfGaugeBChange) : 0,
        targetGaugeAChange: Number.isFinite(Number(sk?.targetGaugeAChange)) ? Number(sk.targetGaugeAChange) : 0,
        targetGaugeBChange: Number.isFinite(Number(sk?.targetGaugeBChange)) ? Number(sk.targetGaugeBChange) : 0,
        applyStatusId: String(sk?.applyStatusId || ''),
        applyStatusChance: clamp(sk?.applyStatusChance ?? 100, 0, 100),
        applyStatusTarget: sk?.applyStatusTarget === 'self' ? 'self' : 'target',
    }));

    // 5. 我方与敌方单位（每方最多 4 人，支持 1v1 ~ 4v4）
    const rawAllies = Array.isArray(src.allies) && src.allies.length > 0 ? src.allies : base.allies;
    const rawEnemies = Array.isArray(src.enemies) && src.enemies.length > 0 ? src.enemies : base.enemies;
    const allies = rawAllies.slice(0, MAX_UNITS_PER_SIDE).map((u, idx) => normalizeUnitTemplate(u, 'ally', idx));
    const enemies = rawEnemies.slice(0, MAX_UNITS_PER_SIDE).map((u, idx) => normalizeUnitTemplate(u, 'enemy', idx));

    // 6. 阈值触发与 Prompt 注入规则
    const rawRules = Array.isArray(src.triggerRules) ? src.triggerRules : base.triggerRules;
    const triggerRules = rawRules.map((r, idx) => ({
        id: String(r?.id || `rule_${idx + 1}`).trim() || `rule_${idx + 1}`,
        name: String(r?.name ?? `rule_${idx + 1}`).trim() || `rule_${idx + 1}`,
        enabled: r?.enabled !== false,
        scope: ['any_ally', 'all_allies', 'any_enemy', 'all_enemies', 'specific_unit'].includes(r?.scope)
            ? r.scope
            : 'any_ally',
        unitId: String(r?.unitId || ''),
        conditionType: ['hp', 'hp_percent', 'mp', 'gauge_a', 'gauge_b', 'has_status'].includes(r?.conditionType)
            ? r.conditionType
            : 'hp',
        operator: ['<=', '<', '>=', '>', '=='].includes(r?.operator) ? r.operator : '<=',
        threshold: Number.isFinite(Number(r?.threshold)) ? Number(r.threshold) : 0,
        statusId: String(r?.statusId || ''),
        position: ['in_chat', 'in_prompt', 'before_prompt'].includes(r?.position) ? r.position : 'in_chat',
        depth: Math.max(0, Math.round(Number(r?.depth ?? 1) || 0)),
        role: ['system', 'user', 'assistant'].includes(r?.role) ? r.role : 'system',
        promptText: String(r?.promptText || ''),
    }));

    return {
        schemaVersion: base.schemaVersion || 1,
        general,
        gauges,
        statuses,
        skills,
        allies,
        enemies,
        triggerRules,
    };
}

/**
 * 读取当前持久化配置（优先从 SillyTavern extension_settings 读取）
 * @returns {Promise<object>}
 */
export async function loadConfig() {
    const defaults = await loadDefaultConfig();
    const ctx = getSTContext();

    if (ctx.extensionSettings) {
        const stored = ctx.extensionSettings[EXTENSION_KEY]?.config;
        const normalized = normalizeConfig(stored, defaults);
        if (!ctx.extensionSettings[EXTENSION_KEY]) {
            ctx.extensionSettings[EXTENSION_KEY] = {};
        }
        ctx.extensionSettings[EXTENSION_KEY].config = normalized;
        return normalized;
    }

    // 兜底：当在独立页面调试时使用 localStorage
    try {
        const raw = localStorage.getItem(`${EXTENSION_KEY}_config`);
        return normalizeConfig(raw ? JSON.parse(raw) : null, defaults);
    } catch {
        return defaults;
    }
}

/**
 * 持久化保存配置到 SillyTavern extension_settings
 * @param {object} config
 */
export function saveConfig(config) {
    const ctx = getSTContext();
    if (ctx.extensionSettings) {
        if (!ctx.extensionSettings[EXTENSION_KEY]) {
            ctx.extensionSettings[EXTENSION_KEY] = {};
        }
        ctx.extensionSettings[EXTENSION_KEY].config = config;
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    } else {
        try {
            localStorage.setItem(`${EXTENSION_KEY}_config`, JSON.stringify(config));
        } catch (err) {
            console.warn('[CombatFramework] localStorage 保存配置失败:', err);
        }
    }
}

/**
 * 恢复出厂默认配置
 * @returns {Promise<object>}
 */
export async function resetConfigToDefaults() {
    const defaults = await loadDefaultConfig();
    saveConfig(defaults);
    return defaults;
}

/**
 * 将当前配置导出为 JSON 文件下载（纯前端 Blob 下载，无需后端）
 * @param {object} config
 */
export function exportConfigAsJson(config) {
    const jsonText = JSON.stringify(config, null, 4);
    const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `st-combat-config-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 从用户上传的 JSON 文本解析、校验并保存配置
 * @param {string} jsonText
 * @returns {Promise<object>}
 */
export async function importConfigFromJsonText(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(`JSON 格式有误，请检查括号或逗号是否成对：${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON 根节点必须是对象格式（以 { 开头）');
    }
    const defaults = await loadDefaultConfig();
    const normalized = normalizeConfig(parsed, defaults);
    saveConfig(normalized);
    return normalized;
}

/**
 * 获取当前聊天/角色卡的唯一隔离键，确保切换角色卡或切换对话时战斗状态严格隔离
 * @param {object} ctx
 * @returns {string}
 */
function getCurrentChatScopeKey(ctx) {
    if (ctx.chatId) return `chat:${ctx.chatId}`;
    if (ctx.groupId) return `group:${ctx.groupId}`;
    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        return `char:${ctx.characterId}`;
    }
    return '';
}

/**
 * 读取当前聊天对应的战斗进度（不同角色卡/不同聊天窗口严格隔离）
 * @returns {object|null}
 */
export function loadBattleState() {
    const ctx = getSTContext();
    const scopeKey = getCurrentChatScopeKey(ctx);

    // 优先读取当前聊天专属的 chatMetadata
    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
        const metaEntry = ctx.chatMetadata[EXTENSION_KEY];
        if (metaEntry && Object.prototype.hasOwnProperty.call(metaEntry, 'battleState')) {
            return metaEntry.battleState ? deepClone(metaEntry.battleState) : null;
        }
    }

    // 按 scopeKey 隔离的兜底存储（绝不跨角色卡/跨聊天串数据）
    if (scopeKey && ctx.extensionSettings?.[EXTENSION_KEY]?.battleStatesByChat) {
        const scoped = ctx.extensionSettings[EXTENSION_KEY].battleStatesByChat[scopeKey];
        return scoped ? deepClone(scoped) : null;
    }

    return null;
}

/**
 * 保存当前聊天的战斗进度（严格按当前聊天/角色卡隔离）
 * @param {object|null} battleState
 */
export function saveBattleState(battleState) {
    const ctx = getSTContext();
    const snapshot = battleState ? deepClone(battleState) : null;
    const scopeKey = getCurrentChatScopeKey(ctx);

    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
        if (!ctx.chatMetadata[EXTENSION_KEY]) {
            ctx.chatMetadata[EXTENSION_KEY] = {};
        }
        ctx.chatMetadata[EXTENSION_KEY].battleState = snapshot;
        if (typeof ctx.saveMetadata === 'function') {
            try {
                ctx.saveMetadata();
            } catch (err) {
                console.warn('[CombatFramework] chatMetadata 保存失败:', err);
            }
        }
    }

    // 同步按 scopeKey 写入隔离映射，兼容部分前端壳不持久化 chatMetadata 的情况
    if (scopeKey && ctx.extensionSettings) {
        if (!ctx.extensionSettings[EXTENSION_KEY]) {
            ctx.extensionSettings[EXTENSION_KEY] = {};
        }
        if (!ctx.extensionSettings[EXTENSION_KEY].battleStatesByChat) {
            ctx.extensionSettings[EXTENSION_KEY].battleStatesByChat = {};
        }
        if (snapshot) {
            ctx.extensionSettings[EXTENSION_KEY].battleStatesByChat[scopeKey] = snapshot;
        } else {
            delete ctx.extensionSettings[EXTENSION_KEY].battleStatesByChat[scopeKey];
        }
        // 清理旧版本的全局兜底字段，彻底杜绝串卡
        delete ctx.extensionSettings[EXTENSION_KEY].fallbackBattleState;
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }
}
