/**
 * MVU Zod 双向变量联动桥接模块 (src/mvu_bridge.js) - v1.4
 * 职责：
 * 1. 纯前端三层兼容读写（Mvu API -> TavernHelper API -> 聊天楼层 variables[swipe_id].stat_data）
 * 2. 仅读写约定的轻量标准区块 stat_data.combat，绝不触碰卡片的「时间 / 好感度 / 内心想法」等其他变量
 * 3. 不同步沉重的 Buff 列表，仅同步轻量战斗状态：
 *    - combat.in_combat (boolean：是否正在战斗中，可选供前端状态栏展示)
 *    - combat.allies[id]: { hp, mp, gauge_a, gauge_b, equipmentIds, skillIds }
 *    - combat.items[id]: number (道具库存数量)
 *    - combat.encounter_enemy_ids: string[] (AI 遇敌请求，确认或忽略后自动清空)
 *    - combat.reinforce_enemy_ids: string[] (AI 战中增援请求，确认或忽略后自动清空)
 */

import { MAX_UNITS_PER_SIDE, clamp, deepClone, getGaugeEntries, getSTContext } from './config.js';
import { findClassById, findEquipmentById, findItemById, findSkillById, findStatusDefById, syncUnitEquipmentEffects } from './engine.js';

/**
 * 将 MVU 里的 statuses 数组解析为合法的普通临时状态列表
 * 兼容对象 { id, turns, source? } 与简写字符串 "debuff_01"
 */
function parseMvuNormalStatuses(rawStatuses, config) {
    if (!Array.isArray(rawStatuses)) return [];
    const result = [];
    const seen = new Set();
    for (const entry of rawStatuses) {
        if (!entry) continue;
        // 跳过由装备或阈值自动派生出的状态（避免重复，它们会由引擎自动重建）
        if (typeof entry === 'object' && (entry.source === 'equipment' || entry.source === 'threshold')) {
            continue;
        }
        const statusId = typeof entry === 'string' ? entry.trim() : String(entry.id || entry.statusId || '').trim();
        if (!statusId || seen.has(statusId)) continue;
        const def = findStatusDefById(config, statusId);
        if (!def) continue;
        const turnsRaw = typeof entry === 'object' ? (entry.turns ?? entry.remainingTurns ?? def.duration) : def.duration;
        const remainingTurns = Math.max(1, Math.round(Number(turnsRaw) || def.duration));
        seen.add(statusId);
        result.push({
            statusId: def.id,
            remainingTurns,
            source: 'normal',
            ...(typeof entry === 'object' && entry.casterId ? { casterId: String(entry.casterId) } : {}),
        });
    }
    return result;
}

/**
 * 将单位当前全部活跃状态序列化为精简 MVU Zod 数组 [{ id, name, turns, source, casterId? }]
 */
function serializeStatusesForMvu(statuses, config) {
    if (!Array.isArray(statuses)) return [];
    const out = [];
    for (const st of statuses) {
        const def = findStatusDefById(config, st.statusId);
        if (!def) continue;
        const item = {
            id: def.id,
            name: def.name,
            turns: Math.max(1, Math.round(Number(st.remainingTurns) || def.duration)),
            source: st.source || 'normal',
        };
        if (st.casterId) item.casterId = st.casterId;
        out.push(item);
    }
    return out;
}

/**
 * 找到当前聊天中最新一条存在（或可挂载）变量的楼层索引及 swipe_id
 * @param {object} ctx
 * @returns {{ messageIndex: number, swipeId: number } | null}
 */
function findLatestVariableFloor(ctx) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (chat.length === 0) return null;

    // 优先找最新一条已有 stat_data 的楼层
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || !Array.isArray(msg.variables)) continue;
        const swipeId = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
        const slot = msg.variables[swipeId] || msg.variables[0];
        if (slot && slot.stat_data && typeof slot.stat_data === 'object') {
            return { messageIndex: i, swipeId: msg.variables[swipeId] ? swipeId : 0 };
        }
    }

    // 兜底返回最新一条消息
    const lastIdx = chat.length - 1;
    const lastMsg = chat[lastIdx];
    const swipeId = Number.isInteger(lastMsg?.swipe_id) ? lastMsg.swipe_id : 0;
    return { messageIndex: lastIdx, swipeId };
}

