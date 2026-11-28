/**
 * 阈值触发引擎 + AI 战况/档案/图鉴上下文同步模块 (src/prompt_injector.js) - v1.3
 * 职责：
 * 1. 阈值触发：自动挂载/移除 Buff（while_condition / on_enter）+ 自动注入/撤回剧情 Prompt
 * 2. v1.3 新增「AI 剧情感知同步」：通过 setExtensionPrompt 向剧情 AI 精准注入 3 块可独立开关的精简信息：
 *    - 我方当前角色档案（穿戴装备、已学技能、背包道具库存）
 *    - 战斗中实时战场快照（敌我实时 HP/MP、双状态槽、当前 Buff、敌方技能与简介，非战斗自动撤回）
 *    - 极简世界观图鉴目录（所有技能/装备/道具/敌人的 [ID] 名称：简述，供 AI 按 ID 精准发技能、掉装备、塞敌人！）
 */

import { EXTENSION_KEY, getGaugeEntries, getSTContext } from './config.js';
import {
    appendBattleLog,
    findClassById,
    findEquipmentById,
    findSkillById,
    findStatusDefById,
    formatEnemyIntentSummary,
    getAllUnits,
    getEffectiveStats,
    getUnitAvailableSkills,
    isAlive,
    isWorldviewEnabled,
} from './engine.js';

const CONTEXT_PROMPT_KEY = `${EXTENSION_KEY}_ai_context`;
const SLOT_LABELS = { weapon: '武器', head: '头部', body: '防具', accessory: '饰品' };

/** 记录当前已经向酒馆注入过的阈值规则 Prompt Key */
const activeInjectedKeys = new Set();

function compareValue(actual, operator, threshold) {
    switch (operator) {
        case '<=': return actual <= threshold;
        case '<':  return actual < threshold;
        case '>=': return actual >= threshold;
        case '>':  return actual > threshold;
        case '==': return actual === threshold;
        default:   return false;
    }
}

function doesUnitMatchRule(unit, rule, config) {
    if (!unit) return false;
    switch (rule.conditionType) {
        case 'hp': return compareValue(unit.hp, rule.operator, rule.threshold);
        case 'hp_percent': {
            const pct = unit.maxHp > 0 ? (unit.hp / unit.maxHp) * 100 : 0;
            return compareValue(pct, rule.operator, rule.threshold);
        }
        case 'mp': return compareValue(unit.mp, rule.operator, rule.threshold);
        case 'has_status':
            return Boolean(rule.statusId) && (unit.statuses || []).some(s => s.statusId === rule.statusId);
        default: {
            const gDef = config?.gauges?.[rule.conditionType];
            if (gDef || rule.conditionType === 'gauge_a' || rule.conditionType === 'gauge_b') {
                const val = unit.gauges?.[rule.conditionType] ?? (gDef?.min ?? 0);
                return compareValue(val, rule.operator, rule.threshold);
            }
            return false;
        }
    }
}

function evaluateRule(battleState, rule, config) {
    if (!battleState || !battleState.active || !rule.enabled) {
        return { matched: false, matchedUnits: [] };
    }
    const allies = battleState.allies || [];
    const enemies = battleState.enemies || [];
    switch (rule.scope) {
        case 'any_ally': {
            const matchedUnits = allies.filter(u => doesUnitMatchRule(u, rule, config));
            return { matched: matchedUnits.length > 0, matchedUnits };
        }
        case 'all_allies': {
            const matched = allies.length > 0 && allies.every(u => doesUnitMatchRule(u, rule, config));
            return { matched, matchedUnits: matched ? allies : [] };
        }
        case 'any_enemy': {
            const matchedUnits = enemies.filter(u => doesUnitMatchRule(u, rule, config));
            return { matched: matchedUnits.length > 0, matchedUnits };
        }
        case 'all_enemies': {
            const matched = enemies.length > 0 && enemies.every(u => doesUnitMatchRule(u, rule, config));
            return { matched, matchedUnits: matched ? enemies : [] };
        }
        case 'specific_unit': {
            const unit = getAllUnits(battleState).find(u => u.id === rule.unitId);
            const ok = unit ? doesUnitMatchRule(unit, rule, config) : false;
            return { matched: ok, matchedUnits: ok ? [unit] : [] };
        }
        default:
            return { matched: false, matchedUnits: [] };
    }
}

