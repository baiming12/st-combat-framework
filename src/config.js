/**
 * 配置管理模块 (src/config.js) - v1.1
 * 职责：
 * 1. 从 default_config.json 读取初始配置（纯前端，零 Node.js 依赖）
 * 2. 支持「按角色卡独立保存配置方案（Profile）」与全局方案自由切换
 * 3. 严格按当前聊天/角色卡 ID 隔离战斗进度，切换角色卡绝不串台
 * 4. 支持一键导出 JSON、上传/粘贴 JSON 导入，并支持「完整替换」与「增量合并」（完美配合写卡助手！）
 */

export const EXTENSION_KEY = 'st_combat_framework';
export const MAX_UNITS_PER_SIDE = 6; // 最多支持 6v6

const RESERVED_GAUGE_IDS = new Set([
    'hp', 'max_hp', 'mp', 'max_mp', 'atk', 'spi', 'def', 'mdef', 'level', 'has_status', 'hp_percent',
]);

/** 清洗状态槽 ID（仅允许英文/数字/下划线且不与基础属性冲突） */
export function sanitizeGaugeId(rawId, fallbackId = 'gauge_custom') {
    let id = String(rawId || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!id || /^[0-9]/.test(id)) id = `g_${id || 'custom'}`;
    if (RESERVED_GAUGE_IDS.has(id)) id = `gauge_${id}`;
    return id || fallbackId;
}

/** 规范化单个状态槽定义（支持自定义 min/max、颜色与每回合自动增减） */
export function normalizeGaugeDef(id, rawG, fallback = {}) {
    const cleanId = sanitizeGaugeId(id, 'gauge_a');
    const minVal = Number.isFinite(Number(rawG?.min)) ? Math.round(Number(rawG.min)) : (Number.isFinite(Number(fallback.min)) ? Math.round(Number(fallback.min)) : 0);
    const rawMax = Number.isFinite(Number(rawG?.max)) ? Math.round(Number(rawG.max)) : (Number.isFinite(Number(fallback.max)) ? Math.round(Number(fallback.max)) : 100);
    const maxVal = Math.max(minVal + 1, rawMax);
    return {
        id: cleanId,
        name: String(rawG?.name ?? fallback.name ?? cleanId).trim() || cleanId,
        color: String(rawG?.color || fallback.color || '#3498db').trim() || '#3498db',
        min: minVal,
        max: maxVal,
        perTurnChange: Number.isFinite(Number(rawG?.perTurnChange)) ? Math.round(Number(rawG.perTurnChange)) : (fallback.perTurnChange || 0),
        perTurnScope: ['all', 'allies', 'enemies'].includes(rawG?.perTurnScope) ? rawG.perTurnScope : (fallback.perTurnScope || 'all'),
    };
}

/** 获取当前配置中全部自定义状态槽有序列表 */
export function getGaugeEntries(config) {
    const map = config?.gauges;
    if (!map || typeof map !== 'object') return [];
    const list = [];
    for (const [key, def] of Object.entries(map)) {
        if (!def || typeof def !== 'object') continue;
        list.push(normalizeGaugeDef(def.id || key, def));
    }
    return list;
}

/** 规范化状态槽数值映射（向下兼容旧版 gauge_a / gauge_b 独立字段；若显式传入了对象 rawMap 则以 rawMap 为准） */
function normalizeGaugeDeltaMap(rawMap, legacyA, legacyB) {
    const map = {};
    if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
        for (const [k, v] of Object.entries(rawMap)) {
            const num = Number(v);
            if (Number.isFinite(num) && num !== 0) {
                map[sanitizeGaugeId(k, k)] = num;
            }
        }
        return map;
    }
    const numA = Number(legacyA);
    if (Number.isFinite(numA) && numA !== 0) {
        map.gauge_a = numA;
    }
    const numB = Number(legacyB);
    if (Number.isFinite(numB) && numB !== 0) {
        map.gauge_b = numB;
    }
    return map;
}

/** 规范化状态的“状态槽增减倍率”列表（支持全部状态槽 _all 或指定槽位 ID，按 增/减/全部 生效） */
function normalizeGaugeMultipliers(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList
        .filter(x => x && typeof x === 'object')
        .map(x => {
            const rawId = String(x.gaugeId || '_all').trim().toLowerCase();
            const gaugeId = (!rawId || rawId === 'all' || rawId === '*' || rawId === '_all')
                ? '_all'
                : sanitizeGaugeId(rawId, '_all');
            const direction = ['gain', 'loss', 'both'].includes(x.direction) ? x.direction : 'both';
            const mult = Number(x.multiplier);
            return {
                gaugeId,
                direction,
                multiplier: Number.isFinite(mult) && mult >= 0 ? Number(mult.toFixed(2)) : 1,
            };
        });
}

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
 * 获取当前角色卡（或群聊）的方案隔离键，用于“按角色卡独立保存配置”
 * @param {object} ctx
 * @returns {{ key: string, label: string }}
 */
export function getCurrentProfileInfo(ctx = getSTContext()) {
    if (ctx.groupId) {
        return { key: `group:${ctx.groupId}`, label: `群聊专属 (${ctx.groupId})` };
    }
    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const charObj = Array.isArray(ctx.characters) ? ctx.characters[Number(ctx.characterId)] : null;
        const avatarKey = charObj?.avatar ? `char_avatar:${charObj.avatar}` : `char_id:${ctx.characterId}`;
        const charName = charObj?.name || ctx.name2 || `角色#${ctx.characterId}`;
        return { key: avatarKey, label: `角色卡「${charName}」专属方案` };
    }
    return { key: '', label: '全局默认方案' };
}

/**
 * 获取当前聊天/角色卡的战斗进度唯一隔离键
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
 * 加载默认配置文件 default_config.json
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
 * 规范化单个角色模板（v1.5 新增：精神 spi、法抗 mdef、等级 level、职业 classId、自由属性点与 5 项加点）
 */