/**
 * 读取当前聊天的 MVU stat_data 对象（三层兼容，支持区分「无 stat_data」与「有 stat_data 但缺 combat」）
 * @returns {{ statData: object, hasCombat: boolean, combat: object|null, source: string, messageIndex: number, swipeId: number, rawMvuData?: object } | null}
 */
export function readMvuStatDataRecord() {
    const ctx = getSTContext();
    const floor = findLatestVariableFloor(ctx);
    const msgId = floor ? floor.messageIndex : -1;

    // 第 1 层：优先使用 MagVarUpdate (window.Mvu) 官方接口
    try {
        const Mvu = typeof window !== 'undefined' ? window.Mvu : null;
        if (Mvu && typeof Mvu.getMvuData === 'function' && msgId >= 0) {
            const mvuData = Mvu.getMvuData({ type: 'message', message_id: msgId });
            if (mvuData?.stat_data && typeof mvuData.stat_data === 'object') {
                const hasCombat = Boolean(mvuData.stat_data.combat && typeof mvuData.stat_data.combat === 'object');
                return {
                    statData: mvuData.stat_data,
                    hasCombat,
                    combat: hasCombat ? deepClone(mvuData.stat_data.combat) : null,
                    source: 'Mvu',
                    messageIndex: msgId,
                    swipeId: floor.swipeId,
                    rawMvuData: mvuData,
                };
            }
        }
    } catch (err) {
        console.warn('[CombatFramework] Mvu.getMvuData 读取失败，尝试降级:', err);
    }

    // 第 2 层：尝试使用酒馆助手 TavernHelper.getVariables
    try {
        const TH = typeof window !== 'undefined' ? window.TavernHelper : null;
        if (TH && typeof TH.getVariables === 'function') {
            const msgVars = msgId >= 0 ? TH.getVariables({ type: 'message', message_id: msgId }) : null;
            if (msgVars?.stat_data && typeof msgVars.stat_data === 'object') {
                const hasCombat = Boolean(msgVars.stat_data.combat && typeof msgVars.stat_data.combat === 'object');
                return {
                    statData: msgVars.stat_data,
                    hasCombat,
                    combat: hasCombat ? deepClone(msgVars.stat_data.combat) : null,
                    source: 'TavernHelper_message',
                    messageIndex: msgId,
                    swipeId: floor?.swipeId ?? 0,
                };
            }
            const chatVars = TH.getVariables({ type: 'chat' });
            if (chatVars?.stat_data && typeof chatVars.stat_data === 'object') {
                const hasCombat = Boolean(chatVars.stat_data.combat && typeof chatVars.stat_data.combat === 'object');
                return {
                    statData: chatVars.stat_data,
                    hasCombat,
                    combat: hasCombat ? deepClone(chatVars.stat_data.combat) : null,
                    source: 'TavernHelper_chat',
                    messageIndex: msgId,
                    swipeId: floor?.swipeId ?? 0,
                };
            }
        }
    } catch (err) {
        console.warn('[CombatFramework] TavernHelper.getVariables 读取失败，尝试降级:', err);
    }

    // 第 3 层：直接从 SillyTavern 原生 chat[i].variables[swipe_id] 或 chatMetadata.variables 读取
    try {
        if (floor && Array.isArray(ctx.chat)) {
            const msg = ctx.chat[floor.messageIndex];
            const slot = msg?.variables?.[floor.swipeId];
            if (slot?.stat_data && typeof slot.stat_data === 'object') {
                const hasCombat = Boolean(slot.stat_data.combat && typeof slot.stat_data.combat === 'object');
                return {
                    statData: slot.stat_data,
                    hasCombat,
                    combat: hasCombat ? deepClone(slot.stat_data.combat) : null,
                    source: 'chat_variables',
                    messageIndex: floor.messageIndex,
                    swipeId: floor.swipeId,
                };
            }
        }
        if (ctx.chatMetadata?.variables?.stat_data && typeof ctx.chatMetadata.variables.stat_data === 'object') {
            const hasCombat = Boolean(ctx.chatMetadata.variables.stat_data.combat && typeof ctx.chatMetadata.variables.stat_data.combat === 'object');
            return {
                statData: ctx.chatMetadata.variables.stat_data,
                hasCombat,
                combat: hasCombat ? deepClone(ctx.chatMetadata.variables.stat_data.combat) : null,
                source: 'chatMetadata',
                messageIndex: msgId,
                swipeId: floor?.swipeId ?? 0,
            };
        }
    } catch (err) {
        console.warn('[CombatFramework] 原生楼层变量读取失败:', err);
    }

    return null;
}

