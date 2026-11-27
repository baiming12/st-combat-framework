/**
 * 通用回合制战斗核心引擎 (src/engine.js) - v1.1
 * 职责：
 * 1. 纯逻辑计算，严禁硬编码任何技能名、状态名、角色名、装备名或剧情文本
 * 2. 支持 1v1 ~ 4v4 回合制状态机：我方行动 -> 敌方行动 -> 回合结束结算
 * 3. 支持 4 类通用 Buff/Debuff 机制：每回合持续增减 HP/特殊槽、跳过回合、攻防倍率、倒计时自动移除
 * 4. v1.1 新增：装备系统（属性加成、附带技能、穿戴常驻 Buff）、战斗消耗品道具系统（含净化效果）
 * 5. 内置无 eval 的安全公式解析器，兼容 TauriTavern 严格 CSP 环境
 */

import { MAX_UNITS_PER_SIDE, clamp, getGaugeEntries } from './config.js';

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
        const gSkills = Array.isArray(eq.grantSkillIds)
            ? eq.grantSkillIds
            : (eq.grantSkillId ? [eq.grantSkillId] : []);
        for (const sid of gSkills) {
            if (sid) grantedSkills.push({ skillId: sid, equipName: eq.name });
        }
        const pStatuses = Array.isArray(eq.passiveStatusIds)
            ? eq.passiveStatusIds
            : (eq.passiveStatusId ? [eq.passiveStatusId] : []);
        for (const stId of pStatuses) {
            if (stId) passiveStatuses.push({ statusId: stId, equipId: eq.id, equipName: eq.name });
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
    if (!unit.gauges || typeof unit.gauges !== 'object') unit.gauges = {};
    for (const gDef of getGaugeEntries(config)) {
        const cur = unit.gauges[gDef.id];
        unit.gauges[gDef.id] = clamp(Number.isFinite(Number(cur)) ? Number(cur) : gDef.min, gDef.min, gDef.max);
    }

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
    let damageTakenMultiplier = 1;
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
        if (Number.isFinite(def.damageTakenMultiplier) && def.damageTakenMultiplier >= 0 && def.damageTakenMultiplier !== 1) {
            damageTakenMultiplier *= def.damageTakenMultiplier;
        }
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
        damageTakenMultiplier: Number(damageTakenMultiplier.toFixed(2)),
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
        gauges: (() => {
            const gMap = {};
            const initMap = tpl.initialGauges && typeof tpl.initialGauges === 'object' ? tpl.initialGauges : {};
            for (const gDef of getGaugeEntries(config)) {
                const legacy = gDef.id === 'gauge_a' ? tpl.initialGaugeA : (gDef.id === 'gauge_b' ? tpl.initialGaugeB : undefined);
                const rawVal = initMap[gDef.id] !== undefined ? initMap[gDef.id] : (legacy !== undefined ? legacy : gDef.min);
                gMap[gDef.id] = clamp(rawVal, gDef.min, gDef.max);
            }
            return gMap;
        })(),
        skillIds: Array.isArray(tpl.skillIds) ? [...tpl.skillIds] : [],
        equipmentIds: Array.isArray(tpl.equipmentIds) ? [...tpl.equipmentIds] : [],
        aiStrategy: ['priority', 'weighted', 'random'].includes(tpl.aiStrategy) ? tpl.aiStrategy : 'priority',
        autoControl: side === 'ally' ? Boolean(tpl.autoControl) : false,
        cooldowns: {}, // { [skillId]: remainingTurns }
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
 * 计算单位当前所有 Buff/Debuff 对指定状态槽增减的累计倍率
 * @param {object} unit
 * @param {string} gaugeKey
 * @param {number} delta 正数=增加，负数=减少
 * @param {object} config
 * @returns {number}
 */
export function getUnitGaugeChangeMultiplier(unit, gaugeKey, delta, config) {
    if (!unit || !delta) return 1;
    const dir = delta > 0 ? 'gain' : 'loss';
    let mult = 1;
    for (const activeSt of unit.statuses || []) {
        const def = findStatusDefById(config, activeSt.statusId);
        if (!def || !Array.isArray(def.gaugeChangeMultipliers)) continue;
        for (const rule of def.gaugeChangeMultipliers) {
            if (!rule) continue;
            const matchGauge = rule.gaugeId === '_all' || rule.gaugeId === gaugeKey;
            const matchDir = rule.direction === 'both' || rule.direction === dir;
            if (matchGauge && matchDir && Number.isFinite(Number(rule.multiplier)) && Number(rule.multiplier) >= 0) {
                mult *= Number(rule.multiplier);
            }
        }
    }
    return Number(mult.toFixed(3));
}

/**
 * 修改单位某项特殊计量条，并返回变化描述（v1.8 支持任意自定义状态槽、自定义 min/max 与 Buff 增减倍率）
 */
function applyGaugeDelta(unit, gaugeKey, delta, config) {
    const rawNum = Math.round(Number(delta) || 0);
    if (rawNum === 0) return '';
    const gDef = config.gauges?.[gaugeKey];
    const gMin = Number.isFinite(Number(gDef?.min)) ? Number(gDef.min) : 0;
    const gMax = Number.isFinite(Number(gDef?.max)) ? Number(gDef.max) : 100;
    const gaugeName = gDef?.name || gaugeKey;

    const mult = getUnitGaugeChangeMultiplier(unit, gaugeKey, rawNum, config);
    const num = mult === 1 ? rawNum : Math.round(rawNum * mult);
    if (num === 0) {
        return mult === 0 ? `${gaugeName}变化被状态阻挡(×0)` : '';
    }

    if (!unit.gauges || typeof unit.gauges !== 'object') unit.gauges = {};
    const before = Number.isFinite(Number(unit.gauges[gaugeKey])) ? Number(unit.gauges[gaugeKey]) : gMin;
    const after = clamp(before + num, gMin, gMax);
    unit.gauges[gaugeKey] = after;
    const actualDelta = after - before;
    if (actualDelta === 0) return '';
    const sign = actualDelta > 0 ? '+' : '';
    const multNote = mult !== 1 ? `(×${Number(mult.toFixed(2))})` : '';
    return `${gaugeName}${sign}${actualDelta}${multNote}(${after}/${gMax})`;
}

/** 批量应用多条自定义状态槽增减（向下兼容旧版 gauge_a / gauge_b 独立字段） */
function applyGaugeChanges(unit, changesMap, legacyA, legacyB, config) {
    const merged = {};
    if (changesMap && typeof changesMap === 'object') {
        for (const [k, v] of Object.entries(changesMap)) {
            const num = Math.round(Number(v) || 0);
            if (num !== 0) merged[k] = num;
        }
    }
    if (merged.gauge_a === undefined && Math.round(Number(legacyA) || 0) !== 0) {
        merged.gauge_a = Math.round(Number(legacyA));
    }
    if (merged.gauge_b === undefined && Math.round(Number(legacyB) || 0) !== 0) {
        merged.gauge_b = Math.round(Number(legacyB));
    }
    const notes = [];
    for (const gDef of getGaugeEntries(config)) {
        if (merged[gDef.id]) {
            const note = applyGaugeDelta(unit, gDef.id, merged[gDef.id], config);
            if (note) notes.push(note);
        }
    }
    return notes;
}

/**
 * 尝试给单位挂载普通状态（若已存在同名普通状态则刷新持续回合数；v1.7 束缚状态自动记录施法者或道具血量）
 * @param {object} target
 * @param {string} statusId
 * @param {number} chance 0~100
 * @param {object} config
 * @param {object|null} [caster=null]
 * @returns {string}
 */
function tryApplyStatus(target, statusId, chance, config, caster = null) {
    if (!statusId || !isAlive(target)) return '';
    const def = findStatusDefById(config, statusId);
    if (!def) return '';

    const roll = Math.random() * 100;
    if (roll > clamp(chance ?? 100, 0, 100)) {
        return '';
    }

    const isObjectRestraint = Boolean(def.restraintType && def.restraintSourceMode === 'object');
    const isCasterRestraint = Boolean(def.restraintType && def.restraintSourceMode !== 'object');
    const objHp = Math.max(1, Math.round(Number(def.restraintObjectHp ?? 50) || 50));

    const existing = target.statuses.find(s => s.statusId === statusId && (!s.source || s.source === 'normal'));
    if (existing) {
        existing.remainingTurns = Math.max(existing.remainingTurns, def.duration);
        if (isCasterRestraint && caster?.id) existing.casterId = caster.id;
        if (isObjectRestraint) {
            existing.objectMaxHp = objHp;
            existing.objectHp = Math.max(existing.objectHp || 0, objHp);
        }
        return `刷新状态「${def.name}」(${existing.remainingTurns}回合)`;
    }

    const entry = {
        statusId: def.id,
        remainingTurns: def.duration,
        source: 'normal',
    };
    if (isCasterRestraint && caster?.id) {
        entry.casterId = caster.id;
    }
    if (isObjectRestraint) {
        entry.objectMaxHp = objHp;
        entry.objectHp = objHp;
    }

    target.statuses.push(entry);
    if (isObjectRestraint) {
        const objLabel = def.restraintObjectName || def.name;
        return `施加禁锢「${objLabel}」(HP ${objHp}，${def.duration}回合)`;
    }
    return `附加状态「${def.name}」(${def.duration}回合)`;
}

/**
 * =========================================================================
 * 三点五、束缚/禁锢与挣扎解救机制（v1.7 新增）
 * - 物理束缚挣脱概率 = (HP/maxHP) * (我方有效力量atk / 敌方有效力量atk 或 物理禁锢道具强度值)
 * - 法术束缚挣脱概率 = (MP/maxMP) * (我方有效精神spi / 敌方有效精神spi 或 法术禁锢道具强度值)
 * - 攻击施法者维持型束缚的施法者 -> 立即解除所有被其束缚的单位
 * - 攻击禁锢道具 -> 扣除道具血量，归零立即破碎解除
 * =========================================================================
 */

/** 解析禁锢道具目标 ID（格式：restraint::<unitId>::<statusId>） */
export function parseRestraintObjectTargetId(targetId) {
    if (typeof targetId !== 'string' || !targetId.startsWith('restraint::')) return null;
    const parts = targetId.split('::');
    if (parts.length < 3) return null;
    return { unitId: parts[1], statusId: parts.slice(2).join('::') };
}

/** 获取单位身上当前全部激活的束缚/禁锢状态列表 */
export function getUnitRestraints(unit, config) {
    if (!unit || !Array.isArray(unit.statuses)) return [];
    const list = [];
    for (const st of unit.statuses) {
        const def = findStatusDefById(config, st.statusId);
        if (def && (def.restraintType === 'physical' || def.restraintType === 'magical')) {
            list.push({ active: st, def });
        }
    }
    return list;
}

/** 判断单位当前是否处于束缚/禁锢状态（无法释放普通技能） */
export function isUnitRestrained(unit, config) {
    return getUnitRestraints(unit, config).length > 0;
}

/**
 * 计算单条束缚状态的实时挣脱概率（严格使用叠加 Buff/装备/加点后的有效属性！）
 * @param {object} state
 * @param {object} config
 * @param {object} unit 被束缚者
 * @param {{ active: object, def: object }} restraint
 * @returns {{ chance: number, percent: number, detail: string }}
 */
export function calculateStruggleChance(state, config, unit, restraint) {
    const { active, def } = restraint;
    const unitEff = getEffectiveStats(unit, config);
    const isMag = def.restraintType === 'magical';

    const ratio = isMag
        ? (unit.maxMp > 0 ? clamp(unit.mp / unit.maxMp, 0, 1) : 0)
        : (unit.maxHp > 0 ? clamp(unit.hp / unit.maxHp, 0, 1) : 0);

    const myStat = isMag ? unitEff.spi : unitEff.atk;
    const myStatLabel = isMag ? '精神' : '力量/物攻';
    const ratioLabel = isMag ? `MP比${Math.round(ratio * 100)}%` : `HP比${Math.round(ratio * 100)}%`;

    let resistStat = 0;
    let resistLabel = '';

    if (def.restraintSourceMode === 'object') {
        resistStat = Math.max(1, Number(def.restraintPower) || 20);
        resistLabel = `${def.restraintObjectName || def.name}强度${resistStat}`;
    } else {
        const caster = active.casterId ? findUnitById(state, active.casterId) : null;
        if (caster && isAlive(caster)) {
            const casterEff = getEffectiveStats(caster, config);
            resistStat = Math.max(1, isMag ? casterEff.spi : casterEff.atk);
            resistLabel = `${caster.name}${myStatLabel}${resistStat}`;
        } else {
            resistStat = Math.max(1, Number(def.restraintPower) || 20);
            resistLabel = `束缚强度${resistStat}`;
        }
    }

    const rawChance = ratio * (myStat / resistStat);
    const chance = clamp(rawChance, 0, 1);
    const percent = Math.round(chance * 100);
    const detail = `${ratioLabel} × (自身${myStatLabel}${myStat} / ${resistLabel}) = ${percent}%`;
    return { chance, percent, detail };
}

/**
 * 获取单位当前综合挣扎概率预览（取各束缚中最低概率，供 HUD 按钮展示）
 */
export function getUnitStrugglePreview(state, config, unit) {
    const restraints = getUnitRestraints(unit, config);
    if (restraints.length === 0) return null;
    const items = restraints.map(r => ({
        name: r.def.restraintObjectName || r.def.name,
        restraintType: r.def.restraintType,
        ...calculateStruggleChance(state, config, unit, r),
    }));
    const minPercent = Math.min(...items.map(x => x.percent));
    return { minPercent, items };
}

/**
 * 当施法者受到攻击（或倒下）时，立即释放所有由该施法者维持的束缚状态
 */
export function releaseRestraintsByCaster(state, config, casterId, triggerReason = '受到攻击被打断') {
    if (!state || !casterId) return [];
    const caster = findUnitById(state, casterId);
    const casterName = caster?.name || casterId;
    const releasedLogs = [];

    for (const unit of getAllUnits(state)) {
        if (!Array.isArray(unit.statuses) || unit.statuses.length === 0) continue;
        const removedNames = [];
        unit.statuses = unit.statuses.filter(st => {
            const def = findStatusDefById(config, st.statusId);
            if (def && def.restraintType && def.restraintSourceMode !== 'object' && st.casterId === casterId) {
                removedNames.push(def.name);
                return false;
            }
            return true;
        });
        if (removedNames.length > 0) {
            const line = `🔓 ${casterName} ${triggerReason}，${unit.name} 身上的束缚「${removedNames.join('、')}」立即解除！`;
            appendBattleLog(state, line);
            releasedLogs.push(line);
        }
    }
    return releasedLogs;
}

/**
 * 内部执行一次挣扎判定（玩家手动挣扎、自定义挣扎技能与敌方 AI 挣扎共用）
 */
function performStruggleAction(state, config, actor, skill = null) {
    if (!isAlive(actor)) {
        return { ok: false, message: `${actor.name} 已失去战斗能力。` };
    }
    const restraints = getUnitRestraints(actor, config);
    if (restraints.length === 0) {
        return { ok: false, message: `${actor.name} 当前并未被束缚/禁锢。` };
    }
    if (skill && actor.mp < (skill.mpCost || 0)) {
        return { ok: false, message: `${actor.name} 的 MP 不足。` };
    }

    if (skill && skill.mpCost > 0) {
        actor.mp = Math.max(0, actor.mp - skill.mpCost);
    }
    if (skill && (Number(skill.cooldown) || 0) > 0) {
        if (!actor.cooldowns || typeof actor.cooldowns !== 'object') actor.cooldowns = {};
        actor.cooldowns[skill.id] = Math.round(Number(skill.cooldown));
    }
    actor.hasActed = true;

    const actionName = skill ? `使用了「${skill.name}」` : '尝试挣扎';
    const brokenIds = new Set();
    const summaries = [];

    for (const r of restraints) {
        const { chance, detail } = calculateStruggleChance(state, config, actor, r);
        const roll = Math.random();
        const label = r.def.restraintObjectName || r.def.name;
        if (roll < chance) {
            brokenIds.add(r.active.statusId);
            summaries.push(`挣脱「${label}」成功！（${detail}）`);
        } else {
            summaries.push(`挣脱「${label}」失败（${detail}）`);
        }
    }

    if (brokenIds.size > 0) {
        actor.statuses = actor.statuses.filter(st => !brokenIds.has(st.statusId));
    }

    if (skill) {
        applyGaugeChanges(actor, skill.selfGaugeChanges, skill.selfGaugeAChange, skill.selfGaugeBChange, config);
    }

    appendBattleLog(state, `⛓️ ${actor.name} ${actionName}：${summaries.join('；')}。`);
    return { ok: true };
}

/**
 * 玩家点击内置「⛓️ 挣扎脱离」按钮入口
 */
export function executeStruggleAction(state, config, actorId, customSkill = null) {
    if (!state || !state.active) return { ok: false, message: '请先开始战斗。', newLogs: [] };
    if (state.phase !== 'player_turn') return { ok: false, message: '当前不是我方行动阶段。', newLogs: [] };

    const actor = state.allies.find(u => u.id === actorId);
    if (!actor) return { ok: false, message: '请先选择一名我方角色。', newLogs: [] };
    if (actor.hasActed) return { ok: false, message: `${actor.name} 本回合已经行动过了。`, newLogs: [] };

    const logStartIndex = state.currentRoundLogs.length;
    const res = performStruggleAction(state, config, actor, customSkill);
    if (!res.ok) return { ok: false, message: res.message, newLogs: [] };

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
    const vars = {
        atk: actorEff.atk,
        spi: actorEff.spi,
        def: actorEff.def,
        mdef: actorEff.mdef,
        level: Math.max(1, Number(actor.level) || 1),
        hp: actor.hp,
        max_hp: actor.maxHp,
        mp: actor.mp,
        max_mp: actor.maxMp,
        gauge_a: actor.gauges?.gauge_a ?? 0,
        gauge_b: actor.gauges?.gauge_b ?? 0,
        target_atk: targetEff.atk,
        target_spi: targetEff.spi,
        target_def: targetEff.def,
        target_mdef: targetEff.mdef,
        target_level: Math.max(1, Number(target.level) || 1),
        target_hp: target.hp,
        target_max_hp: target.maxHp,
        target_gauge_a: target.gauges?.gauge_a ?? 0,
        target_gauge_b: target.gauges?.gauge_b ?? 0,
    };
    for (const gDef of getGaugeEntries(config)) {
        vars[gDef.id] = actor.gauges?.[gDef.id] ?? gDef.min;
        vars[`target_${gDef.id}`] = target.gauges?.[gDef.id] ?? gDef.min;
    }
    return vars;
}

/**
 * 获取技能/道具规范化后的多状态附加列表（兼容旧单字段）
 */
function getApplyStatusEntries(obj) {
    if (Array.isArray(obj?.applyStatuses)) {
        return obj.applyStatuses.filter(e => e && e.statusId);
    }
    if (obj?.applyStatusId) {
        return [{
            statusId: obj.applyStatusId,
            chance: obj.applyStatusChance ?? 100,
            target: obj.applyStatusTarget === 'self' ? 'self' : 'target',
        }];
    }
    return [];
}

/**
 * 获取单位某技能当前剩余冷却回合数
 */
export function getSkillRemainingCooldown(unit, skillId) {
    return Math.max(0, Math.round(Number(unit?.cooldowns?.[skillId] || 0)));
}

/**
 * 检查技能的前置条件：
 * 1. 冷却回合检查 (cooldown)
 * 2. 自身前置状态检查 (requiredSelfStatusIds：自身持有任一指定状态)
 * 3. 目标前置状态检查 (requiredTargetStatusIds：目标持有任一指定状态)
 */
export function checkSkillPrerequisite(state, config, actor, skill, targetId) {
    const restrained = isUnitRestrained(actor, config);
    if (restrained && skill?.effectType !== 'struggle') {
        return { ok: false, reason: '处于束缚/禁锢状态，无法释放普通技能（只能挣扎）' };
    }
    if (!restrained && skill?.effectType === 'struggle') {
        return { ok: false, reason: '当前未被束缚，无需挣扎' };
    }

    const cd = getSkillRemainingCooldown(actor, skill?.id);
    if (cd > 0) {
        return { ok: false, reason: `冷却中（剩余 ${cd} 回合）` };
    }

    // v2.0：状态槽前置门槛（例如需要 圣印 >= 3 才能释放大招）
    if (skill?.requiredGaugeId) {
        const reqGDef = config?.gauges?.[skill.requiredGaugeId];
        const curGVal = actor?.gauges?.[skill.requiredGaugeId] ?? (reqGDef?.min ?? 0);
        const minNeed = Number(skill.requiredGaugeMin) || 0;
        if (curGVal < minNeed) {
            const gLabel = reqGDef?.name || skill.requiredGaugeId;
            return { ok: false, reason: `需要「${gLabel}」达到 ${minNeed}（当前 ${curGVal}）` };
        }
    }

    const reqSelfIds = Array.isArray(skill?.requiredSelfStatusIds)
        ? skill.requiredSelfStatusIds.filter(Boolean)
        : [];
    if (reqSelfIds.length > 0) {
        const selfSet = new Set(reqSelfIds);
        const selfOk = (actor?.statuses || []).some(st => selfSet.has(st.statusId));
        if (!selfOk) {
            const names = reqSelfIds.map(id => findStatusDefById(config, id)?.name || id).join(' / ');
            return { ok: false, reason: `需要自身持有【${names}】之一才可释放` };
        }
    }

    // 瞄准禁锢道具时允许使用伤害类技能攻击该禁锢物
    const parsedObj = parseRestraintObjectTargetId(targetId);
    if (parsedObj) {
        if (skill?.effectType !== 'damage') {
            return { ok: false, reason: '只能使用伤害类技能攻击禁锢道具' };
        }
        return { ok: true };
    }

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

    // 若为自定义挣扎技能 (effectType === 'struggle')，直接走挣扎判定流程
    if (skill.effectType === 'struggle') {
        const res = performStruggleAction(state, config, actor, skill);
        return { ok: res.ok, message: res.message, logs: actionLogs };
    }

    // 若目标为禁锢道具 (restraint::<unitId>::<statusId>)，直接攻击道具血量，不伤及队友
    const parsedObj = parseRestraintObjectTargetId(targetId);
    if (parsedObj) {
        const boundUnit = findUnitById(state, parsedObj.unitId);
        const stIdx = boundUnit ? (boundUnit.statuses || []).findIndex(s => s.statusId === parsedObj.statusId && s.objectHp > 0) : -1;
        if (!boundUnit || stIdx < 0) {
            return { ok: false, message: '该禁锢道具已破碎或不存在。', logs: actionLogs };
        }
        const stObj = boundUnit.statuses[stIdx];
        const stDef = findStatusDefById(config, stObj.statusId);
        const objLabel = stDef?.restraintObjectName || stDef?.name || '禁锢道具';

        actor.mp = Math.max(0, actor.mp - skill.mpCost);
        actor.hasActed = true;
        if ((Number(skill.cooldown) || 0) > 0) {
            if (!actor.cooldowns || typeof actor.cooldowns !== 'object') actor.cooldowns = {};
            actor.cooldowns[skill.id] = Math.round(Number(skill.cooldown));
        }

        // 以 0 双抗虚拟对象计算对禁锢道具造成的伤害
        const dummyTarget = {
            hp: stObj.objectHp,
            maxHp: stObj.objectMaxHp || stObj.objectHp,
            baseAtk: 0, baseSpi: 0, baseDef: 0, baseMdef: 0,
            gauges: { gauge_a: 0, gauge_b: 0 },
            statuses: [], equipmentIds: [],
        };
        const vars = buildFormulaVars(actor, dummyTarget, config);
        const dmg = Math.max(1, evaluateFormula(skill.formula, vars));
        stObj.objectHp = Math.max(0, stObj.objectHp - dmg);

        let resultNote = `剩余 HP ${stObj.objectHp}/${stObj.objectMaxHp}`;
        if (stObj.objectHp <= 0) {
            boundUnit.statuses.splice(stIdx, 1);
            resultNote = `禁锢物被击碎，${boundUnit.name} 恢复自由！`;
            state.selectedTargetId = state.enemies.find(isAlive)?.id || '';
        }
        const mpNote = skill.mpCost > 0 ? `（消耗 ${skill.mpCost} MP）` : '';
        const line = `🔨 ${actor.name} 使用了「${skill.name}」${mpNote}攻击 ${boundUnit.name} 身上的「${objLabel}」，造成 ${dmg} 点伤害（${resultNote}）。`;
        appendBattleLog(state, line);
        actionLogs.push(line);
        return { ok: true, logs: actionLogs };
    }

    const targets = resolveTargets(state, actor, skill.targetType, targetId);
    if (targets.length === 0) {
        return { ok: false, message: '没有可生效的存活目标。', logs: actionLogs };
    }

    actor.mp = Math.max(0, actor.mp - skill.mpCost);
    actor.hasActed = true;
    if ((Number(skill.cooldown) || 0) > 0) {
        if (!actor.cooldowns || typeof actor.cooldowns !== 'object') actor.cooldowns = {};
        actor.cooldowns[skill.id] = Math.round(Number(skill.cooldown));
    }

    const selfNotes = [];

    // v1.6：自身 HP 变化公式（负数=卖血/献祭消耗，正数=吸血/自愈）
    const selfHpFormulaStr = String(skill.selfHpFormula || '0').trim();
    if (selfHpFormulaStr && selfHpFormulaStr !== '0') {
        const selfVars = buildFormulaVars(actor, targets[0], config);
        const selfHpDelta = Math.round(evaluateFormula(selfHpFormulaStr, selfVars));
        if (selfHpDelta !== 0) {
            const before = actor.hp;
            actor.hp = clamp(actor.hp + selfHpDelta, 0, actor.maxHp);
            const diff = actor.hp - before;
            if (diff < 0) selfNotes.push(`消耗 ${Math.abs(diff)} HP(${actor.hp}/${actor.maxHp})`);
            else if (diff > 0) selfNotes.push(`吸取/回复 ${diff} HP(${actor.hp}/${actor.maxHp})`);
        }
    }

    // v1.6/v1.9：先计算主目标与附加复合效果，再挂载本技能的自身/群体新状态（避免复合净化误清刚上的新 Buff）
    const applyEntries = getApplyStatusEntries(skill);

    const targetSummaries = [];
    const attackedTargetIds = [];
    let mainTotalAmount = 0;

    for (const target of targets) {
        const hitRate = clamp(skill.hitRate ?? 100, 1, 100);
        if (hitRate < 100 && Math.random() * 100 > hitRate) {
            targetSummaries.push(`对 ${target.name} 未命中（闪避）`);
            continue;
        }

        const vars = buildFormulaVars(actor, target, config);
        let amount = Math.max(0, evaluateFormula(skill.formula, vars));
        const notes = [];

        if (skill.effectType === 'damage') {
            let isCrit = false;
            const critRate = clamp(skill.critRate ?? 0, 0, 100);
            if (critRate > 0 && Math.random() * 100 < critRate) {
                isCrit = true;
                amount = Math.max(1, Math.round(amount * (Number(skill.critMultiplier) || 1.5)));
            }
            const targetEff = getEffectiveStats(target, config);
            if (targetEff.damageTakenMultiplier !== 1) {
                amount = Math.max(0, Math.round(amount * targetEff.damageTakenMultiplier));
            }
            mainTotalAmount += amount;
            target.hp = Math.max(0, target.hp - amount);
            if (target.side !== actor.side) attackedTargetIds.push(target.id);
            const critTag = isCrit ? '💥暴击！' : '';
            const vulnTag = targetEff.damageTakenMultiplier !== 1 ? `[承伤×${targetEff.damageTakenMultiplier}]` : '';
            notes.push(`${critTag}造成 ${amount} 点伤害${vulnTag}（剩余 HP ${target.hp}/${target.maxHp}）`);
            if (target.hp <= 0) notes.push('倒下');
        } else if (skill.effectType === 'heal') {
            mainTotalAmount += amount;
            const before = target.hp;
            target.hp = Math.min(target.maxHp, target.hp + amount);
            notes.push(`回复 ${target.hp - before} 点 HP（当前 HP ${target.hp}/${target.maxHp}）`);
        } else if (skill.effectType === 'mp_restore') {
            mainTotalAmount += amount;
            const before = target.mp;
            target.mp = Math.min(target.maxMp, target.mp + amount);
            notes.push(`回复 ${target.mp - before} 点 MP/体力（当前 ${target.mp}/${target.maxMp}）`);
        }

        notes.push(...applyGaugeChanges(target, skill.targetGaugeChanges, skill.targetGaugeAChange, skill.targetGaugeBChange, config));

        // v1.6：支持同时向主目标附加多个状态（v1.7 传入施法者 actor 以支持打断施法者解除束缚）
        for (const entry of applyEntries) {
            if (!entry.target || entry.target === 'target') {
                const stText = tryApplyStatus(target, entry.statusId, entry.chance, config, actor);
                if (stText) notes.push(stText);
            }
        }

        targetSummaries.push(`对 ${target.name} ${notes.length ? notes.join('，') : '生效'}`);
    }

    // v1.9：执行技能的「附加复合效果」（同一技能可对敌人与自己/全队同时产生不同效果，支持公式变量 last_amount）
    for (const ef of skill.extraEffects || []) {
        if (!ef || typeof ef !== 'object') continue;
        const efTargets = ef.targetType === 'same'
            ? targets.filter(t => isAlive(t) || ef.effectType === 'utility')
            : resolveTargets(state, actor, ef.targetType, targetId);

        for (const et of efTargets) {
            const efVars = { ...buildFormulaVars(actor, et, config), last_amount: mainTotalAmount };
            const efAmount = Math.max(0, evaluateFormula(ef.formula, efVars));
            const efNotes = [];

            if (ef.effectType === 'damage') {
                const etEff = getEffectiveStats(et, config);
                const finalEfDmg = etEff.damageTakenMultiplier !== 1
                    ? Math.max(0, Math.round(efAmount * etEff.damageTakenMultiplier))
                    : efAmount;
                et.hp = Math.max(0, et.hp - finalEfDmg);
                if (et.side !== actor.side) attackedTargetIds.push(et.id);
                efNotes.push(`造成 ${finalEfDmg} 点伤害（剩余 HP ${et.hp}/${et.maxHp}）`);
                if (et.hp <= 0) efNotes.push('倒下');
            } else if (ef.effectType === 'heal') {
                const before = et.hp;
                et.hp = Math.min(et.maxHp, et.hp + efAmount);
                efNotes.push(`回复 ${et.hp - before} 点 HP（当前 HP ${et.hp}/${et.maxHp}）`);
            } else if (ef.effectType === 'mp_restore') {
                const before = et.mp;
                et.mp = Math.min(et.maxMp, et.mp + efAmount);
                efNotes.push(`回复 ${et.mp - before} 点 MP（当前 ${et.mp}/${et.maxMp}）`);
            } else if (ef.effectType === 'cleanse') {
                const removed = [];
                et.statuses = (et.statuses || []).filter(st => {
                    if (st.source === 'equipment' || st.source === 'threshold') return true;
                    const def = findStatusDefById(config, st.statusId);
                    if (def) removed.push(def.name);
                    return false;
                });
                efNotes.push(removed.length ? `清除了状态「${removed.join('、')}」` : '无可清除的临时状态');
            }

            efNotes.push(...applyGaugeChanges(et, ef.gaugeChanges, 0, 0, config));
            if (efNotes.length > 0) {
                if (et.id === actor.id && ef.targetType === 'self') {
                    selfNotes.push(...efNotes);
                } else {
                    targetSummaries.push(`同时对 ${et.name} ${efNotes.join('，')}`);
                }
            }
        }
    }

    // v1.6/v1.9：向自身、全体友方、全体敌方附加状态
    for (const entry of applyEntries) {
        if (entry.target === 'self') {
            const stText = tryApplyStatus(actor, entry.statusId, entry.chance, config, actor);
            if (stText) selfNotes.push(stText);
        } else if (entry.target === 'all_allies' || entry.target === 'all_enemies') {
            const groupTargets = resolveTargets(state, actor, entry.target, targetId);
            const appliedNames = [];
            for (const gt of groupTargets) {
                const stText = tryApplyStatus(gt, entry.statusId, entry.chance, config, actor);
                if (stText) appliedNames.push(`${gt.name}${stText}`);
            }
            if (appliedNames.length > 0) {
                targetSummaries.push(`群体状态：${appliedNames.join('、')}`);
            }
        }
    }

    // 在主效果与复合效果公式计算完成后再结算自身状态槽增减（支持“按当前层数结算伤害再消耗层数”的连击豆玩法）
    selfNotes.push(...applyGaugeChanges(actor, skill.selfGaugeChanges, skill.selfGaugeAChange, skill.selfGaugeBChange, config));

    const mpNote = skill.mpCost > 0 ? `（消耗 ${skill.mpCost} MP）` : '';
    const selfSuffix = selfNotes.length ? `；自身：${selfNotes.join('，')}` : '';
    const line = `${actor.name} 使用了「${skill.name}」${mpNote}：${targetSummaries.join('；')}${selfSuffix}。`;

    appendBattleLog(state, line);
    actionLogs.push(line);

    // v1.7：攻击了正在维持束缚的施法者 -> 立即释放所有被该施法者束缚的单位！
    for (const hitId of attackedTargetIds) {
        const hitUnit = findUnitById(state, hitId);
        const reason = hitUnit && !isAlive(hitUnit) ? '被击倒' : '受到攻击被打断';
        const freed = releaseRestraintsByCaster(state, config, hitId, reason);
        actionLogs.push(...freed);
    }

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
    const parsedObj = parseRestraintObjectTargetId(state.selectedTargetId);
    const validObjTarget = parsedObj && (() => {
        const u = findUnitById(state, parsedObj.unitId);
        return Boolean(u && (u.statuses || []).some(s => s.statusId === parsedObj.statusId && s.objectHp > 0));
    })();
    if (!validObjTarget && (!currentTarget || !isAlive(currentTarget))) {
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
        if (sk.effectType === 'struggle') return null;
        if (getSkillRemainingCooldown(actor, sk.id) > 0) return null;
        if (sk.requiredGaugeId) {
            const reqGDef = config?.gauges?.[sk.requiredGaugeId];
            const curGVal = actor?.gauges?.[sk.requiredGaugeId] ?? (reqGDef?.min ?? 0);
            if (curGVal < (Number(sk.requiredGaugeMin) || 0)) return null;
        }
        const reqSelfIds = Array.isArray(sk.requiredSelfStatusIds) ? sk.requiredSelfStatusIds.filter(Boolean) : [];
        if (reqSelfIds.length > 0) {
            const selfSet = new Set(reqSelfIds);
            if (!(actor.statuses || []).some(st => selfSet.has(st.statusId))) return null;
        }
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

        // v1.7：被束缚的托管队友自动尝试挣扎
        if (isUnitRestrained(ally, config)) {
            performStruggleAction(state, config, ally, null);
            continue;
        }

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
 * 玩家通用「🛡️ 防御待机」动作（防止 0 MP / 全冷却时卡死；回复少量 MP 并结束该角色本回合行动）
 */
export function executeDefendWaitAction(state, config, actorId) {
    if (!state || !state.active) return { ok: false, message: '请先开始战斗。', newLogs: [] };
    if (state.phase !== 'player_turn') return { ok: false, message: '当前不是我方行动阶段。', newLogs: [] };

    const actor = state.allies.find(u => u.id === actorId);
    if (!actor || !isAlive(actor)) return { ok: false, message: '请先选择一名存活的我方角色。', newLogs: [] };
    if (actor.hasActed) return { ok: false, message: `${actor.name} 本回合已经行动过了。`, newLogs: [] };
    if (isUnitRestrained(actor, config)) {
        return { ok: false, message: `${actor.name} 当前处于束缚状态，请点击「⛓️ 挣扎脱离」。`, newLogs: [] };
    }

    const logStartIndex = state.currentRoundLogs.length;
    actor.hasActed = true;
    let mpNote = '';
    if (actor.maxMp > 0 && actor.mp < actor.maxMp) {
        const gain = Math.max(5, Math.round(actor.maxMp * 0.1));
        const before = actor.mp;
        actor.mp = Math.min(actor.maxMp, actor.mp + gain);
        mpNote = `，调息回复 ${actor.mp - before} 点 MP（当前 ${actor.mp}/${actor.maxMp}）`;
    }
    appendBattleLog(state, `🛡️ ${actor.name} 选择防御待机${mpNote}。`);

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
 * 外部/剧情直接给指定角色附加或移除临时状态（供 <combat_event> grant_status 使用）
 */
export function applyExternalStatusToUnit(state, config, unitId, statusId, turnsOverride = null, remove = false) {
    const def = findStatusDefById(config, statusId);
    if (!def) return { ok: false, message: `未在状态库找到 ${statusId}` };
    const live = state?.active ? findUnitById(state, unitId) : null;
    if (!live) return { ok: false, message: '当前未在战斗中（状态仅在战斗中生效，或通过 MVU 带入）。' };

    if (remove) {
        const beforeLen = (live.statuses || []).length;
        live.statuses = (live.statuses || []).filter(s => !(s.statusId === def.id && (!s.source || s.source === 'normal')));
        if (live.statuses.length < beforeLen) {
            appendBattleLog(state, `✨ 剧情事件：${live.name} 身上的「${def.name}」已解除。`);
        }
        return { ok: true };
    }

    const dur = Math.max(1, Math.round(Number(turnsOverride ?? def.duration) || def.duration));
    const existing = (live.statuses || []).find(s => s.statusId === def.id && (!s.source || s.source === 'normal'));
    if (existing) {
        existing.remainingTurns = Math.max(existing.remainingTurns, dur);
    } else {
        const entry = { statusId: def.id, remainingTurns: dur, source: 'normal' };
        if (def.restraintType && def.restraintSourceMode === 'object') {
            const objHp = Math.max(1, Math.round(Number(def.restraintObjectHp ?? 50) || 50));
            entry.objectHp = objHp;
            entry.objectMaxHp = objHp;
        }
        live.statuses.push(entry);
    }
    appendBattleLog(state, `✨ 剧情事件：${live.name} 获得状态「${def.name}」(${dur}回合)。`);
    return { ok: true };
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

    // 使用伤害类道具攻击禁锢道具时直接扣除禁锢物血量
    const parsedObj = parseRestraintObjectTargetId(targetId);
    if (parsedObj) {
        if (item.effectType !== 'damage') {
            return { ok: false, message: '只能使用伤害类道具攻击禁锢道具。', newLogs: [] };
        }
        const boundUnit = findUnitById(state, parsedObj.unitId);
        const stIdx = boundUnit ? (boundUnit.statuses || []).findIndex(s => s.statusId === parsedObj.statusId && s.objectHp > 0) : -1;
        if (!boundUnit || stIdx < 0) return { ok: false, message: '该禁锢道具已破碎。', newLogs: [] };
        const stObj = boundUnit.statuses[stIdx];
        const stDef = findStatusDefById(config, stObj.statusId);
        const objLabel = stDef?.restraintObjectName || stDef?.name || '禁锢道具';

        const logStartIndex = state.currentRoundLogs.length;
        item.quantity = Math.max(0, item.quantity - 1);
        if (item.consumesTurn) actor.hasActed = true;
        const dummyTarget = {
            hp: stObj.objectHp,
            maxHp: stObj.objectMaxHp || stObj.objectHp,
            baseAtk: 0, baseSpi: 0, baseDef: 0, baseMdef: 0,
            gauges: { gauge_a: 0, gauge_b: 0 },
            statuses: [], equipmentIds: [],
        };
        const dmg = Math.max(1, evaluateFormula(item.formula, buildFormulaVars(actor, dummyTarget, config)));
        stObj.objectHp = Math.max(0, stObj.objectHp - dmg);
        let note = `剩余 HP ${stObj.objectHp}/${stObj.objectMaxHp}`;
        if (stObj.objectHp <= 0) {
            boundUnit.statuses.splice(stIdx, 1);
            note = `禁锢物被击碎，${boundUnit.name} 恢复自由！`;
            state.selectedTargetId = state.enemies.find(isAlive)?.id || '';
        }
        appendBattleLog(state, `🔨 ${actor.name} 使用道具「${item.name}」攻击「${objLabel}」，造成 ${dmg} 点伤害（${note}）。`);
        if (item.consumesTurn) {
            const hasRemainingManual = state.allies.some(u => isAlive(u) && !u.hasActed && !u.autoControl);
            if (!hasRemainingManual) runAutoAlliesTurn(state, config);
            if (!state.allies.some(u => isAlive(u) && !u.hasActed) && config.general?.autoEndPlayerTurn !== false) {
                runEnemyTurnAndRoundEnd(state, config);
            } else {
                syncDefaultSelections(state);
            }
        }
        return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
    }

    const targets = resolveTargets(state, actor, item.targetType, targetId);
    if (targets.length === 0) return { ok: false, message: '没有可生效的存活目标。', newLogs: [] };

    const logStartIndex = state.currentRoundLogs.length;
    item.quantity = Math.max(0, item.quantity - 1);
    if (item.consumesTurn) {
        actor.hasActed = true;
    }

    const targetSummaries = [];
    const attackedIds = [];
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
            attackedIds.push(target.id);
            notes.push(`造成 ${amount} 点伤害（剩余 HP ${target.hp}/${target.maxHp}）`);
            if (target.hp <= 0) notes.push('倒下');
        } else if (item.effectType === 'cleanse') {
            const removed = [];
            target.statuses = (target.statuses || []).filter(st => {
                if (st.source === 'equipment' || st.source === 'threshold') return true;
                const def = findStatusDefById(config, st.statusId);
                if (def) removed.push(def.name);
                return false;
            });
            notes.push(removed.length ? `清除了状态「${removed.join('、')}」` : '当前无临时状态可清除');
        }

        notes.push(...applyGaugeChanges(target, item.targetGaugeChanges, item.targetGaugeAChange, item.targetGaugeBChange, config));

        for (const entry of getApplyStatusEntries(item)) {
            const stText = tryApplyStatus(target, entry.statusId, entry.chance, config, actor);
            if (stText) notes.push(stText);
        }

        targetSummaries.push(`对 ${target.name} ${notes.length ? notes.join('，') : '生效'}`);
    }

    appendBattleLog(
        state,
        `${actor.name} 使用了道具「${item.name}」（剩余 ${item.quantity}）：${targetSummaries.join('；')}。`
    );
    for (const hitId of attackedIds) {
        releaseRestraintsByCaster(state, config, hitId, '受到道具攻击被打断');
    }

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

    const pStatusIds = Array.isArray(equip.passiveStatusIds)
        ? equip.passiveStatusIds
        : (equip.passiveStatusId ? [equip.passiveStatusId] : []);
    const buffNames = pStatusIds.map(id => findStatusDefById(config, id)?.name).filter(Boolean);
    const buffNote = buffNames.length ? `，获得常驻状态「${buffNames.join('、')}」` : '';
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

        // v1.7：被束缚的敌方自动尝试挣扎脱离
        if (isUnitRestrained(enemy, config)) {
            performStruggleAction(state, config, enemy, null);
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
    const gaugeEntries = getGaugeEntries(config);

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

                // 兼容 v1.2/v1.8 多属性与多自定义状态槽每回合变化
                const hpDelta = Math.round(Number(def.perTurnHp ?? (def.targetStat === 'hp' ? def.value : 0)) || 0);
                const mpDelta = Math.round(Number(def.perTurnMp ?? (def.targetStat === 'mp' ? def.value : 0)) || 0);
                const legacyGA = Math.round(Number(def.perTurnGaugeA ?? (def.targetStat === 'gauge_a' ? def.value : 0)) || 0);
                const legacyGB = Math.round(Number(def.perTurnGaugeB ?? (def.targetStat === 'gauge_b' ? def.value : 0)) || 0);

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
                tickNotes.push(...applyGaugeChanges(unit, def.perTurnGauges, legacyGA, legacyGB, config));

                if (tickNotes.length > 0) {
                    appendBattleLog(state, `${unit.name} 因「${def.name}」${tickNotes.join('，')}。`);
                }
                if (unit.hp <= 0) {
                    appendBattleLog(state, `${unit.name} 倒下了！`);
                    releaseRestraintsByCaster(state, config, unit.id, '因持续伤害倒下');
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
                    // v1.6：状态倒计时结束时，支持同时转化为多个新状态 (onExpireStatusIds)
                    const nextIds = Array.isArray(def.onExpireStatusIds)
                        ? def.onExpireStatusIds
                        : (def.onExpireStatusId ? [def.onExpireStatusId] : []);
                    const nextDefs = isAlive(unit)
                        ? nextIds.map(id => findStatusDefById(config, id)).filter(Boolean)
                        : [];
                    if (nextDefs.length > 0) {
                        for (const nd of nextDefs) {
                            transformedStatuses.push({
                                statusId: nd.id,
                                remainingTurns: nd.duration,
                                source: 'normal',
                            });
                        }
                        const namesStr = nextDefs.map(nd => `「${nd.name}」(${nd.duration}回合)`).join('、');
                        appendBattleLog(
                            state,
                            `${unit.name} 的状态「${def.name}」结束，转化为 ${namesStr}！`
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

        // 1.5 v1.6：每回合结束递减该单位所有技能冷却回合
        if (unit.cooldowns && typeof unit.cooldowns === 'object') {
            for (const skId of Object.keys(unit.cooldowns)) {
                unit.cooldowns[skId] = Math.max(0, (Number(unit.cooldowns[skId]) || 0) - 1);
                if (unit.cooldowns[skId] <= 0) delete unit.cooldowns[skId];
            }
        }

        // 2. v1.2/v1.8：结算全部自定义特殊状态条的每回合自动增减（仅对存活单位生效）
        if (isAlive(unit)) {
            const passiveGaugeNotes = [];
            for (const gDef of gaugeEntries) {
                if (shouldApplyGaugeTick(gDef, unit)) {
                    const note = applyGaugeDelta(unit, gDef.id, gDef.perTurnChange, config);
                    if (note) passiveGaugeNotes.push(note);
                }
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
    } else if (config?.gauges?.[stat]) {
        const gDef = config.gauges[stat];
        const gMin = Number.isFinite(Number(gDef.min)) ? Number(gDef.min) : 0;
        const gMax = Number.isFinite(Number(gDef.max)) ? Number(gDef.max) : 100;
        if (!unit.gauges || typeof unit.gauges !== 'object') unit.gauges = {};
        unit.gauges[stat] = clamp((unit.gauges[stat] ?? gMin) + num, gMin, gMax);
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