function normalizeUnitTemplate(rawUnit, side, index) {
    const prefix = side === 'ally' ? 'ally' : 'enemy';
    const defaultId = `${prefix}_0${index + 1}`;
    const maxHp = Math.max(1, Math.round(Number(rawUnit?.maxHp ?? 100) || 100));
    const maxMp = Math.max(0, Math.round(Number(rawUnit?.maxMp ?? 50) || 0));
    const rawAlloc = rawUnit?.allocated && typeof rawUnit.allocated === 'object' ? rawUnit.allocated : {};
    return {
        id: String(rawUnit?.id || defaultId).trim() || defaultId,
        enabled: rawUnit?.enabled !== false,
        name: String(rawUnit?.name ?? defaultId).trim() || defaultId,
        description: String(rawUnit?.description || '').trim(),
        level: Math.max(1, Math.round(Number(rawUnit?.level ?? 1) || 1)),
        classId: String(rawUnit?.classId || '').trim(),
        freePoints: Math.max(0, Math.round(Number(rawUnit?.freePoints ?? 0) || 0)),
        allocated: {
            vit: Math.max(0, Math.round(Number(rawAlloc.vit ?? 0) || 0)),
            str: Math.max(0, Math.round(Number(rawAlloc.str ?? 0) || 0)),
            spi: Math.max(0, Math.round(Number(rawAlloc.spi ?? 0) || 0)),
            def: Math.max(0, Math.round(Number(rawAlloc.def ?? 0) || 0)),
            mdef: Math.max(0, Math.round(Number(rawAlloc.mdef ?? 0) || 0)),
        },
        maxHp,
        maxMp,
        atk: Math.max(0, Number(rawUnit?.atk ?? 15) || 0),
        spi: Math.max(0, Number(rawUnit?.spi ?? 15) || 0),
        def: Math.max(0, Number(rawUnit?.def ?? 5) || 0),
        mdef: Math.max(0, Number(rawUnit?.mdef ?? 5) || 0),
        initialGaugeA: Number.isFinite(Number(rawUnit?.initialGauges?.gauge_a ?? rawUnit?.initialGaugeA))
            ? Number(rawUnit?.initialGauges?.gauge_a ?? rawUnit?.initialGaugeA)
            : 0,
        initialGaugeB: Number.isFinite(Number(rawUnit?.initialGauges?.gauge_b ?? rawUnit?.initialGaugeB))
            ? Number(rawUnit?.initialGauges?.gauge_b ?? rawUnit?.initialGaugeB)
            : 0,
        initialGauges: normalizeGaugeDeltaMap(rawUnit?.initialGauges, rawUnit?.initialGaugeA, rawUnit?.initialGaugeB),
        skillIds: Array.isArray(rawUnit?.skillIds) ? rawUnit.skillIds.map(String) : [],
        equipmentIds: Array.isArray(rawUnit?.equipmentIds) ? rawUnit.equipmentIds.map(String) : [],
        aiStrategy: ['priority', 'weighted', 'random'].includes(rawUnit?.aiStrategy) ? rawUnit.aiStrategy : 'priority',
        autoControl: side === 'ally' ? Boolean(rawUnit?.autoControl) : false,
    };
}

/**
 * 规范化技能/道具的“多附加状态列表”（100% 向下兼容旧版单字段 applyStatusId；v1.9 支持 4 种施加对象）
 */
function normalizeApplyStatuses(rawList, legacyId, legacyChance = 100, legacyTarget = 'target') {
    const validTargets = ['target', 'self', 'all_allies', 'all_enemies'];
    const normTarget = (t) => (validTargets.includes(t) ? t : 'target');
    if (Array.isArray(rawList)) {
        return rawList
            .filter(x => x && (typeof x === 'string' || x.statusId))
            .map(x => {
                if (typeof x === 'string') {
                    return { statusId: x.trim(), chance: 100, target: 'target' };
                }
                return {
                    statusId: String(x.statusId || '').trim(),
                    chance: clamp(x.chance ?? 100, 0, 100),
                    target: normTarget(x.target),
                };
            })
            .filter(x => x.statusId);
    }
    const singleId = String(legacyId || '').trim();
    if (!singleId) return [];
    return [{
        statusId: singleId,
        chance: clamp(legacyChance ?? 100, 0, 100),
        target: normTarget(legacyTarget),
    }];
}

/**
 * 规范化技能的“附加复合效果列表”（v1.9 新增：同一技能可同时对敌人和自己/全队产生不同效果）
 */
function normalizeExtraEffects(rawList) {
    if (!Array.isArray(rawList)) return [];
    const validTargets = ['self', 'same', 'single_enemy', 'all_enemies', 'single_ally', 'all_allies'];
    const validEffects = ['damage', 'heal', 'mp_restore', 'cleanse', 'utility'];
    return rawList
        .filter(x => x && typeof x === 'object')
        .map(x => ({
            targetType: validTargets.includes(x.targetType) ? x.targetType : 'self',
            effectType: validEffects.includes(x.effectType) ? x.effectType : 'heal',
            formula: String(x.formula ?? '0'),
            gaugeChanges: normalizeGaugeDeltaMap(x.gaugeChanges, x.gaugeAChange, x.gaugeBChange),
        }));
}

/**
 * 规范化字符串 ID 列表（向下兼容旧版单字符串字段）
 */
function normalizeIdList(rawArr, legacySingle = '') {
    if (Array.isArray(rawArr)) {
        return [...new Set(rawArr.map(x => String(x || '').trim()).filter(Boolean))];
    }
    const single = String(legacySingle || '').trim();
    return single ? [single] : [];
}

/**
 * 规范化技能的“多组与/或前置条件”(v2.2 新增：支持组间 AND/OR、组内 AND/OR、必须有/不可有、按 Buff 添加来源筛选)
 */
function normalizePrereqGroups(rawGroups) {
    if (!Array.isArray(rawGroups)) return [];
    const validSubjects = ['target', 'self', 'any_ally', 'any_enemy'];
    const validTypes = ['has_status', 'not_has_status', 'gauge', 'hp_percent'];
    const validSources = ['any', 'self', 'other', 'ally', 'enemy'];
    const validOps = ['>=', '>', '<=', '<', '=='];
    return rawGroups
        .filter(g => g && typeof g === 'object')
        .map(g => ({
            logic: g.logic === 'or' ? 'or' : 'and',
            conditions: Array.isArray(g.conditions)
                ? g.conditions
                    .filter(c => c && typeof c === 'object')
                    .map(c => ({
                        subject: validSubjects.includes(c.subject) ? c.subject : 'target',
                        type: validTypes.includes(c.type) ? c.type : 'has_status',
                        statusId: String(c.statusId || '').trim(),
                        sourceFilter: validSources.includes(c.sourceFilter) ? c.sourceFilter : 'any',
                        gaugeId: String(c.gaugeId || '').trim(),
                        operator: validOps.includes(c.operator) ? c.operator : '>=',
                        value: Number.isFinite(Number(c.value)) ? Number(c.value) : 0,
                    }))
                : [],
        }));
}

/**
 * 规范化单个技能（v2.2：多组与/或前置条件、多附加状态、复合效果、命中暴击、状态槽门槛）
 */
