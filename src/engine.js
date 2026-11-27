/**
 * 通用回合制战斗核心引擎 (src/engine.js)
 * 职责：
 * 1. 纯逻辑计算，严禁硬编码任何技能名、状态名、角色名或剧情文本
 * 2. 支持 1v1 ~ 4v4 回合制状态机：我方行动 -> 敌方行动 -> 回合结束结算
 * 3. 支持 4 类通用 Buff/Debuff 机制：每回合持续增减 HP/特殊槽、跳过回合、攻防倍率、倒计时自动移除
 * 4. 内置无 eval 的安全公式解析器，兼容 TauriTavern 严格 CSP 环境
 */

import { MAX_UNITS_PER_SIDE, clamp } from './config.js';

/**
 * =========================================================================
 * 一、安全数学公式解析器（无 eval / new Function，彻底规避 CSP 限制）
 * 支持：+ - * / ( )、数字、变量名，以及 max/min/floor/ceil/round/abs/rand 函数
 * 示例：max(1, atk * 1.5 - target_def * 0.4)
 * =========================================================================
 */

/**
 * 将公式字符串拆分为词法 Token
 * @param {string} expr
 * @returns {Array<{type: string, value: string}>}
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
        // 忽略无法识别的字符，保证不崩溃
        i++;
    }
    return tokens;
}

/**
 * 安全计算技能公式数值
 * @param {string} formula 公式字符串
 * @param {Record<string, number>} vars 变量字典（如 atk, target_def 等）
 * @returns {number}
 */
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
            if (op === '*') {
                left = left * right;
            } else {
                left = right === 0 ? 0 : left / right;
            }
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
            // 函数调用，如 max(a, b)
            if (peek() && peek().type === 'op' && peek().value === '(') {
                consume(); // '('
                const args = [];
                if (!(peek() && peek().type === 'op' && peek().value === ')')) {
                    args.push(parseExpression());
                    while (peek() && peek().type === 'op' && peek().value === ',') {
                        consume();
                        args.push(parseExpression());
                    }
                }
                if (peek() && peek().type === 'op' && peek().value === ')') {
                    consume(); // ')'
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

/**
 * 公式内置安全数学函数
 * @param {string} name
 * @param {number[]} args
 * @returns {number}
 */
function evalFormulaFunc(name, args) {
    switch (name) {
        case 'max':
            return args.length ? Math.max(...args) : 0;
        case 'min':
            return args.length ? Math.min(...args) : 0;
        case 'floor':
            return Math.floor(args[0] ?? 0);
        case 'ceil':
            return Math.ceil(args[0] ?? 0);
        case 'round':
            return Math.round(args[0] ?? 0);
        case 'abs':
            return Math.abs(args[0] ?? 0);
        case 'rand': {
            const min = args[0] ?? 0;
            const max = args[1] ?? 1;
            return min + Math.random() * (max - min);
        }
        default:
            return 0;
    }
}

/**
 * =========================================================================
 * 二、战斗数据初始化与辅助查询
 * =========================================================================
 */

/**
 * 将角色模板实例化为战斗中的实时单位对象
 * @param {object} tpl
 * @param {'ally'|'enemy'} side
 * @returns {object}
 */
function instantiateUnit(tpl, side) {
    return {
        id: tpl.id,
        side,
        name: tpl.name,
        maxHp: tpl.maxHp,
        hp: tpl.maxHp,
        maxMp: tpl.maxMp,
        mp: tpl.maxMp,
        baseAtk: tpl.atk,
        baseDef: tpl.def,
        gauges: {
            gauge_a: clamp(tpl.initialGaugeA ?? 0, 0, 100),
            gauge_b: clamp(tpl.initialGaugeB ?? 0, 0, 100),
        },
        skillIds: Array.isArray(tpl.skillIds) ? [...tpl.skillIds] : [],
        statuses: [], // [{ statusId, remainingTurns }]
        hasActed: false,
    };
}

/**
 * 根据配置创建全新的战斗状态（最多 4v4）
 * @param {object} config
 * @returns {object}
 */
export function createBattleState(config) {
    const enabledAllies = (config.allies || []).filter(u => u.enabled).slice(0, MAX_UNITS_PER_SIDE);
    const enabledEnemies = (config.enemies || []).filter(u => u.enabled).slice(0, MAX_UNITS_PER_SIDE);

    // 若用户把某一方全关闭了，兜底取第一个，避免空战场
    const allyTemplates = enabledAllies.length > 0 ? enabledAllies : (config.allies || []).slice(0, 1);
    const enemyTemplates = enabledEnemies.length > 0 ? enabledEnemies : (config.enemies || []).slice(0, 1);

    const allies = allyTemplates.map(u => instantiateUnit(u, 'ally'));
    const enemies = enemyTemplates.map(u => instantiateUnit(u, 'enemy'));

    const state = {
        active: true,
        turn: 1,
        phase: 'player_turn', // 'idle' | 'player_turn' | 'enemy_turn' | 'victory' | 'defeat'
        allies,
        enemies,
        selectedActorId: allies[0]?.id || '',
        selectedTargetId: enemies[0]?.id || '',
        currentRoundLogs: [], // 当前回合产生的战报条目
        allLogs: [],          // 历史战报（保留最近 100 条用于面板回顾）
    };

    appendLog(state, `战斗开始！我方 ${allies.length} 人 vs 敌方 ${enemies.length} 人（第 1 回合）。`);
    preparePlayerTurn(state, config);
    return state;
}

/**
 * 获取全部参战单位
 * @param {object} state
 * @returns {Array<object>}
 */
export function getAllUnits(state) {
    if (!state) return [];
    return [...(state.allies || []), ...(state.enemies || [])];
}

/**
 * 根据 ID 查找单位
 * @param {object} state
 * @param {string} unitId
 * @returns {object|undefined}
 */
export function findUnitById(state, unitId) {
    return getAllUnits(state).find(u => u.id === unitId);
}

/**
 * 根据 ID 查找技能定义
 * @param {object} config
 * @param {string} skillId
 * @returns {object|undefined}
 */
export function findSkillById(config, skillId) {
    return (config.skills || []).find(s => s.id === skillId);
}

/**
 * 根据 ID 查找状态模板定义
 * @param {object} config
 * @param {string} statusId
 * @returns {object|undefined}
 */
export function findStatusDefById(config, statusId) {
    return (config.statuses || []).find(s => s.id === statusId);
}

/**
 * 判断单位是否存活
 * @param {object} unit
 * @returns {boolean}
 */
export function isAlive(unit) {
    return Boolean(unit && unit.hp > 0);
}

/**
 * 计算单位叠加所有 Buff/Debuff 后的实时攻击力与防御力
 * @param {object} unit
 * @param {object} config
 * @returns {{ atk: number, def: number, atkMultiplier: number, defMultiplier: number, isStunned: boolean }}
 */
export function getEffectiveStats(unit, config) {
    let atkMultiplier = 1;
    let defMultiplier = 1;
    let isStunned = false;

    for (const activeSt of unit.statuses || []) {
        const def = findStatusDefById(config, activeSt.statusId);
        if (!def) continue;
        if (def.effectType === 'skip_turn') {
            isStunned = true;
        }
        if (def.effectType === 'stat_mod' || def.atkMultiplier !== 1 || def.defMultiplier !== 1) {
            if (Number.isFinite(def.atkMultiplier) && def.atkMultiplier > 0) {
                atkMultiplier *= def.atkMultiplier;
            }
            if (Number.isFinite(def.defMultiplier) && def.defMultiplier > 0) {
                defMultiplier *= def.defMultiplier;
            }
        }
    }

    return {
        atk: Math.max(0, Math.round(unit.baseAtk * atkMultiplier)),
        def: Math.max(0, Math.round(unit.baseDef * defMultiplier)),
        atkMultiplier: Number(atkMultiplier.toFixed(2)),
        defMultiplier: Number(defMultiplier.toFixed(2)),
        isStunned,
    };
}

/**
 * 追加一条战报日志
 * @param {object} state
 * @param {string} line
 */
function appendLog(state, line) {
    state.currentRoundLogs.push(line);
    state.allLogs.push(`[T${state.turn}] ${line}`);
    if (state.allLogs.length > 100) {
        state.allLogs = state.allLogs.slice(-100);
    }
}

/**
 * 修改单位某项特殊计量条，并返回变化描述
 * @param {object} unit
 * @param {'gauge_a'|'gauge_b'} gaugeKey
 * @param {number} delta
 * @param {object} config
 * @returns {string}
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
 * 尝试给单位挂载状态（若已存在同名状态则刷新持续回合数）
 * @param {object} target
 * @param {string} statusId
 * @param {number} chance 0~100
 * @param {object} config
 * @returns {string}
 */
function tryApplyStatus(target, statusId, chance, config) {
    if (!statusId || !isAlive(target)) return '';
    const def = findStatusDefById(config, statusId);
    if (!def) return '';

    const roll = Math.random() * 100;
    if (roll > clamp(chance ?? 100, 0, 100)) {
        return '';
    }

    const existing = target.statuses.find(s => s.statusId === statusId);
    if (existing) {
        existing.remainingTurns = Math.max(existing.remainingTurns, def.duration);
        return `刷新状态「${def.name}」(${existing.remainingTurns}回合)`;
    }

    target.statuses.push({
        statusId: def.id,
        remainingTurns: def.duration,
    });
    return `附加状态「${def.name}」(${def.duration}回合)`;
}

/**
 * =========================================================================
 * 三、技能结算与回合制状态机
 * =========================================================================
 */

/**
 * 解析技能的实际作用目标列表
 * @param {object} state
 * @param {object} actor
 * @param {object} skill
 * @param {string} requestedTargetId
 * @returns {Array<object>}
 */
function resolveSkillTargets(state, actor, skill, requestedTargetId) {
    const friends = actor.side === 'ally' ? state.allies : state.enemies;
    const foes = actor.side === 'ally' ? state.enemies : state.allies;
    const aliveFriends = friends.filter(isAlive);
    const aliveFoes = foes.filter(isAlive);

    switch (skill.targetType) {
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

/**
 * 执行一次单位技能释放（我方与敌方共用，彻底解耦）
 * @param {object} state
 * @param {object} config
 * @param {object} actor
 * @param {object} skill
 * @param {string} targetId
 * @returns {{ ok: boolean, message?: string, logs: string[] }}
 */
function performSkill(state, config, actor, skill, targetId) {
    const actionLogs = [];

    if (!isAlive(actor)) {
        return { ok: false, message: `${actor.name} 已失去战斗能力，无法行动。`, logs: actionLogs };
    }
    if (actor.mp < skill.mpCost) {
        return { ok: false, message: `${actor.name} 的 MP/体力不足（需要 ${skill.mpCost}，当前 ${actor.mp}）。`, logs: actionLogs };
    }

    const targets = resolveSkillTargets(state, actor, skill, targetId);
    if (targets.length === 0) {
        return { ok: false, message: '没有可生效的存活目标。', logs: actionLogs };
    }

    // 扣除消耗
    actor.mp = Math.max(0, actor.mp - skill.mpCost);
    actor.hasActed = true;

    const actorEff = getEffectiveStats(actor, config);
    const selfNotes = [];

    // 自身特殊计量条变化
    const selfGA = applyGaugeDelta(actor, 'gauge_a', skill.selfGaugeAChange, config);
    const selfGB = applyGaugeDelta(actor, 'gauge_b', skill.selfGaugeBChange, config);
    if (selfGA) selfNotes.push(selfGA);
    if (selfGB) selfNotes.push(selfGB);

    // 若状态施加对象是自身
    if (skill.applyStatusId && skill.applyStatusTarget === 'self') {
        const stText = tryApplyStatus(actor, skill.applyStatusId, skill.applyStatusChance, config);
        if (stText) selfNotes.push(stText);
    }

    const targetSummaries = [];

    for (const target of targets) {
        const targetEff = getEffectiveStats(target, config);
        const vars = {
            atk: actorEff.atk,
            def: actorEff.def,
            hp: actor.hp,
            max_hp: actor.maxHp,
            mp: actor.mp,
            max_mp: actor.maxMp,
            gauge_a: actor.gauges.gauge_a,
            gauge_b: actor.gauges.gauge_b,
            target_atk: targetEff.atk,
            target_def: targetEff.def,
            target_hp: target.hp,
            target_max_hp: target.maxHp,
            target_gauge_a: target.gauges.gauge_a,
            target_gauge_b: target.gauges.gauge_b,
        };

        const rawAmount = evaluateFormula(skill.formula, vars);
        const amount = Math.max(0, rawAmount);
        const notes = [];

        if (skill.effectType === 'damage') {
            target.hp = Math.max(0, target.hp - amount);
            notes.push(`造成 ${amount} 点伤害（剩余 HP ${target.hp}/${target.maxHp}）`);
            if (target.hp <= 0) {
                notes.push('倒下');
            }
        } else if (skill.effectType === 'heal') {
            const before = target.hp;
            target.hp = Math.min(target.maxHp, target.hp + amount);
            const healed = target.hp - before;
            notes.push(`回复 ${healed} 点 HP（当前 HP ${target.hp}/${target.maxHp}）`);
        } else if (skill.effectType === 'mp_restore') {
            const before = target.mp;
            target.mp = Math.min(target.maxMp, target.mp + amount);
            const restored = target.mp - before;
            notes.push(`回复 ${restored} 点 MP/体力（当前 ${target.mp}/${target.maxMp}）`);
        }

        // 目标特殊计量条变化
        const tGA = applyGaugeDelta(target, 'gauge_a', skill.targetGaugeAChange, config);
        const tGB = applyGaugeDelta(target, 'gauge_b', skill.targetGaugeBChange, config);
        if (tGA) notes.push(tGA);
        if (tGB) notes.push(tGB);

        // 附加状态给目标
        if (skill.applyStatusId && skill.applyStatusTarget !== 'self') {
            const stText = tryApplyStatus(target, skill.applyStatusId, skill.applyStatusChance, config);
            if (stText) notes.push(stText);
        }

        targetSummaries.push(`对 ${target.name} ${notes.length ? notes.join('，') : '生效'}`);
    }

    const mpNote = skill.mpCost > 0 ? `（消耗 ${skill.mpCost} MP）` : '';
    const selfSuffix = selfNotes.length ? `；自身：${selfNotes.join('，')}` : '';
    const line = `${actor.name} 使用了「${skill.name}」${mpNote}：${targetSummaries.join('；')}${selfSuffix}。`;

    appendLog(state, line);
    actionLogs.push(line);

    return { ok: true, logs: actionLogs };
}

/**
 * 检查是否达成胜利或失败条件
 * @param {object} state
 * @returns {boolean} 是否已结束战斗
 */
export function checkBattleOutcome(state) {
    const anyAllyAlive = state.allies.some(isAlive);
    const anyEnemyAlive = state.enemies.some(isAlive);

    if (!anyEnemyAlive && anyAllyAlive) {
        state.phase = 'victory';
        appendLog(state, '敌方全员失去战斗能力，我方取得胜利！');
        return true;
    }
    if (!anyAllyAlive) {
        state.phase = 'defeat';
        appendLog(state, '我方全员生命值归零，战斗失败！');
        return true;
    }
    return false;
}

/**
 * 自动刷新 HUD 选中的当前行动者与瞄准目标（防止指向倒下或已行动角色）
 * @param {object} state
 */
export function syncDefaultSelections(state) {
    const readyAlly = state.allies.find(u => isAlive(u) && !u.hasActed)
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

/**
 * 准备我方回合：重置已行动标记，并处理眩晕/跳过回合状态
 * @param {object} state
 * @param {object} config
 */
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
            appendLog(state, `${ally.name} 处于行动受限状态，跳过本回合行动！`);
        } else {
            ally.hasActed = false;
        }
    }
    syncDefaultSelections(state);
}

/**
 * 玩家点击释放技能入口
 * @param {object} state
 * @param {object} config
 * @param {string} actorId
 * @param {string} skillId
 * @param {string} targetId
 * @returns {{ ok: boolean, message?: string, newLogs: string[] }}
 */
export function executeAllyAction(state, config, actorId, skillId, targetId) {
    if (!state || !state.active) {
        return { ok: false, message: '请先开始战斗。', newLogs: [] };
    }
    if (state.phase !== 'player_turn') {
        return { ok: false, message: '当前不是我方行动阶段。', newLogs: [] };
    }

    const actor = state.allies.find(u => u.id === actorId);
    if (!actor) {
        return { ok: false, message: '请先选择一名我方角色。', newLogs: [] };
    }
    if (actor.hasActed) {
        return { ok: false, message: `${actor.name} 本回合已经行动过了。`, newLogs: [] };
    }

    const skill = findSkillById(config, skillId);
    if (!skill) {
        return { ok: false, message: '未找到对应的技能配置。', newLogs: [] };
    }

    const logStartIndex = state.currentRoundLogs.length;
    const res = performSkill(state, config, actor, skill, targetId);
    if (!res.ok) {
        return { ok: false, message: res.message, newLogs: [] };
    }

    if (checkBattleOutcome(state)) {
        syncDefaultSelections(state);
        return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
    }

    // 检查是否所有存活我方角色均已行动完毕
    const hasRemainingActor = state.allies.some(u => isAlive(u) && !u.hasActed);
    if (!hasRemainingActor && config.general?.autoEndPlayerTurn !== false) {
        runEnemyTurnAndRoundEnd(state, config);
    } else {
        syncDefaultSelections(state);
    }

    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

/**
 * 玩家手动点击“结束我方回合”
 * @param {object} state
 * @param {object} config
 * @returns {{ ok: boolean, message?: string, newLogs: string[] }}
 */
export function endPlayerTurn(state, config) {
    if (!state || !state.active) {
        return { ok: false, message: '请先开始战斗。', newLogs: [] };
    }
    if (state.phase !== 'player_turn') {
        return { ok: false, message: '当前战斗已结束或不在我方回合。', newLogs: [] };
    }

    const logStartIndex = state.currentRoundLogs.length;
    runEnemyTurnAndRoundEnd(state, config);
    return { ok: true, newLogs: state.currentRoundLogs.slice(logStartIndex) };
}

/**
 * 执行敌方行动阶段 + 回合结束结算 + 进入下一回合
 * @param {object} state
 * @param {object} config
 */
function runEnemyTurnAndRoundEnd(state, config) {
    state.phase = 'enemy_turn';

    // 1. 敌方行动阶段
    for (const enemy of state.enemies) {
        if (!isAlive(enemy)) continue;
        if (checkBattleOutcome(state)) return;

        const eff = getEffectiveStats(enemy, config);
        if (eff.isStunned) {
            appendLog(state, `${enemy.name} 处于行动受限状态，跳过本回合行动！`);
            continue;
        }

        // 从该敌人的技能列表中筛选当前 MP 足够释放的技能
        const candidateSkills = (enemy.skillIds || [])
            .map(id => findSkillById(config, id))
            .filter(sk => sk && enemy.mp >= sk.mpCost);

        // 若该敌人没配可用技能，则兜底找一个 0 消耗的技能
        const fallbackSkill = (config.skills || []).find(sk => sk.mpCost <= enemy.mp);
        const chosenSkill = candidateSkills.length > 0
            ? candidateSkills[Math.floor(Math.random() * candidateSkills.length)]
            : fallbackSkill;

        if (!chosenSkill) {
            appendLog(state, `${enemy.name} 体力不足，本回合原地待命。`);
            continue;
        }

        // 敌方目标智能挑选：友方治疗优先给血量最低的同伴，攻击则随机挑存活我方角色
        let chosenTargetId = '';
        if (chosenSkill.targetType === 'single_ally') {
            const aliveEnemyAllies = state.enemies.filter(isAlive).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
            chosenTargetId = aliveEnemyAllies[0]?.id || enemy.id;
        } else if (chosenSkill.targetType === 'single_enemy') {
            const alivePlayers = state.allies.filter(isAlive);
            if (alivePlayers.length > 0) {
                chosenTargetId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].id;
            }
        } else if (chosenSkill.targetType === 'self') {
            chosenTargetId = enemy.id;
        }

        performSkill(state, config, enemy, chosenSkill, chosenTargetId);
        if (checkBattleOutcome(state)) return;
    }

    // 2. 回合结束结算（所有单位的 Buff/Debuff 跳血/特殊槽变化 + 回合倒计时归零移除）
    runRoundEndSettlement(state, config);
    if (checkBattleOutcome(state)) return;

    // 3. 进入下一回合
    state.turn += 1;
    appendLog(state, `—— 进入第 ${state.turn} 回合 ——`);
    preparePlayerTurn(state, config);
}

/**
 * 回合结束结算：处理每回合持续效果与倒计时移除
 * @param {object} state
 * @param {object} config
 */
function runRoundEndSettlement(state, config) {
    const allUnits = getAllUnits(state);

    for (const unit of allUnits) {
        if (!isAlive(unit) || !unit.statuses || unit.statuses.length === 0) continue;

        const remainingStatuses = [];

        for (const activeSt of unit.statuses) {
            const def = findStatusDefById(config, activeSt.statusId);
            if (!def) continue;

            // 模板 1（以及任何带有持续数值的状态）：每回合持续增减 HP / MP / 特殊计量条
            if ((def.effectType === 'dot_hot' || def.value !== 0) && Number(def.value) !== 0) {
                const val = Math.round(Number(def.value));
                if (def.targetStat === 'hp') {
                    const before = unit.hp;
                    unit.hp = clamp(unit.hp + val, 0, unit.maxHp);
                    const diff = unit.hp - before;
                    if (diff < 0) {
                        appendLog(state, `${unit.name} 因「${def.name}」受到 ${Math.abs(diff)} 点持续伤害（HP ${unit.hp}/${unit.maxHp}）。`);
                    } else if (diff > 0) {
                        appendLog(state, `${unit.name} 因「${def.name}」回复 ${diff} 点 HP（HP ${unit.hp}/${unit.maxHp}）。`);
                    }
                    if (unit.hp <= 0) {
                        appendLog(state, `${unit.name} 倒下了！`);
                    }
                } else if (def.targetStat === 'mp') {
                    const before = unit.mp;
                    unit.mp = clamp(unit.mp + val, 0, unit.maxMp);
                    const diff = unit.mp - before;
                    if (diff !== 0) {
                        appendLog(state, `${unit.name} 因「${def.name}」MP/体力 ${diff > 0 ? '+' : ''}${diff}（${unit.mp}/${unit.maxMp}）。`);
                    }
                } else if (def.targetStat === 'gauge_a' || def.targetStat === 'gauge_b') {
                    const note = applyGaugeDelta(unit, def.targetStat, val, config);
                    if (note) {
                        appendLog(state, `${unit.name} 因「${def.name}」${note}。`);
                    }
                }
            }

            // 模板 4：持续回合数倒计时，归零自动移除
            activeSt.remainingTurns -= 1;
            if (activeSt.remainingTurns > 0) {
                remainingStatuses.push(activeSt);
            } else {
                appendLog(state, `${unit.name} 身上的状态「${def.name}」已失效移除。`);
            }
        }

        unit.statuses = remainingStatuses;
    }
}

/**
 * 格式化输出战报文本（用于复制到剪贴板或填入酒馆输入框）
 * @param {object} state
 * @param {object} config
 * @param {string[]} lines 指定要格式化的行；若不传则导出本回合全部记录
 * @returns {string}
 */
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

/**
 * TRPG 跑团便捷微调：允许玩家/GM 在 HUD 上手动微调任意单位的 HP/MP/特殊槽
 * @param {object} state
 * @param {object} config
 * @param {string} unitId
 * @param {'hp'|'mp'|'gauge_a'|'gauge_b'} stat
 * @param {number} delta
 * @returns {boolean}
 */
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

    // 手动改血后重新检查胜负状态（若复活则恢复我方回合）
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
