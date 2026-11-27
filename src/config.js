/**
 * 配置管理模块 (src/config.js) - v1.1
 * 职责：
 * 1. 从 default_config.json 读取初始配置（纯前端，零 Node.js 依赖）
 * 2. 支持「按角色卡独立保存配置方案（Profile）」与全局方案自由切换
 * 3. 严格按当前聊天/角色卡 ID 隔离战斗进度，切换角色卡绝不串台
 * 4. 支持一键导出 JSON、上传/粘贴 JSON 导入，并支持「完整替换」与「增量合并」（完美配合写卡助手！）
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
        initialGaugeA: clamp(rawUnit?.initialGaugeA ?? 0, 0, 100),
        initialGaugeB: clamp(rawUnit?.initialGaugeB ?? 0, 0, 100),
        skillIds: Array.isArray(rawUnit?.skillIds) ? rawUnit.skillIds.map(String) : [],
        equipmentIds: Array.isArray(rawUnit?.equipmentIds) ? rawUnit.equipmentIds.map(String) : [],
        aiStrategy: ['priority', 'weighted', 'random'].includes(rawUnit?.aiStrategy) ? rawUnit.aiStrategy : 'priority',
        autoControl: side === 'ally' ? Boolean(rawUnit?.autoControl) : false,
    };
}

/**
 * 规范化技能/道具的“多附加状态列表”（100% 向下兼容旧版单字段 applyStatusId）
 */