export function normalizeSkill(sk, idx = 0) {
    const defaultId = `skill_${String(idx + 1).padStart(2, '0')}`;
    const validPools = ['class', 'universal', 'monster'];
    const applyStatuses = normalizeApplyStatuses(
        sk?.applyStatuses,
        sk?.applyStatusId,
        sk?.applyStatusChance,
        sk?.applyStatusTarget
    );
    return {
        id: String(sk?.id || defaultId).trim() || defaultId,
        worldview: String(sk?.worldview || '通用').trim() || '通用',
        poolType: validPools.includes(sk?.poolType) ? sk.poolType : 'universal',
        name: String(sk?.name ?? defaultId).trim() || defaultId,
        description: String(sk?.description || ''),
        mpCost: Math.max(0, Math.round(Number(sk?.mpCost ?? 0) || 0)),
        cooldown: Math.max(0, Math.round(Number(sk?.cooldown ?? 0) || 0)),
        targetType: ['single_enemy', 'all_enemies', 'self', 'single_ally', 'all_allies'].includes(sk?.targetType)
            ? sk.targetType
            : 'single_enemy',
        effectType: ['damage', 'heal', 'mp_restore', 'utility', 'struggle'].includes(sk?.effectType)
            ? sk.effectType
            : 'damage',
        formula: String(sk?.formula ?? '10'),
        selfHpFormula: String(sk?.selfHpFormula ?? '0'),
        selfGaugeAChange: Number.isFinite(Number(sk?.selfGaugeChanges?.gauge_a ?? sk?.selfGaugeAChange)) ? Number(sk?.selfGaugeChanges?.gauge_a ?? sk?.selfGaugeAChange) : 0,
        selfGaugeBChange: Number.isFinite(Number(sk?.selfGaugeChanges?.gauge_b ?? sk?.selfGaugeBChange)) ? Number(sk?.selfGaugeChanges?.gauge_b ?? sk?.selfGaugeBChange) : 0,
        targetGaugeAChange: Number.isFinite(Number(sk?.targetGaugeChanges?.gauge_a ?? sk?.targetGaugeAChange)) ? Number(sk?.targetGaugeChanges?.gauge_a ?? sk?.targetGaugeAChange) : 0,
        targetGaugeBChange: Number.isFinite(Number(sk?.targetGaugeChanges?.gauge_b ?? sk?.targetGaugeBChange)) ? Number(sk?.targetGaugeChanges?.gauge_b ?? sk?.targetGaugeBChange) : 0,
        selfGaugeChanges: normalizeGaugeDeltaMap(sk?.selfGaugeChanges, sk?.selfGaugeAChange, sk?.selfGaugeBChange),
        targetGaugeChanges: normalizeGaugeDeltaMap(sk?.targetGaugeChanges, sk?.targetGaugeAChange, sk?.targetGaugeBChange),
        extraEffects: normalizeExtraEffects(sk?.extraEffects),
        applyStatuses,
        requiredTargetStatusIds: normalizeIdList(sk?.requiredTargetStatusIds),
        requiredSelfStatusIds: normalizeIdList(sk?.requiredSelfStatusIds),
        requiredGaugeId: String(sk?.requiredGaugeId || '').trim(),
        requiredGaugeMin: Number.isFinite(Number(sk?.requiredGaugeMin)) ? Math.round(Number(sk.requiredGaugeMin)) : 0,
        prereqGroupLogic: sk?.prereqGroupLogic === 'or' ? 'or' : 'and',
        prereqGroups: normalizePrereqGroups(sk?.prereqGroups),
        hitRate: clamp(sk?.hitRate ?? 100, 1, 100),
        critRate: clamp(sk?.critRate ?? 0, 0, 100),
        critMultiplier: Number.isFinite(Number(sk?.critMultiplier)) && Number(sk.critMultiplier) >= 1
            ? Number(Number(sk.critMultiplier).toFixed(2))
            : 1.5,
        aiPriority: Math.max(1, Math.round(Number(sk?.aiPriority ?? 10) || 10)),
        aiHpBelowPercent: clamp(sk?.aiHpBelowPercent ?? 100, 1, 100),
    };
}

/**
 * 规范化单个职业树节点（v1.5 新增）
 */
export function normalizeClassNode(rawCls, idx = 0) {
    const defaultId = `class_${String(idx + 1).padStart(2, '0')}`;
    const unlockSkills = Array.isArray(rawCls?.unlockSkills)
        ? rawCls.unlockSkills
            .filter(u => u && u.skillId)
            .map(u => ({
                skillId: String(u.skillId).trim(),
                level: Math.max(1, Math.round(Number(u.level ?? 1) || 1)),
            }))
        : [];
    return {
        id: String(rawCls?.id || defaultId).trim() || defaultId,
        worldview: String(rawCls?.worldview || '通用').trim() || '通用',
        name: String(rawCls?.name ?? defaultId).trim() || defaultId,
        description: String(rawCls?.description || ''),
        parentClassId: String(rawCls?.parentClassId || '').trim(),
        requiredLevel: Math.max(1, Math.round(Number(rawCls?.requiredLevel ?? 1) || 1)),
        bonusHp: Math.round(Number(rawCls?.bonusHp ?? 0) || 0),
        bonusMp: Math.round(Number(rawCls?.bonusMp ?? 0) || 0),
        bonusAtk: Math.round(Number(rawCls?.bonusAtk ?? 0) || 0),
        bonusSpi: Math.round(Number(rawCls?.bonusSpi ?? 0) || 0),
        bonusDef: Math.round(Number(rawCls?.bonusDef ?? 0) || 0),
        bonusMdef: Math.round(Number(rawCls?.bonusMdef ?? 0) || 0),
        unlockSkills,
    };
}

/**
 * 规范化单件装备（v1.6：支持解锁多个专属技能 grantSkillIds、附带多个常驻 Buff passiveStatusIds）
 */
export function normalizeEquipment(rawEquip, idx = 0) {
    const defaultId = `equip_${String(idx + 1).padStart(2, '0')}`;
    const validSlots = ['weapon', 'head', 'body', 'accessory'];
    return {
        id: String(rawEquip?.id || defaultId).trim() || defaultId,
        name: String(rawEquip?.name ?? defaultId).trim() || defaultId,
        slot: validSlots.includes(rawEquip?.slot) ? rawEquip.slot : 'accessory',
        description: String(rawEquip?.description || ''),
        bonusHp: Math.round(Number(rawEquip?.bonusHp ?? 0) || 0),
        bonusMp: Math.round(Number(rawEquip?.bonusMp ?? 0) || 0),
        bonusAtk: Math.round(Number(rawEquip?.bonusAtk ?? 0) || 0),
        bonusSpi: Math.round(Number(rawEquip?.bonusSpi ?? 0) || 0),
        bonusDef: Math.round(Number(rawEquip?.bonusDef ?? 0) || 0),
        bonusMdef: Math.round(Number(rawEquip?.bonusMdef ?? 0) || 0),
        grantSkillIds: normalizeIdList(rawEquip?.grantSkillIds, rawEquip?.grantSkillId),
        passiveStatusIds: normalizeIdList(rawEquip?.passiveStatusIds, rawEquip?.passiveStatusId),
    };
}

/**
 * 规范化单个道具（v1.6：支持附加多个状态 applyStatuses）
 */
export function normalizeItem(rawItem, idx = 0) {
    const defaultId = `item_${String(idx + 1).padStart(2, '0')}`;
    const applyStatuses = normalizeApplyStatuses(
        rawItem?.applyStatuses,
        rawItem?.applyStatusId,
        rawItem?.applyStatusChance,
        'target'
    );
    return {
        id: String(rawItem?.id || defaultId).trim() || defaultId,
        name: String(rawItem?.name ?? defaultId).trim() || defaultId,
        icon: String(rawItem?.icon || '🎒'),
        description: String(rawItem?.description || ''),
        quantity: Math.max(0, Math.round(Number(rawItem?.quantity ?? 1) || 0)),
        targetType: ['single_enemy', 'all_enemies', 'self', 'single_ally', 'all_allies'].includes(rawItem?.targetType)
            ? rawItem.targetType
            : 'single_ally',
        effectType: ['heal', 'mp_restore', 'damage', 'cleanse', 'utility'].includes(rawItem?.effectType)
            ? rawItem.effectType
            : 'heal',
        formula: String(rawItem?.formula ?? '30'),
        targetGaugeAChange: Number.isFinite(Number(rawItem?.targetGaugeChanges?.gauge_a ?? rawItem?.targetGaugeAChange)) ? Number(rawItem?.targetGaugeChanges?.gauge_a ?? rawItem?.targetGaugeAChange) : 0,
        targetGaugeBChange: Number.isFinite(Number(rawItem?.targetGaugeChanges?.gauge_b ?? rawItem?.targetGaugeBChange)) ? Number(rawItem?.targetGaugeChanges?.gauge_b ?? rawItem?.targetGaugeBChange) : 0,
        targetGaugeChanges: normalizeGaugeDeltaMap(rawItem?.targetGaugeChanges, rawItem?.targetGaugeAChange, rawItem?.targetGaugeBChange),
        applyStatuses,
        consumesTurn: rawItem?.consumesTurn !== false,
    };
}

