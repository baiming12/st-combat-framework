/**
 * 通用回合制战斗核心引擎 (src/engine.js) - v1.1
 * 职责：
 * 1. 纯逻辑计算，严禁硬编码任何技能名、状态名、角色名、装备名或剧情文本
 * 2. 支持 1v1 ~ 4v4 回合制状态机：我方行动 -> 敌方行动 -> 回合结束结算
 * 3. 支持 4 类通用 Buff/Debuff 机制：每回合持续增减 HP/特殊槽、跳过回合、攻防倍率、倒计时自动移除
 * 4. v1.1 新增：装备系统（属性加成、附带技能、穿戴常驻 Buff）、战斗消耗品道具系统（含净化效果）
 * 5. 内置无 eval 的安全公式解析器，兼容 TauriTavern 严格 CSP 环境
 */

import { MAX_UNITS_PER_SIDE, clamp } from './config.js';

/**
 * =========================================================================
 * 一、安全数学公式解析器（无 eval / new Function，彻底规避 CSP 限制）
 * =========================================================================
 */

function tokenizeFormula(expr) {
    const tokens = [];
    let i = 0;
    const str = String(expr || '0');
    while (i < str.length) {
        const ch = str[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (/[0-9.]/.test(ch)) {
            let num = '';
            while (i < str.length && /[0-9.]/.test(str[i])) {
                num += str[i++];
            }
            tokens.push({ type: 'number', value: num });
            continue;
        }
        if (/[a-zA-Z_]/.test(ch)) {
            let id = '';
            while (i < str.length && /[a-zA-Z0-9_]/.test(str[i])) {
                id += str[i++];
            }
            tokens.push({ type: 'ident', value: id.toLowerCase() });
            continue;
        }
        if ('+-*/(),'.includes(ch)) {
            tokens.push({ type: 'op', value: ch });
            i++;
            continue;
        }
        i++;
    }
    return tokens;
}

export function evaluateFormula(formula, vars = {}) {
    const tokens = tokenizeFormula(formula);
    if (tokens.length === 0) return 0;

    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    function parseExpression() {
        let left = parseTerm();
        while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
            const op = consume().value;
            const right = parseTerm();
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }

    function parseTerm() {
        let left = parseUnary();
        while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
            const op = consume().value;
            const right = parseUnary();
            left = op === '*' ? left * right : (right === 0 ? 0 : left / right);
        }
        return left;
    }

    function parseUnary() {
        if (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
            const op = consume().value;
            const val = parseUnary();
            return op === '-' ? -val : val;
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const tok = peek();
        if (!tok) return 0;

        if (tok.type === 'number') {
            consume();
            const n = Number(tok.value);
            return Number.isFinite(n) ? n : 0;
        }

        if (tok.type === 'ident') {
            consume();
            const name = tok.value;
            if (peek() && peek().type === 'op' && peek().value === '(') {
                consume();
                const args = [];
                if (!(peek() && peek().type === 'op' && peek().value === ')')) {
                    args.push(parseExpression());
                    while (peek() && peek().type === 'op' && peek().value === ',') {
                        consume();
                        args.push(parseExpression());
                    }
                }
                if (peek() && peek().type === 'op' && peek().value === ')') {
                    consume();
                }
                return evalFormulaFunc(name, args);
            }
            const val = vars[name];
            return Number.isFinite(Number(val)) ? Number(val) : 0;
        }

        if (tok.type === 'op' && tok.value === '(') {
            consume();
            const val = parseExpression();
            if (peek() && peek().type === 'op' && peek().value === ')') {
                consume();
            }
            return val;
        }

        consume();
        return 0;
    }

    try {
        const result = parseExpression();
        return Number.isFinite(result) ? Math.round(result) : 0;
    } catch {
        return 0;
    }
}

function evalFormulaFunc(name, args) {
    switch (name) {
        case 'max': return args.length ? Math.max(...args) : 0;
        case 'min': return args.length ? Math.min(...args) : 0;
        case 'floor': return Math.floor(args[0] ?? 0);
        case 'ceil': return Math.ceil(args[0] ?? 0);
        case 'round': return Math.round(args[0] ?? 0);
        case 'abs': return Math.abs(args[0] ?? 0);
        case 'rand': {
            const min = args[0] ?? 0;
            const max = args[1] ?? 1;
            return min + Math.random() * (max - min);
        }
        default: return 0;
    }
}

/**
 * =========================================================================
 * 二、辅助查询与装备加成结算
 * =========================================================================
 */

export function getAllUnits(state) {
    if (!state) return [];
    return [...(state.allies || []), ...(state.enemies || [])];
}

export function findUnitById(state, unitId) {
    return getAllUnits(state).find(u => u.id === unitId);
}

export function findSkillById(config, skillId) {
    return (config?.skills || []).find(s => s.id === skillId);
}

export function findStatusDefById(config, statusId) {
    return (config?.statuses || []).find(s => s.id === statusId);
}

export function findEquipmentById(config, equipId) {
    return (config?.equipments || []).find(e => e.id === equipId);
}

export function findItemById(config, itemId) {
    return (config?.items || []).find(it => it.id === itemId);
}

export function findClassById(config, classId) {
    if (!classId) return null;
    return (config?.classTrees || []).find(c => c.id === classId) || null;
}

/**
 * 获取职业的继承链 [1阶父职业, ..., 当前职业]（带防环保护）
 * @param {object} config
 * @param {string} classId
 * @returns {Array<object>}
 */
export function getClassLineage(config, classId) {
    const chain = [];
    const visited = new Set();
    let cur = findClassById(config, classId);
    while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        chain.unshift(cur);
        cur = cur.parentClassId ? findClassById(config, cur.parentClassId) : null;
    }
    return chain;
}

/**
 * 判断某个职业所属世界观当前是否已开启
 */
export function isWorldviewEnabled(config, worldview) {
    const enabled = config?.progression?.enabledWorldviews;
    if (!Array.isArray(enabled) || enabled.length === 0) return true;
    return enabled.includes(worldview);
}

/**
 * 计算单位的自由属性加点 + 当前职业被动加成 + 职业按等级解锁的技能列表
 */
export function getUnitProgressionBonuses(unit, config) {
    const empty = {
        bonusHp: 0,
        bonusMp: 0,
        bonusAtk: 0,
        bonusSpi: 0,
        bonusDef: 0,
        bonusMdef: 0,
        unlockedSkills: [],
        className: '',
    };
    if (!unit || !config?.progression?.enabled) return empty;

    const gains = config.progression.statGains || {
        vitHp: 15, strAtk: 2, spiMag: 2, spiMp: 8, defPhys: 2, mdefMag: 2,
    };
    const alloc = unit.allocated || {};
    const vit = Math.max(0, Number(alloc.vit) || 0);
    const str = Math.max(0, Number(alloc.str) || 0);
    const spi = Math.max(0, Number(alloc.spi) || 0);
    const def = Math.max(0, Number(alloc.def) || 0);
    const mdef = Math.max(0, Number(alloc.mdef) || 0);

    let bonusHp = vit * (gains.vitHp || 15);
    let bonusMp = spi * (gains.spiMp || 8);
    let bonusAtk = str * (gains.strAtk || 2);
    let bonusSpi = spi * (gains.spiMag || 2);
    let bonusDef = def * (gains.defPhys || 2);
    let bonusMdef = mdef * (gains.mdefMag || 2);

    const unlockedSkills = [];
    const level = Math.max(1, Number(unit.level) || 1);
    const curClass = findClassById(config, unit.classId);
    let className = '';

    if (curClass && isWorldviewEnabled(config, curClass.worldview)) {
        className = curClass.name;
        // 职业被动取当前职业节点本身的属性加成
        bonusHp += Number(curClass.bonusHp || 0);
        bonusMp += Number(curClass.bonusMp || 0);
        bonusAtk += Number(curClass.bonusAtk || 0);
        bonusSpi += Number(curClass.bonusSpi || 0);
        bonusDef += Number(curClass.bonusDef || 0);
        bonusMdef += Number(curClass.bonusMdef || 0);

        // 进阶职业自动继承父职业链上已达等级解锁的技能
        const lineage = getClassLineage(config, curClass.id);
        for (const clsNode of lineage) {
            for (const entry of clsNode.unlockSkills || []) {
                if (level >= (Number(entry.level) || 1) && entry.skillId) {
                    unlockedSkills.push({ skillId: entry.skillId, className: clsNode.name });
                }
            }
        }
    }

    return { bonusHp, bonusMp, bonusAtk, bonusSpi, bonusDef, bonusMdef, unlockedSkills, className };
}

