/**
 * 阈值触发与 Prompt 自动注入模块 (src/prompt_injector.js)
 * 职责：
 * 1. 实时扫描配置中的所有触发规则（支持 4v4 范围：任意我方/全体我方/任意敌方/全体敌方/指定角色）
 * 2. 条件满足时，自动调用酒馆原生 setExtensionPrompt 接口注入用户预设的引导提示词
 * 3. 条件解除、规则关闭或战斗重置时，自动撤回对应的注入文本，绝不残留污染对话
 * 4. 支持在提示词中写占位符（如 {{unit_name}}、{{gauge_a_name}}、{{turn}}）自动替换
 */

import { EXTENSION_KEY, getSTContext } from './config.js';
import { getAllUnits } from './engine.js';

/** 记录当前已经向酒馆注入过的 Prompt Key，用于条件解除时精确撤回 */
const activeInjectedKeys = new Set();

/**
 * 数值比较辅助函数
 * @param {number} actual
 * @param {string} operator
 * @param {number} threshold
 * @returns {boolean}
 */
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

/**
 * 检查单个角色是否满足规则条件
 * @param {object} unit
 * @param {object} rule
 * @returns {boolean}
 */
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
 * 评估规则在整个 4v4 战场中是否成立，并返回触发该规则的角色列表
 * @param {object} battleState
 * @param {object} rule
 * @returns {{ matched: boolean, matchedUnits: Array<object> }}
 */
function evaluateRule(battleState, rule) {
    if (!battleState || !battleState.active || !rule.enabled || !rule.promptText?.trim()) {
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

/**
 * 替换提示词中的动态占位符
 * 支持：{{unit_name}} {{hp}} {{max_hp}} {{mp}} {{max_mp}} {{gauge_a}} {{gauge_b}} {{gauge_a_name}} {{gauge_b_name}} {{turn}}
 * @param {string} template
 * @param {Array<object>} matchedUnits
 * @param {object} battleState
 * @param {object} config
 * @returns {string}
 */
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

/**
 * 映射规则中的位置/角色字符串到 SillyTavern 原生枚举值
 * @param {object} ctx
 * @param {object} rule
 * @returns {{ position: number, depth: number, role: number }}
 */
function mapPromptOptions(ctx, rule) {
    const types = ctx.extension_prompt_types || {
        IN_PROMPT: 0,
        IN_CHAT: 1,
        BEFORE_PROMPT: 2,
    };
    const roles = ctx.extension_prompt_roles || {
        SYSTEM: 0,
        USER: 1,
        ASSISTANT: 2,
    };

    let position = types.IN_CHAT ?? 1;
    if (rule.position === 'in_prompt') position = types.IN_PROMPT ?? 0;
    if (rule.position === 'before_prompt') position = types.BEFORE_PROMPT ?? 2;

    let role = roles.SYSTEM ?? 0;
    if (rule.role === 'user') role = roles.USER ?? 1;
    if (rule.role === 'assistant') role = roles.ASSISTANT ?? 2;

    const depth = Math.max(0, Math.round(Number(rule.depth ?? 1) || 0));
    return { position, depth, role };
}

/**
 * 安全调用 SillyTavern 的 setExtensionPrompt
 * @param {string} key
 * @param {string} value
 * @param {number} position
 * @param {number} depth
 * @param {number} role
 */
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

/**
 * 撤回所有由本插件注入的提示词
 */
export function clearAllInjectedPrompts() {
    for (const key of activeInjectedKeys) {
        callSetExtensionPrompt(key, '', 1, 1, 0);
    }
    activeInjectedKeys.clear();
}

/**
 * 核心同步函数：根据当前战斗状态，自动注入满足条件的规则并撤回不再满足的规则
 * @param {object|null} battleState
 * @param {object} config
 * @returns {Array<{ id: string, name: string, renderedText: string, matchedUnitNames: string[] }>} 当前生效的规则列表
 */
export function syncThresholdPrompts(battleState, config) {
    // 插件关闭或未处于激活战斗时，清空所有注入
    if (!config?.general?.enabled || !battleState || !battleState.active) {
        clearAllInjectedPrompts();
        return [];
    }

    const ctx = getSTContext();
    const nextKeys = new Set();
    const activeRulesInfo = [];

    for (const rule of config.triggerRules || []) {
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

    // 自动撤回上次生效、但本次条件已解除或规则被删除的注入
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