/**
 * 对完整配置进行结构合并与安全兜底（完全兼容 v1 旧配置）
 * @param {object} rawConfig
 * @param {object} defaults
 * @returns {object}
 */
export function normalizeConfig(rawConfig, defaults) {
    const base = deepClone(defaults);
    const src = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

    // 1. 全局设置
    const general = {
        ...base.general,
        ...(src.general && typeof src.general === 'object' ? src.general : {}),
    };
    if (!['fill_input', 'clipboard', 'manual'].includes(general.outputMode)) {
        general.outputMode = 'fill_input';
    }
    if (!['append', 'replace'].includes(general.inputFillStrategy)) {
        general.inputFillStrategy = 'append';
    }
    general.enabled = general.enabled !== false;
    general.usePerCharacterConfig = general.usePerCharacterConfig !== false;
    general.listenAiEvents = general.listenAiEvents !== false;
    general.mvuSyncEnabled = general.mvuSyncEnabled !== false;
    general.mvuWriteBack = general.mvuWriteBack !== false;
    general.mvuInheritVitalsOnStart = general.mvuInheritVitalsOnStart !== false;
    general.mvuSyncStatuses = general.mvuSyncStatuses !== false;
    general.syncPartyToAi = general.syncPartyToAi !== false;
    general.syncBattleToAi = general.syncBattleToAi !== false;
    general.syncCatalogToAi = general.syncCatalogToAi !== false;
    general.authoringMode = Boolean(general.authoringMode);
    general.autoEndPlayerTurn = general.autoEndPlayerTurn !== false;
    general.hudStartCollapsed = general.hudStartCollapsed !== false;

    // 1.5 等级、自由加点与按世界观开关的职业树配置（v1.5 新增）
    const baseProg = base.progression || {
        enabled: true,
        pointsPerLevel: 3,
        enabledWorldviews: ['通用', '西幻'],
        statGains: { vitHp: 15, strAtk: 2, spiMag: 2, spiMp: 8, defPhys: 2, mdefMag: 2 },
    };
    const rawProg = src.progression && typeof src.progression === 'object' ? src.progression : {};
    const progression = {
        enabled: rawProg.enabled !== undefined ? Boolean(rawProg.enabled) : baseProg.enabled,
        pointsPerLevel: Math.max(0, Math.round(Number(rawProg.pointsPerLevel ?? baseProg.pointsPerLevel) || 0)),
        enabledWorldviews: Array.isArray(rawProg.enabledWorldviews)
            ? [...new Set(rawProg.enabledWorldviews.map(String).filter(Boolean))]
            : [...baseProg.enabledWorldviews],
        statGains: {
            vitHp: Math.max(1, Math.round(Number(rawProg.statGains?.vitHp ?? baseProg.statGains.vitHp) || 15)),
            strAtk: Math.max(1, Math.round(Number(rawProg.statGains?.strAtk ?? baseProg.statGains.strAtk) || 2)),
            spiMag: Math.max(1, Math.round(Number(rawProg.statGains?.spiMag ?? baseProg.statGains.spiMag) || 2)),
            spiMp: Math.max(0, Math.round(Number(rawProg.statGains?.spiMp ?? baseProg.statGains.spiMp) || 8)),
            defPhys: Math.max(1, Math.round(Number(rawProg.statGains?.defPhys ?? baseProg.statGains.defPhys) || 2)),
            mdefMag: Math.max(1, Math.round(Number(rawProg.statGains?.mdefMag ?? baseProg.statGains.mdefMag) || 2)),
        },
    };

    const rawClasses = Array.isArray(src.classTrees) ? src.classTrees : (base.classTrees || []);
    const classTrees = rawClasses.map((c, idx) => normalizeClassNode(c, idx));

    // 2. 自定义特殊计量条定义（v1.8 升级：支持任意数量自定义状态槽，向下兼容旧版 gauge_a / gauge_b）
    const gauges = {};
    const rawGauges = src.gauges;
    if (Array.isArray(rawGauges)) {
        rawGauges.forEach((g, idx) => {
            if (!g || typeof g !== 'object') return;
            const id = sanitizeGaugeId(g.id || `gauge_${idx + 1}`, `gauge_${idx + 1}`);
            gauges[id] = normalizeGaugeDef(id, g, base.gauges?.[id] || {});
        });
    } else if (rawGauges && typeof rawGauges === 'object') {
        for (const [key, val] of Object.entries(rawGauges)) {
            if (!val || typeof val !== 'object') continue;
            const id = sanitizeGaugeId(val.id || key, key);
            gauges[id] = normalizeGaugeDef(id, val, base.gauges?.[id] || {});
        }
    } else {
        for (const [key, val] of Object.entries(base.gauges || {})) {
            const id = sanitizeGaugeId(key, key);
            gauges[id] = normalizeGaugeDef(id, val, val);
        }
    }
    const validGaugeIds = new Set(Object.keys(gauges));

    // 3. 状态（Buff/Debuff）库（v1.2 组合效果 + v1.8 动态状态槽每回合增减 perTurnGauges）
    const rawStatuses = Array.isArray(src.statuses) ? src.statuses : base.statuses;
    const statuses = rawStatuses.map((st, idx) => {
        const hasNewPerTurn = st && (
            st.perTurnHp !== undefined || st.perTurnMp !== undefined
            || st.perTurnGaugeA !== undefined || st.perTurnGaugeB !== undefined
            || (st.perTurnGauges && typeof st.perTurnGauges === 'object')
        );
        const legacyVal = Number.isFinite(Number(st?.value)) ? Number(st.value) : 0;
        const legacyStat = st?.targetStat || 'hp';

        const perTurnHp = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnHp)) ? Math.round(Number(st.perTurnHp)) : 0)
            : (legacyStat === 'hp' ? Math.round(legacyVal) : 0);
        const perTurnMp = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnMp)) ? Math.round(Number(st.perTurnMp)) : 0)
            : (legacyStat === 'mp' ? Math.round(legacyVal) : 0);
        const legacyGA = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnGauges?.gauge_a ?? st?.perTurnGaugeA)) ? Math.round(Number(st?.perTurnGauges?.gauge_a ?? st?.perTurnGaugeA)) : 0)
            : (legacyStat === 'gauge_a' ? Math.round(legacyVal) : 0);
        const legacyGB = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnGauges?.gauge_b ?? st?.perTurnGaugeB)) ? Math.round(Number(st?.perTurnGauges?.gauge_b ?? st?.perTurnGaugeB)) : 0)
            : (legacyStat === 'gauge_b' ? Math.round(legacyVal) : 0);
        const perTurnGauges = normalizeGaugeDeltaMap(st?.perTurnGauges, legacyGA, legacyGB);
        if (!hasNewPerTurn && validGaugeIds.has(legacyStat) && legacyVal !== 0) {
            perTurnGauges[legacyStat] = Math.round(legacyVal);
        }

        const skipTurn = st?.skipTurn !== undefined ? Boolean(st.skipTurn) : st?.effectType === 'skip_turn';

        return {
            id: String(st?.id || `status_${idx + 1}`).trim() || `status_${idx + 1}`,
            name: String(st?.name ?? `status_${idx + 1}`).trim() || `status_${idx + 1}`,
            icon: String(st?.icon || '✨'),
            description: String(st?.description || ''),
            skipTurn,
            perTurnHp,
            perTurnMp,
            perTurnGaugeA: perTurnGauges.gauge_a ?? 0,
            perTurnGaugeB: perTurnGauges.gauge_b ?? 0,
            perTurnGauges,
            gaugeChangeMultipliers: normalizeGaugeMultipliers(st?.gaugeChangeMultipliers),
            atkMultiplier: Number.isFinite(Number(st?.atkMultiplier)) ? Number(st.atkMultiplier) : 1,
            spiMultiplier: Number.isFinite(Number(st?.spiMultiplier)) ? Number(st.spiMultiplier) : 1,
            defMultiplier: Number.isFinite(Number(st?.defMultiplier)) ? Number(st.defMultiplier) : 1,
            mdefMultiplier: Number.isFinite(Number(st?.mdefMultiplier)) ? Number(st.mdefMultiplier) : 1,
            damageTakenMultiplier: Number.isFinite(Number(st?.damageTakenMultiplier)) && Number(st.damageTakenMultiplier) >= 0
                ? Number(Number(st.damageTakenMultiplier).toFixed(2))
                : 1,
            duration: Math.max(1, Math.round(Number(st?.duration ?? 1) || 1)),
            onExpireStatusIds: normalizeIdList(st?.onExpireStatusIds, st?.onExpireStatusId),
            // v1.7 束缚/禁锢机制字段
            restraintType: ['physical', 'magical'].includes(st?.restraintType) ? st.restraintType : '',
            restraintSourceMode: st?.restraintSourceMode === 'object' ? 'object' : 'caster',
            restraintPower: Math.max(0, Number(st?.restraintPower ?? 0) || 0),
            restraintObjectHp: Math.max(1, Math.round(Number(st?.restraintObjectHp ?? 50) || 50)),
            restraintObjectName: String(st?.restraintObjectName || '').trim(),
            // v2.2 Buff 添加来源追踪设置
            sourceTrackingMode: ['auto', 'per_caster', 'fixed'].includes(st?.sourceTrackingMode) ? st.sourceTrackingMode : 'auto',
            defaultSourceLabel: String(st?.defaultSourceLabel || '').trim(),
        };
    });

    // 4. 技能库
    const rawSkills = Array.isArray(src.skills) ? src.skills : base.skills;
    const skills = rawSkills.map((sk, idx) => normalizeSkill(sk, idx));

    // 5. 装备库 & 道具库（v1.1 新增）
    const rawEquips = Array.isArray(src.equipments) ? src.equipments : (base.equipments || []);
    const equipments = rawEquips.map((eq, idx) => normalizeEquipment(eq, idx));

    const rawItems = Array.isArray(src.items) ? src.items : (base.items || []);
    const items = rawItems.map((it, idx) => normalizeItem(it, idx));

    // 6. 我方与敌方模板库（我方最多 6 人；敌方作为敌人图鉴可存任意多种，开战/增援时场上最多同时 6v6）
    const rawAllies = Array.isArray(src.allies) && src.allies.length > 0 ? src.allies : base.allies;
    const rawEnemies = Array.isArray(src.enemies) && src.enemies.length > 0 ? src.enemies : base.enemies;
    const allies = rawAllies.slice(0, MAX_UNITS_PER_SIDE).map((u, idx) => normalizeUnitTemplate(u, 'ally', idx));
    const enemies = rawEnemies.map((u, idx) => normalizeUnitTemplate(u, 'enemy', idx));

    // 7. 阈值触发规则（支持 Prompt 注入 + 状态满/空自动挂载 Buff + 任意自定义状态槽）
    const rawRules = Array.isArray(src.triggerRules) ? src.triggerRules : base.triggerRules;
    const baseCondTypes = new Set(['hp', 'hp_percent', 'mp', 'gauge_a', 'gauge_b', 'has_status']);
    const triggerRules = rawRules.map((r, idx) => {
        const rawCond = String(r?.conditionType || 'hp').trim();
        const conditionType = (baseCondTypes.has(rawCond) || validGaugeIds.has(rawCond)) ? rawCond : 'hp';
        const rawReset = String(r?.resetGaugeOnTrigger || '').trim();
        const resetGaugeOnTrigger = (rawReset && (validGaugeIds.has(rawReset) || rawReset === 'gauge_a' || rawReset === 'gauge_b')) ? rawReset : '';
        return {
            id: String(r?.id || `rule_${idx + 1}`).trim() || `rule_${idx + 1}`,
            name: String(r?.name ?? `rule_${idx + 1}`).trim() || `rule_${idx + 1}`,
            enabled: r?.enabled !== false,
            scope: ['any_ally', 'all_allies', 'any_enemy', 'all_enemies', 'specific_unit'].includes(r?.scope)
                ? r.scope
                : 'any_ally',
            unitId: String(r?.unitId || ''),
            conditionType,
            operator: ['<=', '<', '>=', '>', '=='].includes(r?.operator) ? r.operator : '<=',
            threshold: Number.isFinite(Number(r?.threshold)) ? Number(r.threshold) : 0,
            statusId: String(r?.statusId || ''),
            grantStatusIds: normalizeIdList(r?.grantStatusIds, r?.grantStatusId),
            grantStatusMode: r?.grantStatusMode === 'on_enter' ? 'on_enter' : 'while_condition',
            resetGaugeOnTrigger,
            position: ['in_chat', 'in_prompt', 'before_prompt'].includes(r?.position) ? r.position : 'in_chat',
            depth: Math.max(0, Math.round(Number(r?.depth ?? 1) || 0)),
            role: ['system', 'user', 'assistant'].includes(r?.role) ? r.role : 'system',
            promptText: String(r?.promptText || ''),
        };
    });

    return {
        schemaVersion: base.schemaVersion || 4,
        general,
        progression,
        gauges,
        classTrees,
        statuses,
        skills,
        equipments,
        items,
        allies,
        enemies,
        triggerRules,
    };
}

