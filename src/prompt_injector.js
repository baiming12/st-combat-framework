/**
 * 阈值触发引擎：Prompt 自动注入 + 自动挂载/移除 Buff (src/prompt_injector.js) - v1.1
 * 职责：
 * 1. 实时监测所有启用的阈值规则（HP、HP%、MP、状态槽A/B 满或空、持有指定状态）
 * 2. v1.1 新增「阈值触发自动挂载 Buff」：
 *    - while_condition：条件满足期间自动保持该 Buff，条件解除立即移除
 *    - on_enter：每次刚满足条件时挂载一次（按 Buff 持续回合倒计时），可选触发后将状态槽清零
 * 3. 条件满足时自动调用 setExtensionPrompt 注入预设剧情引导词，解除后自动撤回
 */

import { EXTENSION_KEY, getSTContext } from './config.js';
import { appendBattleLog, findStatusDefById, getAllUnits, isAlive } from './engine.js';

/** 记录当前已经向酒馆注入过的 Prompt Key，用于条件解除时精确撤回 */
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
        case 'hp':
            return compareValue(unit.hp, rule.operator, rule.threshold);
        case 'hp_percent': {
            const pct = unit.maxHp > 0 ? (unit.hp / unit.maxHp) * 100 : 0;
            return compareValue(pct, rule.operator, rule.threshold);
        }
        case 'mp':
            return compareValue(unit.mp, rule.operator, rule.threshold);
        case 'gauge_a':
            return compareValue(unit.gauges?.gauge_a ?? 0, rule.operator, rule.threshold);
        case 'gauge_b':
            return compareValue(unit.gauges?.gauge_b ?? 0, rule.operator, rule.threshold);
        case 'has_status':
            return Boolean(rule.statusId) && (unit.statuses || []).some(s => s.statusId === rule.statusId);
        default:
            return false;
    }
}

/**
 * 评估规则在整个 4v4 战场中是否成立
 * @param {object} battleState
 * @param {object} rule
 * @returns {{ matched: boolean, matchedUnits: Array<object> }}
 */
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
}

/**
 * 第一阶段：同步所有规则的「阈值自动挂载/移除 Buff」逻辑
 * @param {object} battleState
 * @param {object} config
 */
function syncThresholdBuffs(battleState, config) {
    if (!Array.isArray(battleState.triggeredRuleUnits)) {
        battleState.triggeredRuleUnits = [];
    }
    const prevEnteredSet = new Set(battleState.triggeredRuleUnits);
    const nextEnteredSet = new Set();
    const allUnits = getAllUnits(battleState);

    // 记录 while_condition 模式下本轮应该保留的 (unitId -> Set<"ruleId::statusId">)
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
                // 达标瞬间触发一次：挂载按持续回合倒计时的普通状态，可选触发后自动清零对应状态槽
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
                        // 未重置状态槽时记住已触发，防止重复触发
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
                // while_condition：条件维持期间自动持有该 Buff，条件解除后自动移除
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

    // 移除不再满足 while_condition 的阈值 Buff
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
 * 核心同步函数：先执行阈值 Buff 挂载/移除，再执行 Prompt 自动注入与撤回
 * @param {object|null} battleState
 * @param {object} config
 * @returns {Array<{ id: string, name: string, renderedText: string, matchedUnitNames: string[] }>}
 */
export function syncThresholdPrompts(battleState, config) {
    if (!config?.general?.enabled || !battleState || !battleState.active) {
        clearAllInjectedPrompts();
        return [];
    }

    // 1. 阈值触发自动挂载 / 解除 Buff
    syncThresholdBuffs(battleState, config);

    // 2. 阈值触发自动注入 / 撤回 Prompt
    const ctx = getSTContext();
    const nextKeys = new Set();
    const activeRulesInfo = [];

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
                activeRulesInfo.push({
                    id: rule.id,
                    name: rule.name,
                    renderedText,
                    matchedUnitNames: matchedUnits.map(u => u.name),
                });
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

    return activeRulesInfo;
}