export function isAlive(unit) {
    return Boolean(unit && unit.hp > 0);
}

/**
 * 计算单位当前穿戴装备带来的总属性加成、附带技能与常驻 Buff
 * @param {object} unit
 * @param {object} config
 */
export function getUnitEquipmentBonuses(unit, config) {
    let bonusHp = 0;
    let bonusMp = 0;
    let bonusAtk = 0;
    let bonusSpi = 0;
    let bonusDef = 0;
    let bonusMdef = 0;
    const grantedSkills = [];
    const passiveStatuses = [];

    for (const eqId of unit.equipmentIds || []) {
        const eq = findEquipmentById(config, eqId);
        if (!eq) continue;
        bonusHp += Number(eq.bonusHp || 0);
        bonusMp += Number(eq.bonusMp || 0);
        bonusAtk += Number(eq.bonusAtk || 0);
        bonusSpi += Number(eq.bonusSpi || 0);
        bonusDef += Number(eq.bonusDef || 0);
        bonusMdef += Number(eq.bonusMdef || 0);
        if (eq.grantSkillId) {
            grantedSkills.push({ skillId: eq.grantSkillId, equipName: eq.name });
        }
        if (eq.passiveStatusId) {
            passiveStatuses.push({ statusId: eq.passiveStatusId, equipId: eq.id, equipName: eq.name });
        }
    }

    return { bonusHp, bonusMp, bonusAtk, bonusSpi, bonusDef, bonusMdef, grantedSkills, passiveStatuses };
}

/**
 * 同步单位因装备、自由加点与职业变化引起的上限变化与常驻 Buff 挂载/移除
 */
export function syncUnitEquipmentEffects(unit, config, fillNewMax = false) {
    if (!unit) return;
    if (!Number.isFinite(unit.baseMaxHp)) unit.baseMaxHp = unit.maxHp;
    if (!Number.isFinite(unit.baseMaxMp)) unit.baseMaxMp = unit.maxMp;
    if (!Number.isFinite(unit.baseSpi)) unit.baseSpi = 15;
    if (!Number.isFinite(unit.baseMdef)) unit.baseMdef = 5;
    if (!Number.isFinite(unit.level)) unit.level = 1;
    if (!unit.allocated || typeof unit.allocated !== 'object') {
        unit.allocated = { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 };
    }
    if (!Array.isArray(unit.equipmentIds)) unit.equipmentIds = [];
    if (!Array.isArray(unit.statuses)) unit.statuses = [];

    const eqBonus = getUnitEquipmentBonuses(unit, config);
    const progBonus = getUnitProgressionBonuses(unit, config);
    const prevMaxHp = unit.maxHp;
    const prevMaxMp = unit.maxMp;

    unit.maxHp = Math.max(1, unit.baseMaxHp + eqBonus.bonusHp + progBonus.bonusHp);
    unit.maxMp = Math.max(0, unit.baseMaxMp + eqBonus.bonusMp + progBonus.bonusMp);

    if (fillNewMax) {
        unit.hp = unit.maxHp;
        unit.mp = unit.maxMp;
    } else {
        if (isAlive(unit) && unit.maxHp > prevMaxHp) {
            unit.hp = Math.min(unit.maxHp, unit.hp + (unit.maxHp - prevMaxHp));
        } else {
            unit.hp = clamp(unit.hp, 0, unit.maxHp);
        }
        if (unit.maxMp > prevMaxMp) {
            unit.mp = Math.min(unit.maxMp, unit.mp + (unit.maxMp - prevMaxMp));
        } else {
            unit.mp = clamp(unit.mp, 0, unit.maxMp);
        }
    }

    const desiredKeys = new Set(eqBonus.passiveStatuses.map(p => `${p.equipId}::${p.statusId}`));
    unit.statuses = unit.statuses.filter(st => {
        if (st.source !== 'equipment') return true;
        return desiredKeys.has(`${st.sourceEquipId}::${st.statusId}`);
    });
    for (const ps of eqBonus.passiveStatuses) {
        const def = findStatusDefById(config, ps.statusId);
        if (!def) continue;
        const exists = unit.statuses.some(
            st => st.source === 'equipment' && st.sourceEquipId === ps.equipId && st.statusId === ps.statusId
        );
        if (!exists) {
            unit.statuses.push({
                statusId: def.id,
                remainingTurns: 99,
                source: 'equipment',
                sourceEquipId: ps.equipId,
                sourceLabel: ps.equipName,
            });
        }
    }
}

export function syncAllUnitsEquipment(state, config) {
    if (!state || !state.active) return;
    for (const unit of getAllUnits(state)) {
        syncUnitEquipmentEffects(unit, config, false);
    }
}

/**
 * 获取单位当前可用的完整技能列表（通用/自身技能 + 职业按等级解锁技能 + 装备附带技能）
 */
export function getUnitAvailableSkills(unit, config) {
    if (!unit) return [];
    const result = [];
    const seen = new Set();

    // 1. 职业树按等级解锁的技能（优先展示）
    const progBonus = getUnitProgressionBonuses(unit, config);
    for (const cs of progBonus.unlockedSkills) {
        if (seen.has(cs.skillId)) continue;
        const sk = findSkillById(config, cs.skillId);
        if (sk) {
            seen.add(cs.skillId);
            result.push({ skill: sk, fromEquipmentName: '', fromClassName: cs.className });
        }
    }

    // 2. 角色手动挂载的技能（通用技能池 / 剧情领悟技能）
    const baseSkillIds = (unit.skillIds && unit.skillIds.length > 0)
        ? unit.skillIds
        : (result.length === 0 && unit.side === 'ally' ? (config.skills || []).filter(s => s.poolType === 'universal').map(s => s.id) : []);

    for (const id of baseSkillIds) {
        if (seen.has(id)) continue;
        const sk = findSkillById(config, id);
        if (sk) {
            seen.add(id);
            result.push({ skill: sk, fromEquipmentName: '', fromClassName: '' });
        }
    }

    // 3. 穿戴装备附带解锁的技能
    const eqBonus = getUnitEquipmentBonuses(unit, config);
    for (const gs of eqBonus.grantedSkills) {
        if (seen.has(gs.skillId)) continue;
        const sk = findSkillById(config, gs.skillId);
        if (sk) {
            seen.add(gs.skillId);
            result.push({ skill: sk, fromEquipmentName: gs.equipName, fromClassName: '' });
        }
    }

    return result;
}

/**
 * 计算单位叠加加点、职业、装备与全部 Buff/Debuff 后的实时物攻/精神法攻/物防/法抗
 */