/**
 * 读取当前生效配置（支持按角色卡自动隔离方案）
 * @returns {Promise<object>}
 */
export async function loadConfig() {
    const defaults = await loadDefaultConfig();
    const ctx = getSTContext();

    if (ctx.extensionSettings) {
        if (!ctx.extensionSettings[EXTENSION_KEY]) {
            ctx.extensionSettings[EXTENSION_KEY] = {};
        }
        const rootStore = ctx.extensionSettings[EXTENSION_KEY];
        const globalCfg = normalizeConfig(rootStore.config, defaults);
        rootStore.config = globalCfg;

        const usePerChar = rootStore.usePerCharacterConfig !== undefined
            ? Boolean(rootStore.usePerCharacterConfig)
            : globalCfg.general.usePerCharacterConfig !== false;

        const profileInfo = getCurrentProfileInfo(ctx);
        if (usePerChar && profileInfo.key) {
            if (!rootStore.profilesByChar) {
                rootStore.profilesByChar = {};
            }
            const storedProfile = rootStore.profilesByChar[profileInfo.key];
            const profileCfg = normalizeConfig(storedProfile || globalCfg, defaults);
            profileCfg.general.usePerCharacterConfig = true;
            return profileCfg;
        }

        globalCfg.general.usePerCharacterConfig = usePerChar;
        return deepClone(globalCfg);
    }

    try {
        const raw = localStorage.getItem(`${EXTENSION_KEY}_config`);
        return normalizeConfig(raw ? JSON.parse(raw) : null, defaults);
    } catch {
        return defaults;
    }
}