/**
 * 读取当前聊天的 MVU stat_data.combat 区块（仅在 combat 存在时返回）
 * @returns {{ statData: object, combat: object, source: string, messageIndex: number, swipeId: number, rawMvuData?: object } | null}
 */
export function readMvuCombatBlock() {
    const rec = readMvuStatDataRecord();
    if (!rec || !rec.hasCombat) return null;
    return rec;
}

/**
 * 诊断当前聊天的 MVU 变量状态：区分「正常」「已有 stat_data 但缺少 combat」「完全未检测到 stat_data」
 */
export function diagnoseMvuCombatState() {
    const rec = readMvuStatDataRecord();
    if (!rec) {
        return { status: 'no_stat_data', existingKeys: [], source: '', messageIndex: -1 };
    }
    if (!rec.hasCombat) {
        return {
            status: 'missing_combat',
            existingKeys: Object.keys(rec.statData || {}).filter(k => !k.startsWith('$')),
            source: rec.source,
            messageIndex: rec.messageIndex,
        };
    }
    return {
        status: 'ok',
        existingKeys: Object.keys(rec.statData || {}).filter(k => !k.startsWith('$')),
        source: rec.source,
        messageIndex: rec.messageIndex,
    };
}

/**
 * 将最新的 combat 区块安全写回 MVU Zod（绝不破坏 stat_data 里的其他变量）
 * @param {object} nextCombatBlock
 * @param {{ allowCreateCombat?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function writeMvuCombatBlock(nextCombatBlock, options = {}) {
    const existing = options.allowCreateCombat ? readMvuStatDataRecord() : readMvuCombatBlock();
    if (!existing) return false; // 当前角色卡未定义 stat_data（或未开启自动补建时缺少 combat），静默跳过

    const ctx = getSTContext();
    const mergedCombat = {
        ...(existing.combat || {}),
        ...nextCombatBlock,
    };

    // 第 1 层：优先使用 window.Mvu.replaceMvuData
    try {
        const Mvu = typeof window !== 'undefined' ? window.Mvu : null;
        if (existing.source === 'Mvu' && Mvu && typeof Mvu.replaceMvuData === 'function' && existing.rawMvuData) {
            const nextMvu = deepClone(existing.rawMvuData);
            nextMvu.stat_data.combat = mergedCombat;
            await Mvu.replaceMvuData(nextMvu, { type: 'message', message_id: existing.messageIndex });
            return true;
        }
    } catch (err) {
        console.warn('[CombatFramework] Mvu.replaceMvuData 写回失败，尝试降级:', err);
    }

    // 第 2 层：尝试使用 TavernHelper.insertOrAssignVariables
    try {
        const TH = typeof window !== 'undefined' ? window.TavernHelper : null;
        if (TH && typeof TH.insertOrAssignVariables === 'function') {
            const targetOpt = existing.source === 'TavernHelper_chat'
                ? { type: 'chat' }
                : { type: 'message', message_id: existing.messageIndex };
            await TH.insertOrAssignVariables({ stat_data: { combat: mergedCombat } }, targetOpt);
            return true;
        }
    } catch (err) {
        console.warn('[CombatFramework] TavernHelper.insertOrAssignVariables 写回失败，尝试降级:', err);
    }

    // 第 3 层：直接写回 chat[i].variables[swipe_id].stat_data.combat 或 chatMetadata
    try {
        if (existing.source === 'chatMetadata' && ctx.chatMetadata?.variables?.stat_data) {
            ctx.chatMetadata.variables.stat_data.combat = mergedCombat;
            ctx.saveMetadata?.();
            return true;
        }
        if (existing.messageIndex >= 0 && Array.isArray(ctx.chat)) {
            const msg = ctx.chat[existing.messageIndex];
            const slot = msg?.variables?.[existing.swipeId];
            if (slot?.stat_data) {
                slot.stat_data.combat = mergedCombat;
                ctx.saveChat?.();
                return true;
            }
        }
    } catch (err) {
        console.warn('[CombatFramework] 原生楼层变量写回失败:', err);
    }

    return false;
}

/**
 * 方向 1：从 MVU Zod (stat_data.combat) 拉取最新状态同步到战斗插件
 * - 同步我方角色装备、技能、实时 HP/MP/状态槽
 * - 同步背包道具库存数量
 * - 提取 encounter_enemy_ids / reinforce_enemy_ids 转为 HUD 待确认事件
 *
 * @param {object} config
 * @param {object|null} battleState
 * @returns {{ found: boolean, changed: boolean, events: Array<object>, summary: string }}
 */
