/**
 * 阈值触发引擎 + AI 战况/档案/图鉴上下文同步模块 (src/prompt_injector.js) - v1.3
 * 职责：
 * 1. 阈值触发：自动挂载/移除 Buff（while_condition / on_enter）+ 自动注入/撤回剧情 Prompt
 * 2. v1.3 新增「AI 剧情感知同步」：通过 setExtensionPrompt 向剧情 AI 精准注入 3 块可独立开关的精简信息：
 *    - 我方当前角色档案（穿戴装备、已学技能、背包道具库存）
 *    - 战斗中实时战场快照（敌我实时 HP/MP、双状态槽、当前 Buff、敌方技能与简介，非战斗自动撤回）
 *    - 极简世界观图鉴目录（所有技能/装备/道具/敌人的 [ID] 名称：简述，供 AI 按 ID 精准发技能、掉装备、塞敌人！）
 */

import { EXTENSION_KEY, getSTContext } from './config.js';
import {
    appendBattleLog,
    findEquipmentById,
    findSkillById,
    findStatusDefById,
    getAllUnits,
    getEffectiveStats,
    getUnitAvailableSkills,
    isAlive,
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

function doesUnitMatchRule(unit, rule) {
    if (!unit) return false;
    switch (rule.conditionType) {
        case 'hp': return compareValue(unit.hp, rule.operator, rule.threshold);
        case 'hp_percent': {
            const pct = unit.maxHp > 0 ? (unit.hp / unit.maxHp) * 100 : 0;
            return compareValue(pct, rule.operator, rule.threshold);
        }
        case 'mp': return compareValue(unit.mp, rule.operator, rule.threshold);
        case 'gauge_a': return compareValue(unit.gauges?.gauge_a ?? 0, rule.operator, rule.threshold);
        case 'gauge_b': return compareValue(unit.gauges?.gauge_b ?? 0, rule.operator, rule.threshold);
        case 'has_status':
            return Boolean(rule.statusId) && (unit.statuses || []).some(s => s.statusId === rule.statusId);
        default: return false;
    }
}

function evaluateRule(battleState, rule) {
    if (!battleState || !battleState.active || !rule.enabled) {
        return { matched: false, matchedUnits: [] };
    }
    const allies = battleState.allies || [];
    const enemies = battleState.enemies || [];
    switch (rule.scope) {
        case 'any_ally': {
            const matchedUnits = allies.filter(u => doesUnitMatchRule(u, rule));
            return { matched: matchedUnits.length > 0, matchedUnits };
        }
        case 'all_allies': {
            const matched = allies.length > 0 && allies.every(u => doesUnitMatchRule(u, rule));
            return { matched, matchedUnits: matched ? allies : [] };
        }
        case 'any_enemy': {
            const matchedUnits = enemies.filter(u => doesUnitMatchRule(u, rule));
            return { matched: matchedUnits.length > 0, matchedUnits };
        }
        case 'all_enemies': {
            const matched = enemies.length > 0 && enemies.every(u => doesUnitMatchRule(u, rule));
            return { matched, matchedUnits: matched ? enemies : [] };
        }
        case 'specific_unit': {
            const unit = getAllUnits(battleState).find(u => u.id === rule.unitId);
            const ok = unit ? doesUnitMatchRule(unit, rule) : false;
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
        if (!rule.enabled || !rule.grantStatusId) continue;
        const statusDef = findStatusDefById(config, rule.grantStatusId);
        if (!statusDef) continue;

        const { matched, matchedUnits } = evaluateRule(battleState, rule);
        if (!matched) continue;

        for (const unit of matchedUnits) {
            if (!isAlive(unit)) continue;
            const pairKey = `${rule.id}::${unit.id}`;

            if (rule.grantStatusMode === 'on_enter') {
                if (!prevEnteredSet.has(pairKey)) {
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
                    let resetNote = '';
                    if (rule.resetGaugeOnTrigger === 'gauge_a' || rule.resetGaugeOnTrigger === 'gauge_b') {
                        unit.gauges[rule.resetGaugeOnTrigger] = 0;
                        const gName = config.gauges?.[rule.resetGaugeOnTrigger]?.name || rule.resetGaugeOnTrigger;
                        resetNote = `，并将「${gName}」重置为 0`;
                    } else {
                        nextEnteredSet.add(pairKey);
                    }
                    appendBattleLog(
                        battleState,
                        `⚡ 触发规则「${rule.name}」：${unit.name} 获得状态「${statusDef.name}」(${statusDef.duration}回合)${resetNote}！`
                    );
                } else {
                    nextEnteredSet.add(pairKey);
                }
            } else {
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
                    appendBattleLog(
                        battleState,
                        `⚡ 触发规则「${rule.name}」：${unit.name} 获得阈值状态「${statusDef.name}」！`
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
 * 构建发送给剧情 AI 的精简上下文文本（按 3 个开关按需拼接，省 Token）
 * @param {object|null} battleState
 * @param {object} config
 * @returns {string}
 */
export function buildAiContextSnapshot(battleState, config) {
    if (!config?.general?.enabled) return '';

    const blocks = [];
    const gAName = config.gauges?.gauge_a?.name || '状态槽A';
    const gBName = config.gauges?.gauge_b?.name || '状态槽B';

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

            const skillIds = live ? getUnitAvailableSkills(live, config).map(x => x.skill.id) : (ally.skillIds || []);
            const skillsText = [...new Set(skillIds)]
                .map(id => findSkillById(config, id)?.name || '')
                .filter(Boolean)
                .join('、') || '无';

            const descNote = ally.description ? `（${ally.description}）` : '';
            partyLines.push(`- ${ally.name}[${ally.id}]${descNote}｜装备：${equipsText}｜已学技能：${skillsText}`);
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
                const tag = st.source === 'equipment' ? '装备常驻' : (st.source === 'threshold' ? '阈值维持' : `${st.remainingTurns}T`);
                return `${def.name}(${tag})`;
            }).filter(Boolean).join('、') || '无';
            const aliveTag = isAlive(u) ? '' : '[已倒下]';
            const desc = u.description ? `｜简介:${u.description}` : '';
            return `- ${u.name}${aliveTag} HP:${u.hp}/${u.maxHp} MP:${u.mp}/${u.maxMp} 攻:${eff.atk} 防:${eff.def} ${gAName}:${u.gauges?.gauge_a ?? 0}/100 ${gBName}:${u.gauges?.gauge_b ?? 0}/100｜状态:${stText}${desc}`;
        };

        const battleLines = [
            `[TRPG 实时战况 · 第 ${battleState.turn} 回合]`,
            '我方：',
            ...(battleState.allies || []).map(formatUnitLine),
            '敌方：',
            ...(battleState.enemies || []).map(formatUnitLine),
        ];
        blocks.push(battleLines.join('\n'));
    }

    // 块 3：极简世界观图鉴目录（ID + 名称 + 一句话简述，供 AI 剧情里按 ID 精准刷怪、增援、发技能/装备/道具）
    if (config.general.syncCatalogToAi) {
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
            const { matched, matchedUnits } = evaluateRule(battleState, rule);
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