function normalizeApplyStatuses(rawList, legacyId, legacyChance = 100, legacyTarget = 'target') {
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
                    target: x.target === 'self' ? 'self' : 'target',
                };
            })
            .filter(x => x.statusId);
    }
    const singleId = String(legacyId || '').trim();
    if (!singleId) return [];
    return [{
        statusId: singleId,
        chance: clamp(legacyChance ?? 100, 0, 100),
        target: legacyTarget === 'self' ? 'self' : 'target',
    }];
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
 * 规范化单个技能（v1.6：多附加状态、冷却 CD、自身 HP 卖血/吸血公式、自身前置状态）
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
        selfGaugeAChange: Number.isFinite(Number(sk?.selfGaugeAChange)) ? Number(sk.selfGaugeAChange) : 0,
        selfGaugeBChange: Number.isFinite(Number(sk?.selfGaugeBChange)) ? Number(sk.selfGaugeBChange) : 0,
        targetGaugeAChange: Number.isFinite(Number(sk?.targetGaugeAChange)) ? Number(sk.targetGaugeAChange) : 0,
        targetGaugeBChange: Number.isFinite(Number(sk?.targetGaugeBChange)) ? Number(sk.targetGaugeBChange) : 0,
        applyStatuses,
        requiredTargetStatusIds: normalizeIdList(sk?.requiredTargetStatusIds),
        requiredSelfStatusIds: normalizeIdList(sk?.requiredSelfStatusIds),
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
        targetGaugeAChange: Number.isFinite(Number(rawItem?.targetGaugeAChange)) ? Number(rawItem.targetGaugeAChange) : 0,
        targetGaugeBChange: Number.isFinite(Number(rawItem?.targetGaugeBChange)) ? Number(rawItem.targetGaugeBChange) : 0,
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

    // 2. 特殊计量条定义（固定 2 个：gauge_a、gauge_b，范围 0-100，v1.2 支持每回合自动增减）
    const normalizeGaugeDef = (rawG, baseG) => ({
        ...baseG,
        ...(rawG || {}),
        min: 0,
        max: 100,
        perTurnChange: Number.isFinite(Number(rawG?.perTurnChange)) ? Math.round(Number(rawG.perTurnChange)) : (baseG.perTurnChange || 0),
        perTurnScope: ['all', 'allies', 'enemies'].includes(rawG?.perTurnScope) ? rawG.perTurnScope : (baseG.perTurnScope || 'all'),
    });
    const gauges = {
        gauge_a: normalizeGaugeDef(src.gauges?.gauge_a, base.gauges.gauge_a),
        gauge_b: normalizeGaugeDef(src.gauges?.gauge_b, base.gauges.gauge_b),
    };

    // 3. 状态（Buff/Debuff）库（v1.2 支持自由组合效果：跳过回合 + 多属性每回合变化 + 攻防倍率 + 到期转化）
    const rawStatuses = Array.isArray(src.statuses) ? src.statuses : base.statuses;
    const statuses = rawStatuses.map((st, idx) => {
        // 向下兼容 v1.0/v1.1 的单字段 targetStat + value 以及 effectType === 'skip_turn'
        const hasNewPerTurn = st && (
            st.perTurnHp !== undefined || st.perTurnMp !== undefined
            || st.perTurnGaugeA !== undefined || st.perTurnGaugeB !== undefined
        );
        const legacyVal = Number.isFinite(Number(st?.value)) ? Number(st.value) : 0;
        const legacyStat = st?.targetStat || 'hp';

        const perTurnHp = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnHp)) ? Math.round(Number(st.perTurnHp)) : 0)
            : (legacyStat === 'hp' ? Math.round(legacyVal) : 0);
        const perTurnMp = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnMp)) ? Math.round(Number(st.perTurnMp)) : 0)
            : (legacyStat === 'mp' ? Math.round(legacyVal) : 0);
        const perTurnGaugeA = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnGaugeA)) ? Math.round(Number(st.perTurnGaugeA)) : 0)
            : (legacyStat === 'gauge_a' ? Math.round(legacyVal) : 0);
        const perTurnGaugeB = hasNewPerTurn
            ? (Number.isFinite(Number(st?.perTurnGaugeB)) ? Math.round(Number(st.perTurnGaugeB)) : 0)
            : (legacyStat === 'gauge_b' ? Math.round(legacyVal) : 0);

        const skipTurn = st?.skipTurn !== undefined ? Boolean(st.skipTurn) : st?.effectType === 'skip_turn';

        return {
            id: String(st?.id || `status_${idx + 1}`).trim() || `status_${idx + 1}`,
            name: String(st?.name ?? `status_${idx + 1}`).trim() || `status_${idx + 1}`,
            icon: String(st?.icon || '✨'),
            description: String(st?.description || ''),
            skipTurn,
            perTurnHp,
            perTurnMp,
            perTurnGaugeA,
            perTurnGaugeB,
            atkMultiplier: Number.isFinite(Number(st?.atkMultiplier)) ? Number(st.atkMultiplier) : 1,
            spiMultiplier: Number.isFinite(Number(st?.spiMultiplier)) ? Number(st.spiMultiplier) : 1,
            defMultiplier: Number.isFinite(Number(st?.defMultiplier)) ? Number(st.defMultiplier) : 1,
            mdefMultiplier: Number.isFinite(Number(st?.mdefMultiplier)) ? Number(st.mdefMultiplier) : 1,
            duration: Math.max(1, Math.round(Number(st?.duration ?? 1) || 1)),
            onExpireStatusIds: normalizeIdList(st?.onExpireStatusIds, st?.onExpireStatusId),
            // v1.7 束缚/禁锢机制字段
            restraintType: ['physical', 'magical'].includes(st?.restraintType) ? st.restraintType : '',
            restraintSourceMode: st?.restraintSourceMode === 'object' ? 'object' : 'caster',
            restraintPower: Math.max(0, Number(st?.restraintPower ?? 0) || 0),
            restraintObjectHp: Math.max(1, Math.round(Number(st?.restraintObjectHp ?? 50) || 50)),
            restraintObjectName: String(st?.restraintObjectName || '').trim(),
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

    // 6. 我方与敌方模板库（我方最多 4 人；敌方作为敌人图鉴可存任意多种，开战/增援时场上最多同时 4v4）
    const rawAllies = Array.isArray(src.allies) && src.allies.length > 0 ? src.allies : base.allies;
    const rawEnemies = Array.isArray(src.enemies) && src.enemies.length > 0 ? src.enemies : base.enemies;
    const allies = rawAllies.slice(0, MAX_UNITS_PER_SIDE).map((u, idx) => normalizeUnitTemplate(u, 'ally', idx));
    const enemies = rawEnemies.map((u, idx) => normalizeUnitTemplate(u, 'enemy', idx));

    // 7. 阈值触发规则（支持 Prompt 注入 + 状态满/空自动挂载 Buff）
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
        grantStatusIds: normalizeIdList(r?.grantStatusIds, r?.grantStatusId),
        grantStatusMode: r?.grantStatusMode === 'on_enter' ? 'on_enter' : 'while_condition',
        resetGaugeOnTrigger: ['gauge_a', 'gauge_b'].includes(r?.resetGaugeOnTrigger) ? r.resetGaugeOnTrigger : '',
        position: ['in_chat', 'in_prompt', 'before_prompt'].includes(r?.position) ? r.position : 'in_chat',
        depth: Math.max(0, Math.round(Number(r?.depth ?? 1) || 0)),
        role: ['system', 'user', 'assistant'].includes(r?.role) ? r.role : 'system',
        promptText: String(r?.promptText || ''),
    }));

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
    return trimmed;
}