export function pullFromMvuZod(config, battleState) {
    if (!config?.general?.mvuSyncEnabled) {
        return { found: false, changed: false, events: [], summary: '' };
    }

    const record = readMvuCombatBlock();
    if (!record || !record.combat) {
        return { found: false, changed: false, events: [], summary: '' };
    }

    const combat = record.combat;
    let changed = false;
    const notes = [];
    const events = [];

    // 1. 同步我方角色（装备、技能、以及战斗中的 HP/MP/状态槽）
    if (combat.allies && typeof combat.allies === 'object') {
        for (const [allyId, mvuAlly] of Object.entries(combat.allies)) {
            if (!mvuAlly || typeof mvuAlly !== 'object') continue;
            const tpl = (config.allies || []).find(a => a.id === allyId);
            const live = battleState?.active ? (battleState.allies || []).find(a => a.id === allyId) : null;

            // v1.5：同步等级（若剧情修炼使等级提升且 MVU 未手动增加 freePoints，则自动补发每级自由属性点）、职业与自由加点
            let autoAwardedPoints = false;
            if (tpl && Number.isFinite(Number(mvuAlly.level))) {
                const nextLv = Math.max(1, Math.round(Number(mvuAlly.level)));
                const prevLv = Math.max(1, Number(tpl.level) || 1);
                if (nextLv !== prevLv) {
                    const prevFree = Number(tpl.freePoints) || 0;
                    const mvuFreeProvided = Number.isFinite(Number(mvuAlly.freePoints));
                    const mvuFreeVal = mvuFreeProvided ? Math.max(0, Math.round(Number(mvuAlly.freePoints))) : prevFree;
                    tpl.level = nextLv;
                    // 若等级提高且 MVU 里的 freePoints 没跟着涨，自动按每级自由点补发
                    if (nextLv > prevLv && (!mvuFreeProvided || mvuFreeVal === prevFree)) {
                        const ptsPerLv = Math.max(0, Math.round(Number(config?.progression?.pointsPerLevel ?? 3) || 0));
                        tpl.freePoints = prevFree + (nextLv - prevLv) * ptsPerLv;
                        autoAwardedPoints = true;
                    }
                    if (live) {
                        live.level = tpl.level;
                        live.freePoints = tpl.freePoints;
                        syncUnitEquipmentEffects(live, config, false);
                    }
                    changed = true;
                    notes.push(`${tpl.name}Lv.${nextLv}`);
                }
            }
            if (tpl && !autoAwardedPoints && Number.isFinite(Number(mvuAlly.freePoints))) {
                const mvuFree = Math.max(0, Math.round(Number(mvuAlly.freePoints)));
                if (mvuFree !== (Number(tpl.freePoints) || 0)) {
                    tpl.freePoints = mvuFree;
                    if (live) live.freePoints = mvuFree;
                    changed = true;
                }
            }
            if (tpl && typeof mvuAlly.classId === 'string') {
                const nextCls = mvuAlly.classId.trim();
                if ((!nextCls || findClassById(config, nextCls)) && tpl.classId !== nextCls) {
                    tpl.classId = nextCls;
                    if (live) {
                        live.classId = nextCls;
                        syncUnitEquipmentEffects(live, config, false);
                    }
                    changed = true;
                    notes.push(`${tpl.name}职业`);
                }
            }
            if (tpl && mvuAlly.allocated && typeof mvuAlly.allocated === 'object') {
                const nextAlloc = {
                    vit: Math.max(0, Math.round(Number(mvuAlly.allocated.vit ?? 0) || 0)),
                    str: Math.max(0, Math.round(Number(mvuAlly.allocated.str ?? 0) || 0)),
                    spi: Math.max(0, Math.round(Number(mvuAlly.allocated.spi ?? 0) || 0)),
                    def: Math.max(0, Math.round(Number(mvuAlly.allocated.def ?? 0) || 0)),
                    mdef: Math.max(0, Math.round(Number(mvuAlly.allocated.mdef ?? 0) || 0)),
                };
                if (JSON.stringify(tpl.allocated || {}) !== JSON.stringify(nextAlloc)) {
                    tpl.allocated = nextAlloc;
                    if (live) {
                        live.allocated = { ...nextAlloc };
                        syncUnitEquipmentEffects(live, config, false);
                    }
                    changed = true;
                }
            }

            // 同步穿戴装备（仅采纳装备库里存在的合法 ID）
            if (Array.isArray(mvuAlly.equipmentIds)) {
                const validEquips = [...new Set(mvuAlly.equipmentIds.map(String).filter(id => Boolean(findEquipmentById(config, id))))];
                if (tpl && JSON.stringify(tpl.equipmentIds || []) !== JSON.stringify(validEquips)) {
                    tpl.equipmentIds = [...validEquips];
                    changed = true;
                    notes.push(`${tpl.name}装备`);
                }
                if (live && JSON.stringify(live.equipmentIds || []) !== JSON.stringify(validEquips)) {
                    live.equipmentIds = [...validEquips];
                    syncUnitEquipmentEffects(live, config, false);
                    changed = true;
                }
            }

            // 同步已学会技能（仅采纳技能库里存在的合法 ID）
            if (Array.isArray(mvuAlly.skillIds)) {
                const validSkills = [...new Set(mvuAlly.skillIds.map(String).filter(id => Boolean(findSkillById(config, id))))];
                if (tpl && JSON.stringify(tpl.skillIds || []) !== JSON.stringify(validSkills)) {
                    tpl.skillIds = [...validSkills];
                    changed = true;
                    notes.push(`${tpl.name}技能`);
                }
                if (live && JSON.stringify(live.skillIds || []) !== JSON.stringify(validSkills)) {
                    live.skillIds = [...validSkills];
                    changed = true;
                }
            }

            // 若当前在战斗中，同步 MVU 里的实时 HP/MP/状态槽（支持剧情中途外部治疗/受伤或滑卡回滚）
            if (live) {
                if (Number.isFinite(Number(mvuAlly.hp))) {
                    const nextHp = clamp(Math.round(Number(mvuAlly.hp)), 0, live.maxHp);
                    if (live.hp !== nextHp) { live.hp = nextHp; changed = true; }
                }
                if (Number.isFinite(Number(mvuAlly.mp))) {
                    const nextMp = clamp(Math.round(Number(mvuAlly.mp)), 0, live.maxMp);
                    if (live.mp !== nextMp) { live.mp = nextMp; changed = true; }
                }
                if (!live.gauges || typeof live.gauges !== 'object') live.gauges = {};
                for (const gDef of getGaugeEntries(config)) {
                    const rawVal = mvuAlly.gauges?.[gDef.id] !== undefined ? mvuAlly.gauges[gDef.id] : mvuAlly[gDef.id];
                    if (Number.isFinite(Number(rawVal))) {
                        const nextG = clamp(Math.round(Number(rawVal)), gDef.min, gDef.max);
                        if (live.gauges[gDef.id] !== nextG) {
                            live.gauges[gDef.id] = nextG;
                            changed = true;
                        }
                    }
                }

                // 同步 MVU 中的临时 Buff/Debuff（保留由装备/阈值派生的状态）
                if (config.general?.mvuSyncStatuses !== false && Array.isArray(mvuAlly.statuses)) {
                    const incomingNormal = parseMvuNormalStatuses(mvuAlly.statuses, config);
                    const prevNormal = (live.statuses || []).filter(s => !s.source || s.source === 'normal');
                    const prevSig = JSON.stringify(prevNormal.map(s => [s.statusId, s.remainingTurns]));
                    const nextSig = JSON.stringify(incomingNormal.map(s => [s.statusId, s.remainingTurns]));
                    if (prevSig !== nextSig) {
                        const nonNormal = (live.statuses || []).filter(s => s.source === 'equipment' || s.source === 'threshold');
                        live.statuses = [...nonNormal, ...incomingNormal];
                        changed = true;
                        notes.push(`${live.name}状态`);
                    }
                }
            }
        }
    }

    // 2. 同步道具背包库存数量
    if (combat.items && typeof combat.items === 'object') {
        for (const [itemId, qty] of Object.entries(combat.items)) {
            const item = findItemById(config, itemId);
            if (!item || !Number.isFinite(Number(qty))) continue;
            const nextQty = Math.max(0, Math.round(Number(qty)));
            if (item.quantity !== nextQty) {
                item.quantity = nextQty;
                changed = true;
                notes.push(`${item.name}×${nextQty}`);
            }
        }
    }

    // 3. 检测 AI 通过 MVU 写入的遇敌开战列表 (encounter_enemy_ids)
    if (Array.isArray(combat.encounter_enemy_ids) && combat.encounter_enemy_ids.length > 0) {
        const enemyIds = combat.encounter_enemy_ids.map(String).filter(Boolean).slice(0, MAX_UNITS_PER_SIDE);
        if (enemyIds.length > 0) {
            events.push({
                uid: `mvu_enc_${enemyIds.join('_')}`,
                type: 'start_combat',
                enemyIds,
                enemies: [],
                fromMvuField: 'encounter_enemy_ids',
            });
        }
    }

    // 4. 检测 AI 通过 MVU 写入的战斗增援列表 (reinforce_enemy_ids)
    if (Array.isArray(combat.reinforce_enemy_ids) && combat.reinforce_enemy_ids.length > 0) {
        const enemyIds = combat.reinforce_enemy_ids.map(String).filter(Boolean).slice(0, MAX_UNITS_PER_SIDE);
        if (enemyIds.length > 0) {
            events.push({
                uid: `mvu_reinf_${enemyIds.join('_')}`,
                type: 'add_enemy',
                enemyIds,
                enemies: [],
                fromMvuField: 'reinforce_enemy_ids',
            });
        }
    }

    return {
        found: true,
        changed,
        events,
        summary: notes.length ? `已从 MVU Zod 同步：${notes.join('、')}` : '已与 MVU Zod 保持一致',
    };
}