export function getEffectiveStats(unit, config) {
    const eqBonus = getUnitEquipmentBonuses(unit, config);
    const progBonus = getUnitProgressionBonuses(unit, config);
    let atkMultiplier = 1;
    let spiMultiplier = 1;
    let defMultiplier = 1;
    let mdefMultiplier = 1;
    let isStunned = false;

    for (const activeSt of unit.statuses || []) {
        const def = findStatusDefById(config, activeSt.statusId);
        if (!def) continue;
        if (def.skipTurn || def.effectType === 'skip_turn') {
            isStunned = true;
        }
        if (Number.isFinite(def.atkMultiplier) && def.atkMultiplier > 0 && def.atkMultiplier !== 1) atkMultiplier *= def.atkMultiplier;
        if (Number.isFinite(def.spiMultiplier) && def.spiMultiplier > 0 && def.spiMultiplier !== 1) spiMultiplier *= def.spiMultiplier;
        if (Number.isFinite(def.defMultiplier) && def.defMultiplier > 0 && def.defMultiplier !== 1) defMultiplier *= def.defMultiplier;
        if (Number.isFinite(def.mdefMultiplier) && def.mdefMultiplier > 0 && def.mdefMultiplier !== 1) mdefMultiplier *= def.mdefMultiplier;
    }

    const totalBaseAtk = Math.max(0, (unit.baseAtk || 0) + eqBonus.bonusAtk + progBonus.bonusAtk);
    const totalBaseSpi = Math.max(0, (unit.baseSpi ?? unit.spi ?? 15) + eqBonus.bonusSpi + progBonus.bonusSpi);
    const totalBaseDef = Math.max(0, (unit.baseDef || 0) + eqBonus.bonusDef + progBonus.bonusDef);
    const totalBaseMdef = Math.max(0, (unit.baseMdef ?? unit.mdef ?? 5) + eqBonus.bonusMdef + progBonus.bonusMdef);

    return {
        atk: Math.max(0, Math.round(totalBaseAtk * atkMultiplier)),
        spi: Math.max(0, Math.round(totalBaseSpi * spiMultiplier)),
        def: Math.max(0, Math.round(totalBaseDef * defMultiplier)),
        mdef: Math.max(0, Math.round(totalBaseMdef * mdefMultiplier)),
        atkMultiplier: Number(atkMultiplier.toFixed(2)),
        spiMultiplier: Number(spiMultiplier.toFixed(2)),
        defMultiplier: Number(defMultiplier.toFixed(2)),
        mdefMultiplier: Number(mdefMultiplier.toFixed(2)),
        isStunned,
    };
}

/**
 * 追加一条战报日志
 */
export function appendBattleLog(state, line) {
    if (!state || !line) return;
    if (!Array.isArray(state.currentRoundLogs)) state.currentRoundLogs = [];
    if (!Array.isArray(state.allLogs)) state.allLogs = [];
    state.currentRoundLogs.push(line);
    state.allLogs.push(`[T${state.turn}] ${line}`);
    if (state.allLogs.length > 100) {
        state.allLogs = state.allLogs.slice(-100);
    }
}

/**
 * =========================================================================
 * 三、战斗初始化
 * =========================================================================
 */

function instantiateUnit(tpl, side, config) {
    const rawAlloc = tpl.allocated && typeof tpl.allocated === 'object' ? tpl.allocated : {};
    const unit = {
        id: tpl.id,
        side,
        name: tpl.name,
        description: String(tpl.description || ''),
        level: Math.max(1, Math.round(Number(tpl.level ?? 1) || 1)),
        classId: String(tpl.classId || ''),
        freePoints: Math.max(0, Math.round(Number(tpl.freePoints ?? 0) || 0)),
        allocated: {
            vit: Math.max(0, Math.round(Number(rawAlloc.vit ?? 0) || 0)),
            str: Math.max(0, Math.round(Number(rawAlloc.str ?? 0) || 0)),
            spi: Math.max(0, Math.round(Number(rawAlloc.spi ?? 0) || 0)),
            def: Math.max(0, Math.round(Number(rawAlloc.def ?? 0) || 0)),
            mdef: Math.max(0, Math.round(Number(rawAlloc.mdef ?? 0) || 0)),
        },
        baseMaxHp: tpl.maxHp,
        maxHp: tpl.maxHp,
        hp: tpl.maxHp,
        baseMaxMp: tpl.maxMp,
        maxMp: tpl.maxMp,
        mp: tpl.maxMp,
        baseAtk: tpl.atk,
        baseSpi: Number.isFinite(Number(tpl.spi)) ? Number(tpl.spi) : 15,
        baseDef: tpl.def,
        baseMdef: Number.isFinite(Number(tpl.mdef)) ? Number(tpl.mdef) : 5,
        gauges: {
            gauge_a: clamp(tpl.initialGaugeA ?? 0, 0, 100),
            gauge_b: clamp(tpl.initialGaugeB ?? 0, 0, 100),
        },
        skillIds: Array.isArray(tpl.skillIds) ? [...tpl.skillIds] : [],
        equipmentIds: Array.isArray(tpl.equipmentIds) ? [...tpl.equipmentIds] : [],
        aiStrategy: ['priority', 'weighted', 'random'].includes(tpl.aiStrategy) ? tpl.aiStrategy : 'priority',
        autoControl: side === 'ally' ? Boolean(tpl.autoControl) : false,
        statuses: [],
        hasActed: false,
    };
    syncUnitEquipmentEffects(unit, config, true);
    return unit;
}

/**
 * 修炼突破升级：提升角色等级并发放自由属性点（同时更新战斗实体与持久化模板）
 */
export function levelUpUnit(state, config, unitId, deltaLevels = 1) {
    const delta = Math.max(1, Math.round(Number(deltaLevels) || 1));
    const tpl = (config.allies || []).find(a => a.id === unitId);
    if (!tpl) return { ok: false, message: '未找到我方角色。' };

    const ptsPerLv = Math.max(0, Math.round(Number(config?.progression?.pointsPerLevel ?? 3) || 0));
    const prevLevel = Math.max(1, Number(tpl.level) || 1);
    const nextLevel = prevLevel + delta;
    const gainedPts = delta * ptsPerLv;

    tpl.level = nextLevel;
    tpl.freePoints = (Number(tpl.freePoints) || 0) + gainedPts;

    const live = state?.active ? (state.allies || []).find(u => u.id === tpl.id) : null;
    if (live) {
        live.level = tpl.level;
        live.freePoints = tpl.freePoints;
        syncUnitEquipmentEffects(live, config, false);
        appendBattleLog(state, `⬆️ ${live.name} 修炼突破至 Lv.${nextLevel}，获得 ${gainedPts} 点自由属性点！`);
    }
    return { ok: true, level: nextLevel, gainedPts };
}

/**
 * 分配 1 点自由属性点到 5 项基础属性之一 (vit / str / spi / def / mdef)
 */
export function allocateStatPoint(state, config, unitId, statKey) {
    if (!['vit', 'str', 'spi', 'def', 'mdef'].includes(statKey)) {
        return { ok: false, message: '未知属性项。' };
    }
    const tpl = (config.allies || []).find(a => a.id === unitId);
    if (!tpl) return { ok: false, message: '未找到角色。' };
    if ((Number(tpl.freePoints) || 0) <= 0) {
        return { ok: false, message: '没有剩余的自由属性点。' };
    }
    if (!tpl.allocated) tpl.allocated = { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 };

    tpl.freePoints -= 1;
    tpl.allocated[statKey] = (Number(tpl.allocated[statKey]) || 0) + 1;

    const live = state?.active ? (state.allies || []).find(u => u.id === tpl.id) : null;
    if (live) {
        live.freePoints = tpl.freePoints;
        live.allocated = { ...tpl.allocated };
        syncUnitEquipmentEffects(live, config, false);
    }
    return { ok: true };
}

/**
 * 一键洗点：将角色已分配的自由属性点全部返还
 */
export function resetUnitAllocatedPoints(state, config, unitId) {
    const tpl = (config.allies || []).find(a => a.id === unitId);
    if (!tpl) return { ok: false, message: '未找到角色。' };
    const alloc = tpl.allocated || { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 };
    const totalSpent = (alloc.vit || 0) + (alloc.str || 0) + (alloc.spi || 0) + (alloc.def || 0) + (alloc.mdef || 0);
    if (totalSpent === 0) return { ok: false, message: '当前尚未分配任何属性点。' };

    tpl.freePoints = (Number(tpl.freePoints) || 0) + totalSpent;
    tpl.allocated = { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 };

    const live = state?.active ? (state.allies || []).find(u => u.id === tpl.id) : null;
    if (live) {
        live.freePoints = tpl.freePoints;
        live.allocated = { ...tpl.allocated };
        syncUnitEquipmentEffects(live, config, false);
    }
    return { ok: true, refunded: totalSpent };
}