/**
 * 持久化保存当前配置（自动保存到当前角色卡专属方案或全局方案）
 * @param {object} config
 */
export function saveConfig(config) {
    const ctx = getSTContext();
    if (ctx.extensionSettings) {
        if (!ctx.extensionSettings[EXTENSION_KEY]) {
            ctx.extensionSettings[EXTENSION_KEY] = {};
        }
        const rootStore = ctx.extensionSettings[EXTENSION_KEY];
        const usePerChar = config?.general?.usePerCharacterConfig !== false;
        rootStore.usePerCharacterConfig = usePerChar;

        const profileInfo = getCurrentProfileInfo(ctx);
        if (usePerChar && profileInfo.key) {
            if (!rootStore.profilesByChar) {
                rootStore.profilesByChar = {};
            }
            rootStore.profilesByChar[profileInfo.key] = deepClone(config);
        } else {
            rootStore.config = deepClone(config);
        }

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
 * 将当前方案另存为全局模板（供新角色卡首次进入时继承）
 * @param {object} config
 */
export function saveAsGlobalTemplate(config) {
    const ctx = getSTContext();
    if (ctx.extensionSettings) {
        if (!ctx.extensionSettings[EXTENSION_KEY]) {
            ctx.extensionSettings[EXTENSION_KEY] = {};
        }
        ctx.extensionSettings[EXTENSION_KEY].config = deepClone(config);
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }
}

/**
 * 载入内置世界观扩展包（如西幻完整职业与技能包），纯前端 fetch，绝不硬编码在 JS 逻辑里
 * @param {string} packFileName 例如 'western_fantasy_pack.json'
 * @param {'merge'|'replace'} mode
 * @param {object} currentConfig
 * @returns {Promise<{ config: object, summary: string }>}
 */
export async function loadBuiltinPresetPack(packFileName, mode = 'merge', currentConfig = null) {
    const url = new URL(`../presets/${packFileName}`, import.meta.url);
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`无法加载内置世界观包 (${resp.status}): ${packFileName}`);
    }
    const text = await resp.text();
    return importConfigFromJsonText(text, mode, currentConfig);
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
 * 导出当前配置为 JSON 文件（纯前端 Blob 下载）
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
 * 从可能带 Markdown 代码块（```json ... ```）的文本中提取纯 JSON
 * 方便用户直接复制“写卡助手”的回复粘贴导入
 * @param {string} rawText
 * @returns {string}
 */
export function stripMarkdownJsonFence(rawText) {
    const trimmed = String(rawText || '').trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        return fenceMatch[1].trim();
    }
    // 容错：若未包代码块但前后带有 AI 说明文字，自动截取最外层 { ... } JSON 对象
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1).trim();
    }
    return trimmed;
}

/**
 * 规范化单个状态对象（导出供 ai_event_listener 动态收录新状态使用）
 */
export function normalizeStatusDef(st, idx = 0) {
    const perTurnHp = Number.isFinite(Number(st?.perTurnHp)) ? Math.round(Number(st.perTurnHp)) : 0;
    const perTurnMp = Number.isFinite(Number(st?.perTurnMp)) ? Math.round(Number(st.perTurnMp)) : 0;
    const perTurnGauges = normalizeGaugeDeltaMap(st?.perTurnGauges, st?.perTurnGaugeA, st?.perTurnGaugeB);
    return {
        id: String(st?.id || `status_${idx + 1}`).trim() || `status_${idx + 1}`,
        name: String(st?.name ?? `status_${idx + 1}`).trim() || `status_${idx + 1}`,
        icon: String(st?.icon || '✨'),
        description: String(st?.description || ''),
        skipTurn: Boolean(st?.skipTurn || st?.effectType === 'skip_turn'),
        perTurnHp,
        perTurnMp,
        perTurnGaugeA: perTurnGauges.gauge_a ?? 0,
        perTurnGaugeB: perTurnGauges.gauge_b ?? 0,
        perTurnGauges,
        gaugeChangeMultipliers: normalizeGaugeMultipliers(st?.gaugeChangeMultipliers),
        atkMultiplier: Number.isFinite(Number(st?.atkMultiplier)) ? Number(st.atkMultiplier) : 1,
        spiMultiplier: Number.isFinite(Number(st?.spiMultiplier)) ? Number(st.spiMultiplier) : 1,
        defMultiplier: Number.isFinite(Number(st?.defMultiplier)) ? Number(st.defMultiplier) : 1,
        mdefMultiplier: Number.isFinite(Number(st?.mdefMultiplier)) ? Number(st.mdefMultiplier) : 1,
        damageTakenMultiplier: Number.isFinite(Number(st?.damageTakenMultiplier)) && Number(st.damageTakenMultiplier) >= 0
            ? Number(Number(st.damageTakenMultiplier).toFixed(2))
            : 1,
        duration: Math.max(1, Math.round(Number(st?.duration ?? 1) || 1)),
        onExpireStatusIds: normalizeIdList(st?.onExpireStatusIds, st?.onExpireStatusId),
        restraintType: ['physical', 'magical'].includes(st?.restraintType) ? st.restraintType : '',
        restraintSourceMode: st?.restraintSourceMode === 'object' ? 'object' : 'caster',
        restraintPower: Math.max(0, Number(st?.restraintPower ?? 0) || 0),
        restraintObjectHp: Math.max(1, Math.round(Number(st?.restraintObjectHp ?? 50) || 50)),
        restraintObjectName: String(st?.restraintObjectName || '').trim(),
        sourceTrackingMode: ['auto', 'per_caster', 'fixed'].includes(st?.sourceTrackingMode) ? st.sourceTrackingMode : 'auto',
        defaultSourceLabel: String(st?.defaultSourceLabel || '').trim(),
    };
}

/**
 * 局部修改单条配置时清理与新字段互斥的旧版单字段，避免 normalize 时旧值反客为主
 */