/**
 * 开战初始化时：如果开启了“继承 MVU 当前血量/蓝量/状态槽”，自动把日常剧情里的残血/状态带入新战斗
 * @param {object} battleState
 * @param {object} config
 */
export function applyMvuVitalsOnBattleStart(battleState, config) {
    if (!config?.general?.mvuSyncEnabled || !config?.general?.mvuInheritVitalsOnStart || !battleState?.active) {
        return;
    }
    const record = readMvuCombatBlock();
    const mvuAllies = record?.combat?.allies;
    if (!mvuAllies || typeof mvuAllies !== 'object') return;

    for (const ally of battleState.allies || []) {
        const src = mvuAllies[ally.id];
        if (!src || typeof src !== 'object') continue;
        if (Number.isFinite(Number(src.hp)) && Number(src.hp) > 0) {
            ally.hp = clamp(Math.round(Number(src.hp)), 1, ally.maxHp);
        }
        if (Number.isFinite(Number(src.mp))) {
            ally.mp = clamp(Math.round(Number(src.mp)), 0, ally.maxMp);
        }
        if (!ally.gauges || typeof ally.gauges !== 'object') ally.gauges = {};
        for (const gDef of getGaugeEntries(config)) {
            const rawVal = src.gauges?.[gDef.id] !== undefined ? src.gauges[gDef.id] : src[gDef.id];
            if (Number.isFinite(Number(rawVal))) {
                ally.gauges[gDef.id] = clamp(Math.round(Number(rawVal)), gDef.min, gDef.max);
            }
        }
        // 若日常剧情里通过 MVU 挂上了临时异常/增益状态，开战时自动带入战场
        if (config.general?.mvuSyncStatuses !== false && Array.isArray(src.statuses)) {
            const incomingNormal = parseMvuNormalStatuses(src.statuses, config);
            const nonNormal = (ally.statuses || []).filter(s => s.source === 'equipment' || s.source === 'threshold');
            ally.statuses = [...nonNormal, ...incomingNormal];
        }
    }
}