function renderPromptTemplate(template, matchedUnits, battleState, config) {
    const primary = matchedUnits[0] || {};
    const names = matchedUnits.map(u => u.name).join('、') || '';

    const replacements = {
        '{{unit_name}}': names,
        '{{hp}}': String(primary.hp ?? 0),
        '{{max_hp}}': String(primary.maxHp ?? 0),
        '{{mp}}': String(primary.mp ?? 0),
        '{{max_mp}}': String(primary.maxMp ?? 0),
        '{{gauge_a}}': String(primary.gauges?.gauge_a ?? 0),
        '{{gauge_b}}': String(primary.gauges?.gauge_b ?? 0),
        '{{gauge_a_name}}': config.gauges?.gauge_a?.name || 'gauge_a',
        '{{gauge_b_name}}': config.gauges?.gauge_b?.name || 'gauge_b',
        '{{turn}}': String(battleState?.turn ?? 1),
    };
    for (const gDef of getGaugeEntries(config)) {
        replacements[`{{${gDef.id}}}`] = String(primary.gauges?.[gDef.id] ?? gDef.min);
        replacements[`{{${gDef.id}_name}}`] = gDef.name;
    }

    let text = String(template || '');
    for (const [token, value] of Object.entries(replacements)) {
        text = text.replaceAll(token, value);
    }
    return text.trim();
}