/**
 * 切换/转职角色职业（校验等级要求，进阶职业自动继承父职业技能）
 */
export function changeUnitClass(state, config, unitId, nextClassId) {
    const tpl = (config.allies || []).find(a => a.id === unitId);
    if (!tpl) return { ok: false, message: '未找到角色。' };

    if (!nextClassId) {
        tpl.classId = '';
    } else {
        const cls = findClassById(config, nextClassId);
        if (!cls) return { ok: false, message: '未找到目标职业。' };
        const lv = Math.max(1, Number(tpl.level) || 1);
        if (lv < (Number(cls.requiredLevel) || 1)) {
            return { ok: false, message: `转职「${cls.name}」需要达到 Lv.${cls.requiredLevel}（当前 Lv.${lv}）。` };
        }
        tpl.classId = cls.id;
    }

    const live = state?.active ? (state.allies || []).find(u => u.id === tpl.id) : null;
    if (live) {
        live.classId = tpl.classId;
        syncUnitEquipmentEffects(live, config, false);
        const clsName = findClassById(config, tpl.classId)?.name || '无职业';
        appendBattleLog(state, `🛡️ ${live.name} 职业变更为「${clsName}」！`);
    }
    return { ok: true };
}

/**
 * 战斗中动态塞入敌方增援单位（最多 4 名敌方；若已有同 ID 敌人则自动分配不冲突 ID）
 * @param {object} state
 * @param {object} config
 * @param {object} enemyTpl
 * @returns {{ ok: boolean, message?: string, unit?: object }}
 */
export function addEnemyToBattle(state, config, enemyTpl) {
    if (!state || !state.active) {
        return { ok: false, message: '当前未处于战斗中，请直接开启战斗。' };
    }
    if ((state.enemies || []).length >= MAX_UNITS_PER_SIDE) {
        return { ok: false, message: `敌方场上人数已达上限（最多 ${MAX_UNITS_PER_SIDE} 人）。` };
    }

    const usedIds = new Set(getAllUnits(state).map(u => u.id));
    let finalId = String(enemyTpl?.id || `enemy_reinf_${state.enemies.length + 1}`);
    let suffix = 2;
    while (usedIds.has(finalId)) {
        finalId = `${enemyTpl?.id || 'enemy_reinf'}_${suffix++}`;
    }

    const sameNameCount = state.enemies.filter(e => e.name === enemyTpl.name || e.name.startsWith(`${enemyTpl.name}#`)).length;
    const finalName = sameNameCount > 0 ? `${enemyTpl.name}#${sameNameCount + 1}` : enemyTpl.name;

    const newUnit = instantiateUnit({ ...enemyTpl, id: finalId, name: finalName }, 'enemy', config);
    state.enemies.push(newUnit);

    // 若原本已胜利，增援加入后恢复我方行动
    if (state.phase === 'victory' && state.allies.some(isAlive)) {
        state.phase = 'player_turn';
    }
    appendBattleLog(state, `⚠️ 敌方增援：${newUnit.name}（HP ${newUnit.maxHp}）加入了战斗！`);
    syncDefaultSelections(state);
    return { ok: true, unit: newUnit };
}

/**
 * 给角色学习/赋予一个技能（同时更新当前战斗中的单位与持久化配置模板）
 * @param {object|null} state
 * @param {object} config
 * @param {string} unitId
 * @param {string} skillId
 * @returns {{ ok: boolean, message?: string }}
 */
export function grantSkillToUnit(state, config, unitId, skillId) {
    const skill = findSkillById(config, skillId);
    if (!skill) return { ok: false, message: '未在技能库中找到该技能。' };

    const tpl = (config.allies || []).find(a => a.id === unitId) || config.allies?.[0];
    if (!tpl) return { ok: false, message: '未找到我方角色。' };

    if (!Array.isArray(tpl.skillIds)) tpl.skillIds = [];
    if (!tpl.skillIds.includes(skill.id)) {
        tpl.skillIds.push(skill.id);
    }

    if (state && state.active) {
        const liveUnit = (state.allies || []).find(u => u.id === tpl.id);
        if (liveUnit) {
            if (!Array.isArray(liveUnit.skillIds)) liveUnit.skillIds = [];
            if (!liveUnit.skillIds.includes(skill.id)) {
                liveUnit.skillIds.push(skill.id);
            }
            appendBattleLog(state, `✨ ${liveUnit.name} 领悟/习得了技能「${skill.name}」！`);
        }
    }
    return { ok: true };
}

/**
 * 根据配置创建全新的战斗状态（最多 4v4；支持传入 overrideEnemies 供 AI 剧情一键开战）
 * @param {object} config
 * @param {Array<object>|null} [overrideEnemies=null]
 */
export function createBattleState(config, overrideEnemies = null) {
    const enabledAllies = (config.allies || []).filter(u => u.enabled).slice(0, MAX_UNITS_PER_SIDE);
    const enabledEnemies = Array.isArray(overrideEnemies) && overrideEnemies.length > 0
        ? overrideEnemies.slice(0, MAX_UNITS_PER_SIDE)
        : (config.enemies || []).filter(u => u.enabled).slice(0, MAX_UNITS_PER_SIDE);

    const allyTemplates = enabledAllies.length > 0 ? enabledAllies : (config.allies || []).slice(0, 1);
    const enemyTemplates = enabledEnemies.length > 0 ? enabledEnemies : (config.enemies || []).slice(0, 1);

    const allies = allyTemplates.map(u => instantiateUnit(u, 'ally', config));
    const enemies = enemyTemplates.map(u => instantiateUnit(u, 'enemy', config));

    const state = {
        active: true,
        turn: 1,
        phase: 'player_turn',
        allies,
        enemies,
        selectedActorId: allies[0]?.id || '',
        selectedTargetId: enemies[0]?.id || '',
        triggeredRuleUnits: [], // 记录 on_enter 阈值规则已触发的 "ruleId::unitId"
        currentRoundLogs: [],
        allLogs: [],
    };

    appendBattleLog(state, `战斗开始！我方 ${allies.length} 人 vs 敌方 ${enemies.length} 人（第 1 回合）。`);
    preparePlayerTurn(state, config);
    return state;
}

/**
 * 修改单位某项特殊计量条，并返回变化描述
 */
function applyGaugeDelta(unit, gaugeKey, delta, config) {
    const num = Math.round(Number(delta) || 0);
    if (num === 0) return '';
    const before = unit.gauges[gaugeKey] ?? 0;
    const after = clamp(before + num, 0, 100);
    unit.gauges[gaugeKey] = after;
    const actualDelta = after - before;
    if (actualDelta === 0) return '';
    const gaugeName = config.gauges?.[gaugeKey]?.name || gaugeKey;
    const sign = actualDelta > 0 ? '+' : '';
    return `${gaugeName}${sign}${actualDelta}(${after}/100)`;
}

/**
 * 尝试给单位挂载普通状态（若已存在同名普通状态则刷新持续回合数）
 */
function tryApplyStatus(target, statusId, chance, config) {
    if (!statusId || !isAlive(target)) return '';
    const def = findStatusDefById(config, statusId);
    if (!def) return '';

    const roll = Math.random() * 100;
    if (roll > clamp(chance ?? 100, 0, 100)) {
        return '';
    }

    const existing = target.statuses.find(s => s.statusId === statusId && (!s.source || s.source === 'normal'));
    if (existing) {
        existing.remainingTurns = Math.max(existing.remainingTurns, def.duration);
        return `刷新状态「${def.name}」(${existing.remainingTurns}回合)`;
    }

    target.statuses.push({
        statusId: def.id,
        remainingTurns: def.duration,
        source: 'normal',
    });
    return `附加状态「${def.name}」(${def.duration}回合)`;
}