/**
 * 方向 2：将战斗插件的最新轻量结果写回 MVU Zod (stat_data.combat)
 * 不同步 Buff，仅写回：in_combat、我方 HP/MP/状态槽/装备/技能、道具剩余数量
 *
 * @param {object} config
 * @param {object|null} battleState
 * @param {{ clearMvuField?: 'encounter_enemy_ids'|'reinforce_enemy_ids'|'' }} [options]
 * @returns {Promise<boolean>}
 */
export async function pushToMvuZod(config, battleState, options = {}) {
    if (!config?.general?.mvuSyncEnabled || !config?.general?.mvuWriteBack) {
        return false;
    }

    const existing = readMvuCombatBlock();
    if (!existing) return false;

    const prevCombat = existing.combat || {};
    const nextAllies = deepClone(prevCombat.allies || {});
    const isFighting = Boolean(
        battleState?.active && battleState.phase !== 'victory' && battleState.phase !== 'defeat'
    );

    for (const tpl of config.allies || []) {
        const live = battleState?.active ? (battleState.allies || []).find(a => a.id === tpl.id) : null;
        // 仅写回 MVU 里原本追踪的或已启用出战的我方角色
        if (!nextAllies[tpl.id] && !tpl.enabled && !live) continue;

        const prevAlly = nextAllies[tpl.id] || {};
        const gaugeEntries = getGaugeEntries(config);
        const nextGaugesMap = {};
        for (const gDef of gaugeEntries) {
            const fallbackInit = tpl.initialGauges?.[gDef.id]
                ?? (gDef.id === 'gauge_a' ? tpl.initialGaugeA : (gDef.id === 'gauge_b' ? tpl.initialGaugeB : gDef.min));
            const prevVal = prevAlly.gauges?.[gDef.id] !== undefined ? prevAlly.gauges[gDef.id] : prevAlly[gDef.id];
            nextGaugesMap[gDef.id] = live
                ? (live.gauges?.[gDef.id] ?? gDef.min)
                : (Number.isFinite(Number(prevVal)) ? Number(prevVal) : (fallbackInit ?? gDef.min));
        }

        const allyRecord = {
            ...prevAlly,
            level: live ? (live.level || 1) : (tpl.level || 1),
            classId: live ? (live.classId || '') : (tpl.classId || ''),
            freePoints: live ? (live.freePoints || 0) : (tpl.freePoints || 0),
            allocated: deepClone(live ? (live.allocated || tpl.allocated) : (tpl.allocated || { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 })),
            hp: live ? live.hp : (Number.isFinite(Number(prevAlly.hp)) ? prevAlly.hp : tpl.maxHp),
            mp: live ? live.mp : (Number.isFinite(Number(prevAlly.mp)) ? prevAlly.mp : tpl.maxMp),
            gauge_a: nextGaugesMap.gauge_a ?? (Number.isFinite(Number(prevAlly.gauge_a)) ? prevAlly.gauge_a : 0),
            gauge_b: nextGaugesMap.gauge_b ?? (Number.isFinite(Number(prevAlly.gauge_b)) ? prevAlly.gauge_b : 0),
            equipmentIds: [...(live ? (live.equipmentIds || []) : (tpl.equipmentIds || []))],
            skillIds: [...(live ? (live.skillIds || []) : (tpl.skillIds || []))],
        };
        const hasExtraGauges = gaugeEntries.some(g => g.id !== 'gauge_a' && g.id !== 'gauge_b');
        if (hasExtraGauges || (prevAlly.gauges && typeof prevAlly.gauges === 'object')) {
            allyRecord.gauges = { ...(prevAlly.gauges || {}), ...nextGaugesMap };
        }
        for (const gDef of gaugeEntries) {
            if (gDef.id !== 'gauge_a' && gDef.id !== 'gauge_b' && Object.prototype.hasOwnProperty.call(prevAlly, gDef.id)) {
                allyRecord[gDef.id] = nextGaugesMap[gDef.id];
            }
        }
        if (config.general?.mvuSyncStatuses !== false) {
            allyRecord.statuses = live
                ? serializeStatusesForMvu(live.statuses, config)
                : (Array.isArray(prevAlly.statuses) ? prevAlly.statuses : []);
        }
        nextAllies[tpl.id] = allyRecord;
    }

    const nextItems = deepClone(prevCombat.items || {});
    for (const it of config.items || []) {
        nextItems[it.id] = Math.max(0, Math.round(Number(it.quantity) || 0));
    }

    const patch = {
        in_combat: isFighting,
        allies: nextAllies,
        items: nextItems,
    };

    if (options.clearMvuField === 'encounter_enemy_ids') {
        patch.encounter_enemy_ids = [];
    } else if (options.clearMvuField === 'reinforce_enemy_ids') {
        patch.reinforce_enemy_ids = [];
    }

    return writeMvuCombatBlock(patch);
}