function mapPromptOptions(ctx, rule) {
    const types = ctx.extension_prompt_types || { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
    const roles = ctx.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

    let position = types.IN_CHAT ?? 1;
    if (rule.position === 'in_prompt') position = types.IN_PROMPT ?? 0;
    if (rule.position === 'before_prompt') position = types.BEFORE_PROMPT ?? 2;

    let role = roles.SYSTEM ?? 0;
    if (rule.role === 'user') role = roles.USER ?? 1;
    if (rule.role === 'assistant') role = roles.ASSISTANT ?? 2;

    const depth = Math.max(0, Math.round(Number(rule.depth ?? 1) || 0));
    return { position, depth, role };
}

function callSetExtensionPrompt(key, value, position = 1, depth = 1, role = 0) {
    const ctx = getSTContext();
    const fn = ctx.setExtensionPrompt || (typeof window !== 'undefined' ? window.setExtensionPrompt : null);
    if (typeof fn === 'function') {
        try {
            fn(key, value, position, depth, false, role);
        } catch (err) {
            console.warn(`[CombatFramework] 调用 setExtensionPrompt(${key}) 失败:`, err);
        }
    }
}

export function clearAllInjectedPrompts() {
    for (const key of activeInjectedKeys) {
        callSetExtensionPrompt(key, '', 1, 1, 0);
    }
    activeInjectedKeys.clear();
    callSetExtensionPrompt(CONTEXT_PROMPT_KEY, '', 1, 2, 0);
}

/**
 * 第一阶段：同步阈值自动挂载/移除 Buff
 */
function syncThresholdBuffs(battleState, config) {
    if (!Array.isArray(battleState.triggeredRuleUnits)) {
        battleState.triggeredRuleUnits = [];
    }
    const prevEnteredSet = new Set(battleState.triggeredRuleUnits);
    const nextEnteredSet = new Set();
    const allUnits = getAllUnits(battleState);

    const desiredWhileKeysByUnit = new Map();
    for (const u of allUnits) {
        desiredWhileKeysByUnit.set(u.id, new Set());
    }

    for (const rule of config.triggerRules || []) {
        const grantIds = Array.isArray(rule.grantStatusIds)
            ? rule.grantStatusIds
            : (rule.grantStatusId ? [rule.grantStatusId] : []);
        if (!rule.enabled || grantIds.length === 0) continue;

        const statusDefs = grantIds.map(id => findStatusDefById(config, id)).filter(Boolean);
        if (statusDefs.length === 0) continue;

        const { matched, matchedUnits } = evaluateRule(battleState, rule, config);
        if (!matched) continue;

        for (const unit of matchedUnits) {
            if (!isAlive(unit)) continue;
            const pairKey = `${rule.id}::${unit.id}`;

            if (rule.grantStatusMode === 'on_enter') {
                if (!prevEnteredSet.has(pairKey)) {
                    for (const statusDef of statusDefs) {
                        const existing = (unit.statuses || []).find(
                            s => s.statusId === statusDef.id && (!s.source || s.source === 'normal')
                        );
                        if (existing) {
                            existing.remainingTurns = Math.max(existing.remainingTurns, statusDef.duration);
                        } else {
                            unit.statuses.push({
                                statusId: statusDef.id,
                                remainingTurns: statusDef.duration,
                                source: 'normal',
                            });
                        }
                    }
                    let resetNote = '';
                    const resetGid = rule.resetGaugeOnTrigger;
                    const resetGDef = resetGid ? config.gauges?.[resetGid] : null;
                    if (resetGid && (resetGDef || resetGid === 'gauge_a' || resetGid === 'gauge_b')) {
                        const resetVal = resetGDef?.min ?? 0;
                        if (!unit.gauges || typeof unit.gauges !== 'object') unit.gauges = {};
                        unit.gauges[resetGid] = resetVal;
                        const gName = resetGDef?.name || resetGid;
                        resetNote = `，并将「${gName}」重置为 ${resetVal}`;
                    } else {
                        nextEnteredSet.add(pairKey);
                    }
                    const namesStr = statusDefs.map(d => `「${d.name}」(${d.duration}回合)`).join('、');
                    appendBattleLog(
                        battleState,
                        `⚡ 触发规则「${rule.name}」：${unit.name} 获得状态 ${namesStr}${resetNote}！`
                    );
                } else {
                    nextEnteredSet.add(pairKey);
                }
            } else {
                const newlyAdded = [];
                for (const statusDef of statusDefs) {
                    const key = `${rule.id}::${statusDef.id}`;
                    desiredWhileKeysByUnit.get(unit.id)?.add(key);

                    const exists = (unit.statuses || []).some(
                        s => s.source === 'threshold' && s.sourceRuleId === rule.id && s.statusId === statusDef.id
                    );
                    if (!exists) {
                        unit.statuses.push({
                            statusId: statusDef.id,
                            remainingTurns: 99,
                            source: 'threshold',
                            sourceRuleId: rule.id,
                            sourceLabel: rule.name,
                        });
                        newlyAdded.push(`「${statusDef.name}」`);
                    }
                }
                if (newlyAdded.length > 0) {
                    appendBattleLog(
                        battleState,
                        `⚡ 触发规则「${rule.name}」：${unit.name} 获得阈值状态 ${newlyAdded.join('、')}！`
                    );
                }
            }
        }
    }

    for (const unit of allUnits) {
        const keepSet = desiredWhileKeysByUnit.get(unit.id) || new Set();
        unit.statuses = (unit.statuses || []).filter(st => {
            if (st.source !== 'threshold') return true;
            const keep = keepSet.has(`${st.sourceRuleId}::${st.statusId}`);
            if (!keep) {
                const def = findStatusDefById(config, st.statusId);
                if (def) {
                    appendBattleLog(battleState, `✨ ${unit.name} 脱离阈值条件，状态「${def.name}」已自动解除。`);
                }
            }
            return keep;
        });
    }

    battleState.triggeredRuleUnits = [...nextEnteredSet];
}

/**
 * 构建创作模式专用的「当前完整配置精简 JSON」（去掉重复的旧版镜像字段，让写卡助手一眼看清全部技能/状态/装备/敌人/槽位/规则的真实数值！）
 */
export function buildAuthoringConfigSnapshot(config) {
    const cleanSkill = (s) => {
        const out = {
            id: s.id, worldview: s.worldview, poolType: s.poolType, name: s.name, description: s.description,
            mpCost: s.mpCost, cooldown: s.cooldown || 0, targetType: s.targetType, effectType: s.effectType,
            formula: s.formula,
        };
        if (s.hitRate !== 100) out.hitRate = s.hitRate;
        if (s.critRate) { out.critRate = s.critRate; out.critMultiplier = s.critMultiplier; }
        if (s.interruptible && s.interruptible !== 'none') out.interruptible = s.interruptible;
        if (s.canInterrupt) {
            out.canInterrupt = true;
            if ((s.interruptChance ?? 100) !== 100) out.interruptChance = s.interruptChance;
        }
        if (s.selfHpFormula && s.selfHpFormula !== '0') out.selfHpFormula = s.selfHpFormula;
        if (s.selfGaugeChanges && Object.keys(s.selfGaugeChanges).length) out.selfGaugeChanges = s.selfGaugeChanges;
        if (s.targetGaugeChanges && Object.keys(s.targetGaugeChanges).length) out.targetGaugeChanges = s.targetGaugeChanges;
        if (s.extraEffects?.length) out.extraEffects = s.extraEffects;
        if (s.applyStatuses?.length) out.applyStatuses = s.applyStatuses;
        if (s.requiredTargetStatusIds?.length) out.requiredTargetStatusIds = s.requiredTargetStatusIds;
        if (s.requiredSelfStatusIds?.length) out.requiredSelfStatusIds = s.requiredSelfStatusIds;
        if (s.requiredGaugeId) { out.requiredGaugeId = s.requiredGaugeId; out.requiredGaugeMin = s.requiredGaugeMin || 0; }
        if (s.prereqGroups?.length) { out.prereqGroupLogic = s.prereqGroupLogic || 'and'; out.prereqGroups = s.prereqGroups; }
        out.aiPriority = s.aiPriority;
        if (s.aiHpBelowPercent < 100) out.aiHpBelowPercent = s.aiHpBelowPercent;
        return out;
    };

    const cleanStatus = (st) => {
        const out = {
            id: st.id, name: st.name, icon: st.icon, description: st.description, duration: st.duration,
        };
        if (st.skipTurn) out.skipTurn = true;
        if (st.perTurnHp) out.perTurnHp = st.perTurnHp;
        if (st.perTurnMp) out.perTurnMp = st.perTurnMp;
        if (st.perTurnGauges && Object.keys(st.perTurnGauges).length) out.perTurnGauges = st.perTurnGauges;
        if (st.gaugeChangeMultipliers?.length) out.gaugeChangeMultipliers = st.gaugeChangeMultipliers;
        if (st.atkMultiplier !== 1) out.atkMultiplier = st.atkMultiplier;
        if (st.spiMultiplier !== 1) out.spiMultiplier = st.spiMultiplier;
        if (st.defMultiplier !== 1) out.defMultiplier = st.defMultiplier;
        if (st.mdefMultiplier !== 1) out.mdefMultiplier = st.mdefMultiplier;
        if (st.damageTakenMultiplier !== 1) out.damageTakenMultiplier = st.damageTakenMultiplier;
        if (st.onExpireStatusIds?.length) out.onExpireStatusIds = st.onExpireStatusIds;
        if (st.restraintType) {
            out.restraintType = st.restraintType;
            out.restraintSourceMode = st.restraintSourceMode;
            out.restraintPower = st.restraintPower;
            out.restraintObjectHp = st.restraintObjectHp;
            if (st.restraintObjectName) out.restraintObjectName = st.restraintObjectName;
        }
        if (st.sourceTrackingMode && st.sourceTrackingMode !== 'auto') out.sourceTrackingMode = st.sourceTrackingMode;
        if (st.defaultSourceLabel) out.defaultSourceLabel = st.defaultSourceLabel;
        return out;
    };

    const cleanItem = (it) => {
        const out = {
            id: it.id, name: it.name, icon: it.icon, description: it.description, quantity: it.quantity,
            targetType: it.targetType, effectType: it.effectType, formula: it.formula, consumesTurn: it.consumesTurn,
        };
        if (it.targetGaugeChanges && Object.keys(it.targetGaugeChanges).length) out.targetGaugeChanges = it.targetGaugeChanges;
        if (it.applyStatuses?.length) out.applyStatuses = it.applyStatuses;
        return out;
    };

    const cleanUnit = (u) => {
        const out = {
            id: u.id, enabled: u.enabled, name: u.name, description: u.description,
            level: u.level, classId: u.classId, maxHp: u.maxHp, maxMp: u.maxMp,
            atk: u.atk, spi: u.spi, def: u.def, mdef: u.mdef,
            skillIds: u.skillIds, equipmentIds: u.equipmentIds, aiStrategy: u.aiStrategy, aiTargetMode: u.aiTargetMode || 'target_first',
        };
        if (u.initialGauges && Object.keys(u.initialGauges).length) out.initialGauges = u.initialGauges;
        if (u.freePoints) out.freePoints = u.freePoints;
        if (u.autoControl) out.autoControl = true;
        return out;
    };

    const payload = {
        progression: config.progression,
        gauges: config.gauges,
        classTrees: config.classTrees || [],
        statuses: (config.statuses || []).map(cleanStatus),
        skills: (config.skills || []).map(cleanSkill),
        equipments: config.equipments || [],
        items: (config.items || []).map(cleanItem),
        allies: (config.allies || []).map(cleanUnit),
        enemies: (config.enemies || []).map(cleanUnit),
        triggerRules: config.triggerRules || [],
    };
    return JSON.stringify(payload);
}

/**
 * 构建发送给剧情 AI 的上下文文本（普通游玩模式省 Token；创作模式下注入完整配置 JSON 给写卡助手查阅与修改）
 * @param {object|null} battleState
 * @param {object} config
 * @returns {string}
 */
export function buildAiContextSnapshot(battleState, config) {
    if (!config?.general?.enabled) return '';

    const blocks = [];
    const gaugeEntries = getGaugeEntries(config);

    // 创作模式（v2.1 新增）：直接注入当前插件完整详细配置 JSON，供写卡助手精准查看与修改已有设定
    if (config.general.authoringMode) {
        const fullJson = buildAuthoringConfigSnapshot(config);
        blocks.push(
            '[TRPG 创作模式已开启 · 当前插件完整配置数据（写卡助手可直接查看全部技能公式/状态倍率/装备/敌人/状态槽/规则）]\n'
            + '提示：你可以在同一个 JSON 代码块里同时修改已有 ID（只写要改的字段即可，加 "_replace":true 为整条替换）、用 "_delete" 删除旧项、用 "_replaceSections" 整块替换分区，并新增新条目；用户复制粘贴点「✏️ 修改+新增导入」即可一步生效。\n'
            + fullJson
        );
    }

    // 块 1：我方当前出战角色档案（穿戴装备、已学技能、背包道具）
    if (config.general.syncPartyToAi) {
        const partyLines = ['[TRPG 我方当前角色与背包档案]'];
        const activeAllies = (config.allies || []).filter(u => u.enabled);
        const alliesSource = activeAllies.length ? activeAllies : (config.allies || []).slice(0, 1);

        for (const ally of alliesSource) {
            const live = battleState?.active ? (battleState.allies || []).find(u => u.id === ally.id) : null;
            const equipIds = live ? (live.equipmentIds || []) : (ally.equipmentIds || []);
            const equipsText = equipIds
                .map(id => {
                    const eq = findEquipmentById(config, id);
                    return eq ? `${eq.name}(${SLOT_LABELS[eq.slot] || eq.slot})` : '';
                })
                .filter(Boolean)
                .join('、') || '无';

            const skillIds = live
                ? getUnitAvailableSkills(live, config).map(x => x.skill.id)
                : getUnitAvailableSkills({ ...ally, side: 'ally' }, config).map(x => x.skill.id);
            const skillsText = [...new Set(skillIds)]
                .map(id => findSkillById(config, id)?.name || '')
                .filter(Boolean)
                .join('、') || '无';

            const clsName = findClassById(config, live?.classId ?? ally.classId)?.name || '';
            const lvTag = config.progression?.enabled ? `Lv.${live?.level ?? ally.level ?? 1}${clsName ? ` ${clsName}` : ''}` : '';
            const descNote = ally.description ? `（${ally.description}）` : '';
            partyLines.push(`- ${ally.name}[${ally.id}]${lvTag ? ` ${lvTag}` : ''}${descNote}｜装备：${equipsText}｜可用技能：${skillsText}`);
        }

        const stockedItems = (config.items || []).filter(it => (it.quantity || 0) > 0);
        const itemsText = stockedItems.map(it => `${it.name}×${it.quantity}`).join('、') || '空';
        partyLines.push(`- 背包道具：${itemsText}`);
        blocks.push(partyLines.join('\n'));
    }

    // 块 2：实时战场快照（仅战斗进行中注入，平时自动撤回）
    if (config.general.syncBattleToAi && battleState && battleState.active) {
        const formatUnitLine = (u) => {
            const eff = getEffectiveStats(u, config);
            const stText = (u.statuses || []).map(st => {
                const def = findStatusDefById(config, st.statusId);
                if (!def) return '';
                if (def.restraintType) {
                    if (def.restraintSourceMode === 'object' && st.objectHp > 0) {
                        const objName = def.restraintObjectName || def.name;
                        return `${objName}[禁锢道具HP:${st.objectHp}/${st.objectMaxHp || st.objectHp}]`;
                    }
                    return `${def.name}[被束缚·${st.remainingTurns}T]`;
                }
                const tag = st.source === 'equipment' ? '装备常驻' : (st.source === 'threshold' ? '阈值维持' : `${st.remainingTurns}T`);
                return `${def.name}(${tag})`;
            }).filter(Boolean).join('、') || '无';
            const aliveTag = isAlive(u) ? '' : '[已倒下]';
            const desc = u.description ? `｜简介:${u.description}` : '';
            const gaugesStr = gaugeEntries.map(g => `${g.name}:${u.gauges?.[g.id] ?? g.min}/${g.max}`).join(' ');
            const intentInfo = u.side === 'enemy' ? formatEnemyIntentSummary(u, battleState, config) : null;
            const intentNote = intentInfo ? `｜本回合意图:${intentInfo.text}${intentInfo.badge ? `[${intentInfo.badge}]` : ''}` : '';
            return `- ${u.name}${aliveTag} HP:${u.hp}/${u.maxHp} MP:${u.mp}/${u.maxMp} 物攻:${eff.atk} 精神:${eff.spi} 物防:${eff.def} 法抗:${eff.mdef}${gaugesStr ? ` ${gaugesStr}` : ''}｜状态:${stText}${intentNote}${desc}`;
        };

        const phaseNote = battleState.phase === 'victory'
            ? ' · 战斗已胜利'
            : (battleState.phase === 'defeat' ? ' · 战斗已失败' : '');
        const battleLines = [
            `[TRPG 实时战况 · 第 ${battleState.turn} 回合${phaseNote}]`,
            '我方：',
            ...(battleState.allies || []).map(formatUnitLine),
            '敌方：',
            ...(battleState.enemies || []).map(formatUnitLine),
        ];
        blocks.push(battleLines.join('\n'));
    }

    // 块 3：极简世界观图鉴目录（若已开启创作模式则省略，避免与完整 JSON 重复占 Token）
    if (config.general.syncCatalogToAi && !config.general.authoringMode) {
        const catLines = ['[TRPG 可调用图鉴目录（发技能/装备/道具或刷怪/增援时优先引用下列 ID）]'];

        if ((config.enemies || []).length > 0) {
            const txt = config.enemies.map(e => `${e.id}:${e.name}${e.description ? `(${e.description})` : ''}`).join('；');
            catLines.push(`- 敌人图鉴：${txt}`);
        }
        if ((config.skills || []).length > 0) {
            const txt = config.skills.map(s => `${s.id}:${s.name}${s.description ? `(${s.description})` : ''}`).join('；');
            catLines.push(`- 技能库：${txt}`);
        }
        if ((config.equipments || []).length > 0) {
            const txt = config.equipments.map(e => `${e.id}:${e.name}[${SLOT_LABELS[e.slot] || e.slot}]${e.description ? `(${e.description})` : ''}`).join('；');
            catLines.push(`- 装备库：${txt}`);
        }
        if ((config.items || []).length > 0) {
            const txt = config.items.map(it => `${it.id}:${it.name}${it.description ? `(${it.description})` : ''}`).join('；');
            catLines.push(`- 道具库：${txt}`);
        }
        if ((config.statuses || []).length > 0) {
            const txt = config.statuses.map(st => `${st.id}:${st.name}${st.description ? `(${st.description})` : ''}`).join('；');
            catLines.push(`- 状态/Buff库：${txt}`);
        }
        const enabledClasses = (config.classTrees || []).filter(c => isWorldviewEnabled(config, c.worldview));
        if (config.progression?.enabled && enabledClasses.length > 0) {
            const txt = enabledClasses.map(c => `${c.id}:${c.name}[${c.worldview}/Lv.${c.requiredLevel}]`).join('；');
            catLines.push(`- 职业树：${txt}`);
        }

        if (catLines.length > 1) {
            blocks.push(catLines.join('\n'));
        }
    }

    return blocks.join('\n\n').trim();
}

/**
 * 同步 AI 上下文摘要（档案 / 战况 / 图鉴目录），返回当前注入的文本供 HUD 预览
 * @param {object|null} battleState
 * @param {object} config
 * @returns {string}
 */
export function syncAiContextSnapshot(battleState, config) {
    const text = buildAiContextSnapshot(battleState, config);
    const ctx = getSTContext();
    const types = ctx.extension_prompt_types || { IN_CHAT: 1 };
    const roles = ctx.extension_prompt_roles || { SYSTEM: 0 };
    callSetExtensionPrompt(CONTEXT_PROMPT_KEY, text, types.IN_CHAT ?? 1, 2, roles.SYSTEM ?? 0);
    return text;
}

/**
 * 核心同步函数：执行阈值 Buff、阈值 Prompt 注入，并同步 AI 上下文摘要
 * @param {object|null} battleState
 * @param {object} config
 * @returns {{ activeRules: Array<object>, contextText: string }}
 */
export function syncThresholdPrompts(battleState, config) {
    if (!config?.general?.enabled) {
        clearAllInjectedPrompts();
        return { activeRules: [], contextText: '' };
    }

    const activeRules = [];
    const nextKeys = new Set();

    if (battleState && battleState.active) {
        syncThresholdBuffs(battleState, config);

        const ctx = getSTContext();
        for (const rule of config.triggerRules || []) {
            if (!rule.promptText?.trim()) continue;
            const { matched, matchedUnits } = evaluateRule(battleState, rule, config);
            const promptKey = `${EXTENSION_KEY}_rule_${rule.id}`;

            if (matched) {
                const renderedText = renderPromptTemplate(rule.promptText, matchedUnits, battleState, config);
                if (renderedText) {
                    const { position, depth, role } = mapPromptOptions(ctx, rule);
                    callSetExtensionPrompt(promptKey, renderedText, position, depth, role);
                    nextKeys.add(promptKey);
                    activeRules.push({
                        id: rule.id,
                        name: rule.name,
                        renderedText,
                        matchedUnitNames: matchedUnits.map(u => u.name),
                    });
                }
            }
        }
    }

    for (const oldKey of activeInjectedKeys) {
        if (!nextKeys.has(oldKey)) {
            callSetExtensionPrompt(oldKey, '', 1, 1, 0);
        }
    }
    activeInjectedKeys.clear();
    for (const key of nextKeys) {
        activeInjectedKeys.add(key);
    }

    // 同步我方档案 / 实时战况 / 极简图鉴目录给剧情 AI
    const contextText = syncAiContextSnapshot(battleState, config);
    return { activeRules, contextText };
}