/**
 * =========================================================================
 * 四、技能 / 道具 / 装备操作与回合制状态机
 * =========================================================================
 */

function resolveTargets(state, actor, targetType, requestedTargetId) {
    const friends = actor.side === 'ally' ? state.allies : state.enemies;
    const foes = actor.side === 'ally' ? state.enemies : state.allies;
    const aliveFriends = friends.filter(isAlive);
    const aliveFoes = foes.filter(isAlive);

    switch (targetType) {
        case 'self':
            return isAlive(actor) ? [actor] : [];
        case 'all_allies':
            return aliveFriends;
        case 'all_enemies':
            return aliveFoes;
        case 'single_ally': {
            const chosen = aliveFriends.find(u => u.id === requestedTargetId);
            return chosen ? [chosen] : (aliveFriends[0] ? [aliveFriends[0]] : []);
        }
        case 'single_enemy':
        default: {
            const chosen = aliveFoes.find(u => u.id === requestedTargetId);
            return chosen ? [chosen] : (aliveFoes[0] ? [aliveFoes[0]] : []);
        }
    }
}

function buildFormulaVars(actor, target, config) {
    const actorEff = getEffectiveStats(actor, config);
    const targetEff = getEffectiveStats(target, config);
    return {
        atk: actorEff.atk,
        spi: actorEff.spi,
        def: actorEff.def,
        mdef: actorEff.mdef,
        level: Math.max(1, Number(actor.level) || 1),
        hp: actor.hp,
        max_hp: actor.maxHp,
        mp: actor.mp,
        max_mp: actor.maxMp,
        gauge_a: actor.gauges.gauge_a,
        gauge_b: actor.gauges.gauge_b,
        target_atk: targetEff.atk,
        target_spi: targetEff.spi,
        target_def: targetEff.def,
        target_mdef: targetEff.mdef,
        target_level: Math.max(1, Number(target.level) || 1),
        target_hp: target.hp,
        target_max_hp: target.maxHp,
        target_gauge_a: target.gauges.gauge_a,
        target_gauge_b: target.gauges.gauge_b,
    };
}

/**
 * 检查技能的前置状态条件：要求目标至少持有 requiredTargetStatusIds 中的任意 1 个状态
 * @param {object} state
 * @param {object} config
 * @param {object} actor
 * @param {object} skill
 * @param {string} targetId
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkSkillPrerequisite(state, config, actor, skill, targetId) {
    const reqIds = Array.isArray(skill?.requiredTargetStatusIds)
        ? skill.requiredTargetStatusIds.filter(Boolean)
        : [];
    if (reqIds.length === 0) return { ok: true };

    const targets = resolveTargets(state, actor, skill.targetType, targetId);
    if (targets.length === 0) {
        return { ok: false, reason: '没有可生效的存活目标。' };
    }

    const reqSet = new Set(reqIds);
    const hasMatch = targets.some(t => (t.statuses || []).some(st => reqSet.has(st.statusId)));
    if (hasMatch) return { ok: true };

    const names = reqIds
        .map(id => findStatusDefById(config, id)?.name || id)
        .join(' / ');
    return { ok: false, reason: `需要目标持有【${names}】之一才可释放` };
}

function performSkill(state, config, actor, skill, targetId) {
    const actionLogs = [];

    if (!isAlive(actor)) {
        return { ok: false, message: `${actor.name} 已失去战斗能力，无法行动。`, logs: actionLogs };
    }
    if (actor.mp < skill.mpCost) {
        return { ok: false, message: `${actor.name} 的 MP/体力不足（需要 ${skill.mpCost}，当前 ${actor.mp}）。`, logs: actionLogs };
    }

    const preCheck = checkSkillPrerequisite(state, config, actor, skill, targetId);
    if (!preCheck.ok) {
        return { ok: false, message: preCheck.reason, logs: actionLogs };
    }

    const targets = resolveTargets(state, actor, skill.targetType, targetId);
    if (targets.length === 0) {
        return { ok: false, message: '没有可生效的存活目标。', logs: actionLogs };
    }

    actor.mp = Math.max(0, actor.mp - skill.mpCost);
    actor.hasActed = true;

    const selfNotes = [];
    const selfGA = applyGaugeDelta(actor, 'gauge_a', skill.selfGaugeAChange, config);
    const selfGB = applyGaugeDelta(actor, 'gauge_b', skill.selfGaugeBChange, config);
    if (selfGA) selfNotes.push(selfGA);
    if (selfGB) selfNotes.push(selfGB);

    if (skill.applyStatusId && skill.applyStatusTarget === 'self') {
        const stText = tryApplyStatus(actor, skill.applyStatusId, skill.applyStatusChance, config);
        if (stText) selfNotes.push(stText);
    }

    const targetSummaries = [];

    for (const target of targets) {
        const vars = buildFormulaVars(actor, target, config);
        const amount = Math.max(0, evaluateFormula(skill.formula, vars));
        const notes = [];

        if (skill.effectType === 'damage') {
            target.hp = Math.max(0, target.hp - amount);
            notes.push(`造成 ${amount} 点伤害（剩余 HP ${target.hp}/${target.maxHp}）`);
            if (target.hp <= 0) notes.push('倒下');
        } else if (skill.effectType === 'heal') {
            const before = target.hp;
            target.hp = Math.min(target.maxHp, target.hp + amount);
            notes.push(`回复 ${target.hp - before} 点 HP（当前 HP ${target.hp}/${target.maxHp}）`);
        } else if (skill.effectType === 'mp_restore') {
            const before = target.mp;
            target.mp = Math.min(target.maxMp, target.mp + amount);
            notes.push(`回复 ${target.mp - before} 点 MP/体力（当前 ${target.mp}/${target.maxMp}）`);
        }

        const tGA = applyGaugeDelta(target, 'gauge_a', skill.targetGaugeAChange, config);
        const tGB = applyGaugeDelta(target, 'gauge_b', skill.targetGaugeBChange, config);
        if (tGA) notes.push(tGA);
        if (tGB) notes.push(tGB);

        if (skill.applyStatusId && skill.applyStatusTarget !== 'self') {
            const stText = tryApplyStatus(target, skill.applyStatusId, skill.applyStatusChance, config);
            if (stText) notes.push(stText);
        }

        targetSummaries.push(`对 ${target.name} ${notes.length ? notes.join('，') : '生效'}`);
    }

    const mpNote = skill.mpCost > 0 ? `（消耗 ${skill.mpCost} MP）` : '';
    const selfSuffix = selfNotes.length ? `；自身：${selfNotes.join('，')}` : '';
    const line = `${actor.name} 使用了「${skill.name}」${mpNote}：${targetSummaries.join('；')}${selfSuffix}。`;

    appendBattleLog(state, line);
    actionLogs.push(line);

    return { ok: true, logs: actionLogs };
}

export function checkBattleOutcome(state) {
    const anyAllyAlive = state.allies.some(isAlive);
    const anyEnemyAlive = state.enemies.some(isAlive);

    if (!anyEnemyAlive && anyAllyAlive) {
        state.phase = 'victory';
        appendBattleLog(state, '敌方全员失去战斗能力，我方取得胜利！');
        return true;
    }
    if (!anyAllyAlive) {
        state.phase = 'defeat';
        appendBattleLog(state, '我方全员生命值归零，战斗失败！');
        return true;
    }
    return false;
}

export function syncDefaultSelections(state) {
    // 优先选中存活且尚未行动的手动操作角色，其次托管角色
    const readyManualAlly = state.allies.find(u => isAlive(u) && !u.hasActed && !u.autoControl);
    const readyAlly = readyManualAlly
        || state.allies.find(u => isAlive(u) && !u.hasActed)
        || state.allies.find(isAlive)
        || state.allies[0];
    const currentActor = findUnitById(state, state.selectedActorId);
    if (!currentActor || currentActor.side !== 'ally' || !isAlive(currentActor) || currentActor.hasActed) {
        state.selectedActorId = readyAlly?.id || '';
    }

    const currentTarget = findUnitById(state, state.selectedTargetId);
    if (!currentTarget || !isAlive(currentTarget)) {
        const firstAliveEnemy = state.enemies.find(isAlive) || state.enemies[0];
        state.selectedTargetId = firstAliveEnemy?.id || '';
    }
}

function preparePlayerTurn(state, config) {
    state.phase = 'player_turn';
    for (const ally of state.allies) {
        if (!isAlive(ally)) {
            ally.hasActed = true;
            continue;
        }
        const eff = getEffectiveStats(ally, config);
        if (eff.isStunned) {
            ally.hasActed = true;
            appendBattleLog(state, `${ally.name} 处于行动受限状态，跳过本回合行动！`);
        } else {
            ally.hasActed = false;
        }
    }
    syncDefaultSelections(state);
}

/**
 * 通用 AI 选招引擎（敌方单位与开启“自动托管”的我方队友共用）
 * 支持：
 * 1. 校验 MP 消耗、技能前置状态条件 (requiredTargetStatusIds) 与血量阈值 (aiHpBelowPercent，防满血空奶)
 * 2. 支持三种策略：priority(高优先级优先) / weighted(按优先级权重随机) / random(完全随机)
 * @param {object} state
 * @param {object} config
 * @param {object} actor
 * @returns {{ skill: object, targetId: string } | null}
 */