/**
 * 按 ID 增量合并数组（同 ID 更新，新 ID 追加）
 * @param {Array<object>} existingArr
 * @param {Array<object>} incomingArr
 * @param {number} [maxLen]
 * @returns {{ merged: Array<object>, count: number }}
 */
function mergeArrayById(existingArr, incomingArr, maxLen = Infinity) {
    const result = deepClone(existingArr || []);
    let count = 0;
    for (const item of incomingArr || []) {
        if (!item || typeof item !== 'object') continue;
        const idx = item.id ? result.findIndex(x => x.id === item.id) : -1;
        if (idx >= 0) {
            result[idx] = { ...result[idx], ...item };
            count++;
        } else if (result.length < maxLen) {
            result.push(deepClone(item));
            count++;
        }
    }
    return { merged: result, count };
}

/**
 * 从 JSON 文本导入配置（支持「完整替换 replace」与「增量合并 merge」）
 * @param {string} jsonText
 * @param {'replace'|'merge'} mode
 * @param {object|null} currentConfig 增量合并时必传
 * @returns {Promise<{ config: object, summary: string }>}
 */
export async function importConfigFromJsonText(jsonText, mode = 'replace', currentConfig = null) {
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

    if (mode === 'merge' && currentConfig) {
        const mergedRaw = deepClone(currentConfig);
        const notes = [];

        if (parsed.general && typeof parsed.general === 'object') {
            mergedRaw.general = { ...mergedRaw.general, ...parsed.general };
            notes.push('基础设置');
        }
        if (parsed.progression && typeof parsed.progression === 'object') {
            mergedRaw.progression = {
                ...mergedRaw.progression,
                ...parsed.progression,
                enabledWorldviews: Array.isArray(parsed.progression.enabledWorldviews)
                    ? [...new Set([...(mergedRaw.progression?.enabledWorldviews || []), ...parsed.progression.enabledWorldviews])]
                    : mergedRaw.progression?.enabledWorldviews,
                statGains: {
                    ...(mergedRaw.progression?.statGains || {}),
                    ...(parsed.progression.statGains || {}),
                },
            };
            notes.push('成长与世界观设置');
        }
        if (parsed.gauges && typeof parsed.gauges === 'object') {
            mergedRaw.gauges = {
                gauge_a: { ...mergedRaw.gauges.gauge_a, ...(parsed.gauges.gauge_a || {}) },
                gauge_b: { ...mergedRaw.gauges.gauge_b, ...(parsed.gauges.gauge_b || {}) },
            };
            notes.push('特殊槽');
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
            if (Array.isArray(parsed[key]) && parsed[key].length > 0) {
                const { merged, count } = mergeArrayById(mergedRaw[key], parsed[key], maxLen);
                mergedRaw[key] = merged;
                notes.push(`${count} 项${label}`);
            }
        }

        const normalized = normalizeConfig(mergedRaw, defaults);
        saveConfig(normalized);
        return {
            config: normalized,
            summary: notes.length ? `增量合并成功：已导入/更新 ${notes.join('、')}` : '未检测到可合并的字段',
        };
    }

    const normalized = normalizeConfig(parsed, defaults);
    saveConfig(normalized);
    return {
        config: normalized,
        summary: '已完整替换当前方案配置',
    };
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