function mergeSingleItemPatch(existingObj, incomingObj) {
    const clean = deepClone(incomingObj);
    const renameTo = typeof clean._renameTo === 'string' ? clean._renameTo.trim() : '';
    const replaceWhole = Boolean(clean._replace);
    delete clean._replace;
    delete clean._delete;
    delete clean._targetId;
    delete clean._renameTo;

    if (replaceWhole) {
        const finalId = renameTo || clean.id || existingObj.id;
        return { ...clean, id: finalId };
    }

    const merged = { ...deepClone(existingObj), ...clean };
    if (renameTo) merged.id = renameTo;

    // 同步新旧镜像字段，避免局部修改新字段时被旧字段残留覆盖
    if (Object.prototype.hasOwnProperty.call(clean, 'selfGaugeChanges')) {
        delete merged.selfGaugeAChange;
        delete merged.selfGaugeBChange;
    } else if (Object.prototype.hasOwnProperty.call(clean, 'selfGaugeAChange') || Object.prototype.hasOwnProperty.call(clean, 'selfGaugeBChange')) {
        merged.selfGaugeChanges = { ...(merged.selfGaugeChanges || {}) };
        if (Object.prototype.hasOwnProperty.call(clean, 'selfGaugeAChange')) merged.selfGaugeChanges.gauge_a = Number(clean.selfGaugeAChange) || 0;
        if (Object.prototype.hasOwnProperty.call(clean, 'selfGaugeBChange')) merged.selfGaugeChanges.gauge_b = Number(clean.selfGaugeBChange) || 0;
    }

    if (Object.prototype.hasOwnProperty.call(clean, 'targetGaugeChanges')) {
        delete merged.targetGaugeAChange;
        delete merged.targetGaugeBChange;
    } else if (Object.prototype.hasOwnProperty.call(clean, 'targetGaugeAChange') || Object.prototype.hasOwnProperty.call(clean, 'targetGaugeBChange')) {
        merged.targetGaugeChanges = { ...(merged.targetGaugeChanges || {}) };
        if (Object.prototype.hasOwnProperty.call(clean, 'targetGaugeAChange')) merged.targetGaugeChanges.gauge_a = Number(clean.targetGaugeAChange) || 0;
        if (Object.prototype.hasOwnProperty.call(clean, 'targetGaugeBChange')) merged.targetGaugeChanges.gauge_b = Number(clean.targetGaugeBChange) || 0;
    }

    if (Object.prototype.hasOwnProperty.call(clean, 'perTurnGauges')) {
        delete merged.perTurnGaugeA;
        delete merged.perTurnGaugeB;
    } else if (Object.prototype.hasOwnProperty.call(clean, 'perTurnGaugeA') || Object.prototype.hasOwnProperty.call(clean, 'perTurnGaugeB')) {
        merged.perTurnGauges = { ...(merged.perTurnGauges || {}) };
        if (Object.prototype.hasOwnProperty.call(clean, 'perTurnGaugeA')) merged.perTurnGauges.gauge_a = Number(clean.perTurnGaugeA) || 0;
        if (Object.prototype.hasOwnProperty.call(clean, 'perTurnGaugeB')) merged.perTurnGauges.gauge_b = Number(clean.perTurnGaugeB) || 0;
    }

    if (Object.prototype.hasOwnProperty.call(clean, 'initialGauges')) {
        delete merged.initialGaugeA;
        delete merged.initialGaugeB;
    } else if (Object.prototype.hasOwnProperty.call(clean, 'initialGaugeA') || Object.prototype.hasOwnProperty.call(clean, 'initialGaugeB')) {
        merged.initialGauges = { ...(merged.initialGauges || {}) };
        if (Object.prototype.hasOwnProperty.call(clean, 'initialGaugeA')) merged.initialGauges.gauge_a = Number(clean.initialGaugeA) || 0;
        if (Object.prototype.hasOwnProperty.call(clean, 'initialGaugeB')) merged.initialGauges.gauge_b = Number(clean.initialGaugeB) || 0;
    }

    if (Object.prototype.hasOwnProperty.call(clean, 'applyStatuses')) delete merged.applyStatusId;
    if (Object.prototype.hasOwnProperty.call(clean, 'onExpireStatusIds')) delete merged.onExpireStatusId;
    if (Object.prototype.hasOwnProperty.call(clean, 'grantSkillIds')) delete merged.grantSkillId;
    if (Object.prototype.hasOwnProperty.call(clean, 'passiveStatusIds')) delete merged.passiveStatusId;
    if (Object.prototype.hasOwnProperty.call(clean, 'grantStatusIds')) delete merged.grantStatusId;

    return merged;
}

/**
 * 按 ID 执行数组补丁：支持同时修改已有项（局部修改或 _replace 整条替换）、新增新项、删除旧项（_delete）
 * @param {Array<object>} existingArr
 * @param {Array<object>} incomingArr
 * @param {'patch'|'add_only'} mode
 * @param {number} [maxLen]
 * @param {Array<string>} [explicitDeleteIds]
 * @returns {{ merged: Array<object>, added: number, updated: number, deleted: number, skipped: number }}
 */
function patchArrayById(existingArr, incomingArr, mode = 'patch', maxLen = Infinity, explicitDeleteIds = []) {
    let result = deepClone(existingArr || []);
    let added = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;

    // 1. 先执行顶层 _delete 指定删除的 ID
    if (mode !== 'add_only' && Array.isArray(explicitDeleteIds) && explicitDeleteIds.length > 0) {
        const delSet = new Set(explicitDeleteIds.map(String));
        const before = result.length;
        result = result.filter(x => !delSet.has(x.id));
        deleted += before - result.length;
    }

    // 2. 逐条处理修改、整条替换、行内删除与新增
    for (const item of incomingArr || []) {
        if (!item || typeof item !== 'object') continue;
        const targetId = String(item._targetId || item.id || '').trim();
        const idx = targetId ? result.findIndex(x => x.id === targetId) : -1;

        if (item._delete === true) {
            if (mode !== 'add_only' && idx >= 0) {
                result.splice(idx, 1);
                deleted++;
            }
            continue;
        }

        if (idx >= 0) {
            if (mode === 'add_only') {
                skipped++;
            } else {
                result[idx] = mergeSingleItemPatch(result[idx], item);
                updated++;
            }
        } else if (result.length < maxLen) {
            const clean = deepClone(item);
            delete clean._replace;
            delete clean._delete;
            delete clean._targetId;
            if (clean._renameTo) { clean.id = String(clean._renameTo).trim(); delete clean._renameTo; }
            result.push(clean);
            added++;
        }
    }

    return { merged: result, added, updated, deleted, skipped };
}

/**
 * 纯函数：将解析后的 JSON 补丁应用到当前配置（支持 patch/merge 修改+新增+删除、add_only 仅新增、replace 完整覆盖）
 * @param {object|null} currentConfig
 * @param {object} parsed
 * @param {'patch'|'merge'|'add_only'|'replace'} mode
 * @param {object} defaults
 * @returns {{ config: object, summary: string }}
 */