/**
 * 当角色卡已启用 MVU（存在 stat_data）但写卡助手漏写了 combat 区块时，
 * 按当前战斗插件配置一键向 stat_data.combat 补建标准初始结构（绝不触碰其他变量）
 * @param {object} config
 * @param {object|null} battleState
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function initMvuCombatBlock(config, battleState) {
    const rec = readMvuStatDataRecord();
    if (!rec) {
        return { ok: false, message: '未检测到 MVU stat_data，请先确认该角色卡已启用 MVU 且开场白已初始化变量。' };
    }

    const gaugeEntries = getGaugeEntries(config);
    const hasExtraGauges = gaugeEntries.some(g => g.id !== 'gauge_a' && g.id !== 'gauge_b');
    const isFighting = Boolean(
        battleState?.active && battleState.phase !== 'victory' && battleState.phase !== 'defeat'
    );

    const allies = {};
    const activeAllies = (config.allies || []).filter(a => a.enabled);
    const sourceAllies = activeAllies.length > 0 ? activeAllies : (config.allies || []).slice(0, 1);
    for (const tpl of sourceAllies) {
        const live = battleState?.active ? (battleState.allies || []).find(a => a.id === tpl.id) : null;
        const nextGauges = {};
        for (const gDef of gaugeEntries) {
            const initVal = tpl.initialGauges?.[gDef.id]
                ?? (gDef.id === 'gauge_a' ? tpl.initialGaugeA : (gDef.id === 'gauge_b' ? tpl.initialGaugeB : gDef.min));
            nextGauges[gDef.id] = live ? (live.gauges?.[gDef.id] ?? gDef.min) : (initVal ?? gDef.min);
        }
        const entry = {
            level: live ? (live.level || 1) : (tpl.level || 1),
            classId: live ? (live.classId || '') : (tpl.classId || ''),
            freePoints: live ? (live.freePoints || 0) : (tpl.freePoints || 0),
            allocated: deepClone(live ? (live.allocated || tpl.allocated) : (tpl.allocated || { vit: 0, str: 0, spi: 0, def: 0, mdef: 0 })),
            hp: live ? live.hp : tpl.maxHp,
            mp: live ? live.mp : tpl.maxMp,
            gauge_a: nextGauges.gauge_a ?? 0,
            gauge_b: nextGauges.gauge_b ?? 0,
            equipmentIds: [...(live ? (live.equipmentIds || []) : (tpl.equipmentIds || []))],
            skillIds: [...(live ? (live.skillIds || []) : (tpl.skillIds || []))],
            statuses: live ? serializeStatusesForMvu(live.statuses, config) : [],
        };
        if (hasExtraGauges) entry.gauges = nextGauges;
        allies[tpl.id] = entry;
    }

    const items = {};
    for (const it of config.items || []) {
        items[it.id] = Math.max(0, Math.round(Number(it.quantity) || 0));
    }

    const ok = await writeMvuCombatBlock({
        in_combat: isFighting,
        allies,
        items,
        encounter_enemy_ids: [],
        reinforce_enemy_ids: [],
    }, { allowCreateCombat: true });

    if (!ok) {
        return { ok: false, message: '补建 stat_data.combat 失败（请检查酒馆助手/MVU 写入权限或 Zod 是否拦截了未知字段）。' };
    }
    return {
        ok: true,
        message: `已自动在 MVU stat_data 中补建 combat 区块（含 ${Object.keys(allies).length} 名我方角色与 ${Object.keys(items).length} 种道具）！`,
    };
}