export function pickAiSkillAndTarget(state, config, actor) {
    const friends = actor.side === 'ally' ? state.allies : state.enemies;
    const foes = actor.side === 'ally' ? state.enemies : state.allies;
    const actorHpPct = actor.maxHp > 0 ? (actor.hp / actor.maxHp) * 100 : 100;

    const pickTargetForSkill = (sk) => {
        const reqIds = Array.isArray(sk.requiredTargetStatusIds) ? sk.requiredTargetStatusIds.filter(Boolean) : [];
        const reqSet = new Set(reqIds);
        const hasReq = (u) => reqSet.size === 0 || (u.statuses || []).some(st => reqSet.has(st.statusId));
        const hpLimit = clamp(sk.aiHpBelowPercent ?? 100, 1, 100);
        const underHp = (u) => (u.maxHp > 0 ? (u.hp / u.maxHp) * 100 : 100) <= hpLimit;

        if (sk.targetType === 'single_ally') {
            const list = friends
                .filter(u => isAlive(u) && hasReq(u) && underHp(u))
                .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
            return list[0]?.id || null;
        }
        if (sk.targetType === 'all_allies') {
            const aliveFriends = friends.filter(isAlive);
            if (aliveFriends.length === 0) return null;
            if (!aliveFriends.some(underHp)) return null;
            return checkSkillPrerequisite(state, config, actor, sk, '').ok ? '' : null;
        }
        if (sk.targetType === 'self') {
            return (hasReq(actor) && actorHpPct <= hpLimit) ? actor.id : null;
        }
        if (sk.targetType === 'single_enemy') {
            if (actorHpPct > hpLimit) return null;
            const list = foes.filter(u => isAlive(u) && hasReq(u));
            return list.length > 0 ? list[Math.floor(Math.random() * list.length)].id : null;
        }
        // all_enemies
        if (actorHpPct > hpLimit) return null;
        return checkSkillPrerequisite(state, config, actor, sk, '').ok ? '' : null;
    };

    const candidatePairs = getUnitAvailableSkills(actor, config)
        .map(entry => entry.skill)
        .filter(sk => sk && actor.mp >= sk.mpCost)
        .map(sk => ({ skill: sk, targetId: pickTargetForSkill(sk) }))
        .filter(pair => pair.targetId !== null);

    if (candidatePairs.length === 0) {
        const fallbackSkill = (config.skills || []).find(
            sk => sk.mpCost <= actor.mp && pickTargetForSkill(sk) !== null
        );
        return fallbackSkill ? { skill: fallbackSkill, targetId: pickTargetForSkill(fallbackSkill) } : null;
    }

    const strategy = actor.aiStrategy || 'priority';

    if (strategy === 'random') {
        return candidatePairs[Math.floor(Math.random() * candidatePairs.length)];
    }

    if (strategy === 'weighted') {
        const weights = candidatePairs.map(p => Math.max(1, Number(p.skill.aiPriority ?? 10) || 10));
        const total = weights.reduce((sum, w) => sum + w, 0);
        let roll = Math.random() * total;
        for (let i = 0; i < candidatePairs.length; i++) {
            roll -= weights[i];
            if (roll <= 0) return candidatePairs[i];
        }
        return candidatePairs[candidatePairs.length - 1];
    }

    // 默认 priority：取当前可放技能中 aiPriority 最高的一档（并列最高则随机）
    let maxPrio = -Infinity;
    for (const pair of candidatePairs) {
        const p = Number(pair.skill.aiPriority ?? 10) || 10;
        if (p > maxPrio) maxPrio = p;
    }
    const topPairs = candidatePairs.filter(pair => (Number(pair.skill.aiPriority ?? 10) || 10) === maxPrio);
    return topPairs[Math.floor(Math.random() * topPairs.length)];
}

/**
 * 执行所有开启了“自动托管 AI”且尚未行动的存活我方角色
 */
function runAutoAlliesTurn(state, config) {
    for (const ally of state.allies) {
        if (!isAlive(ally) || ally.hasActed || !ally.autoControl) continue;
        if (checkBattleOutcome(state)) return;

        const chosenPair = pickAiSkillAndTarget(state, config, ally);
        if (!chosenPair) {
            ally.hasActed = true;
            appendBattleLog(state, `${ally.name}（托管）暂无可用技能，本回合待命。`);
            continue;
        }
        performSkill(state, config, ally, chosenPair.skill, chosenPair.targetId);
        if (checkBattleOutcome(state)) return;
    }
}

/**
 * 玩家释放技能
 */