export function applyConfigPatch(currentConfig, parsed, mode = 'patch', defaults) {
    const effMode = mode === 'merge' ? 'patch' : mode;

    if (effMode === 'replace' || !currentConfig) {
        const normalized = normalizeConfig(parsed, defaults);
        return {
            config: normalized,
            summary: '已完整替换当前方案配置',
        };
    }

    const mergedRaw = deepClone(currentConfig);
    const notes = [];
    const replaceSectionSet = new Set(
        effMode === 'patch' && Array.isArray(parsed._replaceSections)
            ? parsed._replaceSections.map(String)
            : []
    );
    const deleteMap = (effMode === 'patch' && parsed._delete && typeof parsed._delete === 'object')
        ? parsed._delete
        : {};

    if (effMode === 'patch' && parsed.general && typeof parsed.general === 'object') {
        mergedRaw.general = replaceSectionSet.has('general')
            ? deepClone(parsed.general)
            : { ...mergedRaw.general, ...parsed.general };
        notes.push('基础设置(改)');
    }

    if (effMode === 'patch' && parsed.progression && typeof parsed.progression === 'object') {
        if (replaceSectionSet.has('progression')) {
            mergedRaw.progression = deepClone(parsed.progression);
        } else {
            mergedRaw.progression = {
                ...mergedRaw.progression,
                ...parsed.progression,
                enabledWorldviews: Array.isArray(parsed.progression.enabledWorldviews)
                    ? (parsed.progression._replaceWorldviews
                        ? [...new Set(parsed.progression.enabledWorldviews.map(String))]
                        : [...new Set([...(mergedRaw.progression?.enabledWorldviews || []), ...parsed.progression.enabledWorldviews])])
                    : mergedRaw.progression?.enabledWorldviews,
                statGains: {
                    ...(mergedRaw.progression?.statGains || {}),
                    ...(parsed.progression.statGains || {}),
                },
            };
        }
        notes.push('成长设置(改)');
    }

    // 处理自定义状态槽（支持整块替换、删除、局部修改已有槽、新增额外槽）
    if (!mergedRaw.gauges || typeof mergedRaw.gauges !== 'object') mergedRaw.gauges = {};
    let gAdded = 0; let gUpdated = 0; let gDeleted = 0;
    if (effMode === 'patch' && Array.isArray(deleteMap.gauges)) {
        for (const delGid of deleteMap.gauges) {
            const cid = sanitizeGaugeId(delGid, delGid);
            if (mergedRaw.gauges[cid]) { delete mergedRaw.gauges[cid]; gDeleted++; }
            else if (mergedRaw.gauges[delGid]) { delete mergedRaw.gauges[delGid]; gDeleted++; }
        }
    }
    if (parsed.gauges && typeof parsed.gauges === 'object') {
        if (replaceSectionSet.has('gauges')) {
            mergedRaw.gauges = {};
        }
        const entries = Array.isArray(parsed.gauges)
            ? parsed.gauges.filter(g => g && typeof g === 'object').map((g, i) => [g.id || `gauge_${i + 1}`, g])
            : Object.entries(parsed.gauges).filter(([, g]) => g && typeof g === 'object');
        for (const [k, g] of entries) {
            const gid = sanitizeGaugeId(g._targetId || g.id || k, k);
            if (g._delete === true) {
                if (effMode === 'patch' && mergedRaw.gauges[gid]) { delete mergedRaw.gauges[gid]; gDeleted++; }
                continue;
            }
            const exists = Boolean(mergedRaw.gauges[gid]);
            if (exists && effMode === 'add_only') continue;
            const cleanG = deepClone(g);
            delete cleanG._replace;
            delete cleanG._delete;
            delete cleanG._targetId;
            const finalId = cleanG._renameTo ? sanitizeGaugeId(cleanG._renameTo, gid) : gid;
            delete cleanG._renameTo;
            if (exists && finalId !== gid) delete mergedRaw.gauges[gid];
            mergedRaw.gauges[finalId] = (exists && !g._replace)
                ? { ...mergedRaw.gauges[gid], ...cleanG, id: finalId }
                : { ...cleanG, id: finalId };
            if (exists) gUpdated++; else gAdded++;
        }
    }
    if (gAdded || gUpdated || gDeleted) {
        const parts = [];
        if (gUpdated) parts.push(`改${gUpdated}`);
        if (gAdded) parts.push(`增${gAdded}`);
        if (gDeleted) parts.push(`删${gDeleted}`);
        notes.push(`状态槽(${parts.join('/')})`);
    }

    const sections = [
        ['classTrees', '职业树', Infinity],
        ['statuses', '状态', Infinity],
        ['skills', '技能', Infinity],
        ['equipments', '装备', Infinity],
        ['items', '道具', Infinity],
        ['allies', '我方角色', MAX_UNITS_PER_SIDE],
        ['enemies', '敌方图鉴', Infinity],
        ['triggerRules', '触发规则', Infinity],
    ];

    for (const [key, label, maxLen] of sections) {
        const incomingArr = Array.isArray(parsed[key]) ? parsed[key] : null;
        const delIds = Array.isArray(deleteMap[key]) ? deleteMap[key] : [];

        if (replaceSectionSet.has(key) && incomingArr) {
            mergedRaw[key] = deepClone(incomingArr.slice(0, maxLen));
            notes.push(`${label}(整区替换为${mergedRaw[key].length}项)`);
            continue;
        }

        if ((incomingArr && incomingArr.length > 0) || delIds.length > 0) {
            const { merged, added, updated, deleted, skipped } = patchArrayById(
                mergedRaw[key],
                incomingArr || [],
                effMode === 'add_only' ? 'add_only' : 'patch',
                maxLen,
                delIds
            );
            mergedRaw[key] = merged;
            const parts = [];
            if (updated) parts.push(`改${updated}`);
            if (added) parts.push(`增${added}`);
            if (deleted) parts.push(`删${deleted}`);
            if (skipped) parts.push(`跳过已有${skipped}`);
            if (parts.length > 0) notes.push(`${label}(${parts.join('/')})`);
        }
    }

    const normalized = normalizeConfig(mergedRaw, defaults);
    const modeLabel = effMode === 'add_only' ? '仅新增导入完成' : '修改+新增导入成功';
    return {
        config: normalized,
        summary: notes.length ? `${modeLabel}：${notes.join('、')}` : '未检测到需要新增、修改或删除的字段',
    };
}

/**
 * 从 JSON 文本导入配置（支持「修改+新增 patch/merge」、「仅新增 add_only」与「完整替换 replace」）
 * @param {string} jsonText
 * @param {'patch'|'merge'|'add_only'|'replace'} mode
 * @param {object|null} currentConfig 非 replace 模式时必传
 * @returns {Promise<{ config: object, summary: string }>}
 */
export async function importConfigFromJsonText(jsonText, mode = 'patch', currentConfig = null) {
    const cleaned = stripMarkdownJsonFence(jsonText);
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        throw new Error(`JSON 格式有误，请检查括号、引号或逗号：${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON 根节点必须是对象格式（以 { 开头）');
    }

    const defaults = await loadDefaultConfig();
    const res = applyConfigPatch(currentConfig, parsed, mode, defaults);
    saveConfig(res.config);
    return res;
}

/**
 * 读取当前聊天对应的战斗进度（不同角色卡/不同聊天窗口严格隔离）
 * @returns {object|null}
 */
export function loadBattleState() {
    const ctx = getSTContext();
    const scopeKey = getCurrentChatScopeKey(ctx);

    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
        const metaEntry = ctx.chatMetadata[EXTENSION_KEY];
        if (metaEntry && Object.prototype.hasOwnProperty.call(metaEntry, 'battleState')) {
            return metaEntry.battleState ? deepClone(metaEntry.battleState) : null;
        }
    }

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
        delete ctx.extensionSettings[EXTENSION_KEY].fallbackBattleState;
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }
}