export function executeAllyAction(state, config, actorId, skillId, targetId) {
    if (!state || !state.active) return { ok: false, message: '请先开始战斗。', newLogs: [] };
    if (state.phase !== 'player_turn') return { ok: false, message: '当前不是我方行动阶段。', newLogs: [] };

    const actor = state.allies.find(u => u.id === actorId);
    if (!actor) return { ok: false, message: '请先选择一名我方角色。', newLogs: [] };
    if (actor.hasActed) return { ok: false, message: `${actor.name} 本回合已经行动过了。`, newLogs: [] };

    const skill = findSkillById(config, skillId);
    if (!skill) return { ok: false, message: '未找到对应的技能配置。', newLogs: [] };

    const logStartIndex = state.currentRoundLogs.length;
    const res = performSkill(state, config, actor, skill, targetId);
    if (!res.ok) return { ok: false, message: res.message, newLogs: [] };

    if (checkBattleOutcome(state)) {
        syncDefaultSelections(state);
        return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
    }

    // 若所有手动操作角色均已行动，则自动执行托管队友的行动
    const hasRemainingManual = state.allies.some(u => isAlive(u) && !u.hasActed && !u.autoControl);
    if (!hasRemainingManual) {
        runAutoAlliesTurn(state, config);
        if (checkBattleOutcome(state)) {
            syncDefaultSelections(state);
            return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
        }
    }

    const hasRemainingActor = state.allies.some(u => isAlive(u) && !u.hasActed);
    if (!hasRemainingActor && config.general?.autoEndPlayerTurn !== false) {
        runEnemyTurnAndRoundEnd(state, config);
    } else {
        syncDefaultSelections(state);
    }

    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

/**
 * 玩家在战斗中使用消耗品道具（v1.1 新增）
 */
export function executeUseItem(state, config, actorId, itemId, targetId) {
    if (!state || !state.active) return { ok: false, message: '请先开始战斗。', newLogs: [] };
    if (state.phase !== 'player_turn') return { ok: false, message: '当前不是我方行动阶段。', newLogs: [] };

    const actor = state.allies.find(u => u.id === actorId);
    if (!actor || !isAlive(actor)) return { ok: false, message: '请先选择一名存活的我方角色。', newLogs: [] };

    const item = findItemById(config, itemId);
    if (!item) return { ok: false, message: '未找到该道具。', newLogs: [] };
    if (item.quantity <= 0) return { ok: false, message: `「${item.name}」库存不足！`, newLogs: [] };
    if (item.consumesTurn && actor.hasActed) {
        return { ok: false, message: `${actor.name} 本回合已行动（该道具会消耗行动回合）。`, newLogs: [] };
    }

    const targets = resolveTargets(state, actor, item.targetType, targetId);
    if (targets.length === 0) return { ok: false, message: '没有可生效的存活目标。', newLogs: [] };

    const logStartIndex = state.currentRoundLogs.length;
    item.quantity = Math.max(0, item.quantity - 1);
    if (item.consumesTurn) {
        actor.hasActed = true;
    }

    const targetSummaries = [];
    for (const target of targets) {
        const vars = buildFormulaVars(actor, target, config);
        const amount = Math.max(0, evaluateFormula(item.formula, vars));
        const notes = [];

        if (item.effectType === 'heal') {
            const before = target.hp;
            target.hp = Math.min(target.maxHp, target.hp + amount);
            notes.push(`回复 ${target.hp - before} 点 HP（当前 ${target.hp}/${target.maxHp}）`);
        } else if (item.effectType === 'mp_restore') {
            const before = target.mp;
            target.mp = Math.min(target.maxMp, target.mp + amount);
            notes.push(`回复 ${target.mp - before} 点 MP（当前 ${target.mp}/${target.maxMp}）`);
        } else if (item.effectType === 'damage') {
            target.hp = Math.max(0, target.hp - amount);
            notes.push(`造成 ${amount} 点伤害（剩余 HP ${target.hp}/${target.maxHp}）`);
            if (target.hp <= 0) notes.push('倒下');
        } else if (item.effectType === 'cleanse') {
            const removed = [];
            target.statuses = (target.statuses || []).filter(st => {
                // 仅清除临时战斗状态，不误删装备常驻 Buff 或条件维持态
                if (st.source === 'equipment' || st.source === 'threshold') return true;
                const def = findStatusDefById(config, st.statusId);
                if (def) removed.push(def.name);
                return false;
            });
            notes.push(removed.length ? `清除了状态「${removed.join('、')}」` : '当前无临时状态可清除');
        }

        const tGA = applyGaugeDelta(target, 'gauge_a', item.targetGaugeAChange, config);
        const tGB = applyGaugeDelta(target, 'gauge_b', item.targetGaugeBChange, config);
        if (tGA) notes.push(tGA);
        if (tGB) notes.push(tGB);

        if (item.applyStatusId) {
            const stText = tryApplyStatus(target, item.applyStatusId, item.applyStatusChance, config);
            if (stText) notes.push(stText);
        }

        targetSummaries.push(`对 ${target.name} ${notes.length ? notes.join('，') : '生效'}`);
    }

    appendBattleLog(
        state,
        `${actor.name} 使用了道具「${item.name}」（剩余 ${item.quantity}）：${targetSummaries.join('；')}。`
    );

    if (checkBattleOutcome(state)) {
        syncDefaultSelections(state);
        return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
    }

    if (item.consumesTurn) {
        const hasRemainingManual = state.allies.some(u => isAlive(u) && !u.hasActed && !u.autoControl);
        if (!hasRemainingManual) {
            runAutoAlliesTurn(state, config);
            if (checkBattleOutcome(state)) {
                syncDefaultSelections(state);
                return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
            }
        }
        const hasRemainingActor = state.allies.some(u => isAlive(u) && !u.hasActed);
        if (!hasRemainingActor && config.general?.autoEndPlayerTurn !== false) {
            runEnemyTurnAndRoundEnd(state, config);
        } else {
            syncDefaultSelections(state);
        }
    }

    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

/**
 * 战斗中穿戴装备（同部位非饰品自动替换，实时更新属性与装备附带常驻 Buff）
 */
export function equipItemOnUnit(state, config, unitId, equipId) {
    const unit = findUnitById(state, unitId);
    const equip = findEquipmentById(config, equipId);
    if (!unit || !equip) return { ok: false, message: '未找到角色或装备。', newLogs: [] };

    if (!Array.isArray(unit.equipmentIds)) unit.equipmentIds = [];
    if (unit.equipmentIds.includes(equipId)) {
        return { ok: false, message: `${unit.name} 已经装备了「${equip.name}」。`, newLogs: [] };
    }

    const logStartIndex = state.currentRoundLogs.length;

    // 武器/头部/防具同部位自动替换；饰品允许同时戴多件
    let replacedName = '';
    if (equip.slot !== 'accessory') {
        const sameSlotIdx = unit.equipmentIds.findIndex(id => findEquipmentById(config, id)?.slot === equip.slot);
        if (sameSlotIdx >= 0) {
            replacedName = findEquipmentById(config, unit.equipmentIds[sameSlotIdx])?.name || '';
            unit.equipmentIds.splice(sameSlotIdx, 1);
        }
    }

    unit.equipmentIds.push(equipId);
    syncUnitEquipmentEffects(unit, config, false);

    // 同步写回配置模板，使下次开战保持最新穿戴状态
    const tplList = unit.side === 'ally' ? config.allies : config.enemies;
    const tpl = (tplList || []).find(u => u.id === unit.id);
    if (tpl) tpl.equipmentIds = [...unit.equipmentIds];

    const buffDef = equip.passiveStatusId ? findStatusDefById(config, equip.passiveStatusId) : null;
    const buffNote = buffDef ? `，获得常驻状态「${buffDef.name}」` : '';
    const replaceNote = replacedName ? `（替换了「${replacedName}」）` : '';
    appendBattleLog(state, `${unit.name} 装备了「${equip.name}」${replaceNote}${buffNote}。`);

    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

/**
 * 战斗中卸下装备（同步移除属性加成与装备常驻 Buff）
 */
export function unequipItemFromUnit(state, config, unitId, equipId) {
    const unit = findUnitById(state, unitId);
    const equip = findEquipmentById(config, equipId);
    if (!unit || !equip) return { ok: false, message: '未找到角色或装备。', newLogs: [] };

    const idx = (unit.equipmentIds || []).indexOf(equipId);
    if (idx < 0) return { ok: false, message: `${unit.name} 未装备「${equip.name}」。`, newLogs: [] };

    const logStartIndex = state.currentRoundLogs.length;
    unit.equipmentIds.splice(idx, 1);
    syncUnitEquipmentEffects(unit, config, false);

    const tplList = unit.side === 'ally' ? config.allies : config.enemies;
    const tpl = (tplList || []).find(u => u.id === unit.id);
    if (tpl) tpl.equipmentIds = [...unit.equipmentIds];

    appendBattleLog(state, `${unit.name} 卸下了「${equip.name}」。`);
    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

export function endPlayerTurn(state, config) {
    if (!state || !state.active) return { ok: false, message: '请先开始战斗。', newLogs: [] };
    if (state.phase !== 'player_turn') return { ok: false, message: '当前战斗已结束或不在我方回合。', newLogs: [] };

    const logStartIndex = state.currentRoundLogs.length;
    // 结束我方回合前，先让未行动的自动托管队友出招
    runAutoAlliesTurn(state, config);
    if (checkBattleOutcome(state)) {
        syncDefaultSelections(state);
        return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
    }
    runEnemyTurnAndRoundEnd(state, config);
    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

function runEnemyTurnAndRoundEnd(state, config) {
    state.phase = 'enemy_turn';

    for (const enemy of state.enemies) {
        if (!isAlive(enemy)) continue;
        if (checkBattleOutcome(state)) return;

        const eff = getEffectiveStats(enemy, config);
        if (eff.isStunned) {
            appendBattleLog(state, `${enemy.name} 处于行动受限状态，跳过本回合行动！`);
            continue;
        }

        const chosenPair = pickAiSkillAndTarget(state, config, enemy);
        if (!chosenPair) {
            appendBattleLog(state, `${enemy.name} 暂无可满足释放条件的技能，本回合原地待命。`);
            continue;
        }

        performSkill(state, config, enemy, chosenPair.skill, chosenPair.targetId);
        if (checkBattleOutcome(state)) return;
    }

    runRoundEndSettlement(state, config);
    if (checkBattleOutcome(state)) return;

    state.turn += 1;
    appendBattleLog(state, `—— 进入第 ${state.turn} 回合 ——`);
    preparePlayerTurn(state, config);
}

function runRoundEndSettlement(state, config) {
    const gADef = config.gauges?.gauge_a;
    const gBDef = config.gauges?.gauge_b;

    const shouldApplyGaugeTick = (gaugeDef, unit) => {
        if (!gaugeDef || !Number(gaugeDef.perTurnChange)) return false;
        const scope = gaugeDef.perTurnScope || 'all';
        if (scope === 'allies') return unit.side === 'ally';
        if (scope === 'enemies') return unit.side === 'enemy';
        return true;
    };

    for (const unit of getAllUnits(state)) {
        if (!isAlive(unit)) continue;

        // 1. 结算角色身上所有 Buff/Debuff 的组合效果与倒计时（含到期转化）
        if (unit.statuses && unit.statuses.length > 0) {
            const remainingStatuses = [];
            const transformedStatuses = [];

            for (const activeSt of unit.statuses) {
                const def = findStatusDefById(config, activeSt.statusId);
                if (!def) continue;

                // 兼容 v1.2 多属性组合变化（同时影响 HP、MP、状态槽A、状态槽B）
                const hpDelta = Math.round(Number(def.perTurnHp ?? (def.targetStat === 'hp' ? def.value : 0)) || 0);
                const mpDelta = Math.round(Number(def.perTurnMp ?? (def.targetStat === 'mp' ? def.value : 0)) || 0);
                const gADelta = Math.round(Number(def.perTurnGaugeA ?? (def.targetStat === 'gauge_a' ? def.value : 0)) || 0);
                const gBDelta = Math.round(Number(def.perTurnGaugeB ?? (def.targetStat === 'gauge_b' ? def.value : 0)) || 0);

                const tickNotes = [];
                if (hpDelta !== 0) {
                    const before = unit.hp;
                    unit.hp = clamp(unit.hp + hpDelta, 0, unit.maxHp);
                    const diff = unit.hp - before;
                    if (diff < 0) tickNotes.push(`受到 ${Math.abs(diff)} 点持续伤害（HP ${unit.hp}/${unit.maxHp}）`);
                    else if (diff > 0) tickNotes.push(`回复 ${diff} 点 HP（HP ${unit.hp}/${unit.maxHp}）`);
                }
                if (mpDelta !== 0) {
                    const before = unit.mp;
                    unit.mp = clamp(unit.mp + mpDelta, 0, unit.maxMp);
                    const diff = unit.mp - before;
                    if (diff !== 0) tickNotes.push(`MP ${diff > 0 ? '+' : ''}${diff}（${unit.mp}/${unit.maxMp}）`);
                }
                if (gADelta !== 0) {
                    const note = applyGaugeDelta(unit, 'gauge_a', gADelta, config);
                    if (note) tickNotes.push(note);
                }
                if (gBDelta !== 0) {
                    const note = applyGaugeDelta(unit, 'gauge_b', gBDelta, config);
                    if (note) tickNotes.push(note);
                }

                if (tickNotes.length > 0) {
                    appendBattleLog(state, `${unit.name} 因「${def.name}」${tickNotes.join('，')}。`);
                }
                if (unit.hp <= 0) {
                    appendBattleLog(state, `${unit.name} 倒下了！`);
                }

                // 装备常驻 Buff 与阈值维持态 Buff 不随回合倒计时消失
                if (activeSt.source === 'equipment' || activeSt.source === 'threshold') {
                    remainingStatuses.push(activeSt);
                    continue;
                }

                activeSt.remainingTurns -= 1;
                if (activeSt.remainingTurns > 0) {
                    remainingStatuses.push(activeSt);
                } else {
                    // v1.2：状态倒计时结束时，支持自动转化为另一个新状态
                    const nextDef = (isAlive(unit) && def.onExpireStatusId)
                        ? findStatusDefById(config, def.onExpireStatusId)
                        : null;
                    if (nextDef) {
                        transformedStatuses.push({
                            statusId: nextDef.id,
                            remainingTurns: nextDef.duration,
                            source: 'normal',
                        });
                        appendBattleLog(
                            state,
                            `${unit.name} 的状态「${def.name}」结束，转化为「${nextDef.name}」(${nextDef.duration}回合)！`
                        );
                    } else {
                        appendBattleLog(state, `${unit.name} 身上的状态「${def.name}」已失效移除。`);
                    }
                }
            }

            // 合并本回合结束转化出来的新状态（避免与已保留同名普通状态重复）
            for (const nextSt of transformedStatuses) {
                const exist = remainingStatuses.find(
                    s => s.statusId === nextSt.statusId && (!s.source || s.source === 'normal')
                );
                if (exist) {
                    exist.remainingTurns = Math.max(exist.remainingTurns, nextSt.remainingTurns);
                } else {
                    remainingStatuses.push(nextSt);
                }
            }

            unit.statuses = remainingStatuses;
        }

        // 2. v1.2：结算特殊状态条的每回合自动增减（仅对存活单位生效）
        if (isAlive(unit)) {
            const passiveGaugeNotes = [];
            if (shouldApplyGaugeTick(gADef, unit)) {
                const note = applyGaugeDelta(unit, 'gauge_a', gADef.perTurnChange, config);
                if (note) passiveGaugeNotes.push(note);
            }
            if (shouldApplyGaugeTick(gBDef, unit)) {
                const note = applyGaugeDelta(unit, 'gauge_b', gBDef.perTurnChange, config);
                if (note) passiveGaugeNotes.push(note);
            }
            if (passiveGaugeNotes.length > 0) {
                appendBattleLog(state, `回合结算：${unit.name} ${passiveGaugeNotes.join('，')}。`);
            }
        }
    }
}

export function formatCombatLogOutput(state, config, lines = null) {
    const targetLines = Array.isArray(lines) && lines.length > 0
        ? lines
        : (state?.currentRoundLogs || []);

    if (targetLines.length === 0) return '';

    const headerTpl = config?.general?.logHeaderTemplate || '【第 {{turn}} 回合战斗记录】';
    const prefix = config?.general?.actionLogPrefix ?? '- ';
    const header = headerTpl.replaceAll('{{turn}}', String(state?.turn ?? 1));

    const body = targetLines.map(line => `${prefix}${line}`).join('\n');
    return `${header}\n${body}`;
}

export function adjustUnitStatManual(state, config, unitId, stat, delta) {
    const unit = findUnitById(state, unitId);
    if (!unit) return false;

    const num = Math.round(Number(delta) || 0);
    if (num === 0) return false;

    if (stat === 'hp') {
        unit.hp = clamp(unit.hp + num, 0, unit.maxHp);
    } else if (stat === 'mp') {
        unit.mp = clamp(unit.mp + num, 0, unit.maxMp);
    } else if (stat === 'gauge_a' || stat === 'gauge_b') {
        unit.gauges[stat] = clamp((unit.gauges[stat] ?? 0) + num, 0, 100);
    } else {
        return false;
    }

    if (state.phase === 'victory' || state.phase === 'defeat') {
        if (state.allies.some(isAlive) && state.enemies.some(isAlive)) {
            state.phase = 'player_turn';
        }
    } else {
        checkBattleOutcome(state);
    }
    syncDefaultSelections(state);
    return true;
}
