/**
 * AI 剧情标签联动解析模块 (src/ai_event_listener.js) - v2.0
 * 职责：
 * 1. 从 AI 最新回复中解析统一格式的 <combat_event>{...}</combat_event> 标签
 * 2. 支持直接按 ID 引用已配置好的技能库 / 装备库 / 道具库 / 状态库 / 敌人图鉴，也支持 AI 在地下城等剧情中动态自创对象
 * 3. 支持事件附带依赖的自定义 statuses / skills（例如地下城新爆出的附魔武器同时自带一个新常驻 Buff，一次确认全部入库！）
 * 4. 解析结果全部交由 HUD 弹出“一键确认条”，绝不未经用户确认擅自改写数据
 *
 * 支持的 8 类剧情事件：
 * - loot_equipment：获得装备（支持 equipId 引用库，或 data 临时新建，并可附带 statuses / skills）
 * - loot_item：获得道具（支持 itemId + quantity 引用库，或 data 临时新建，并可附带 statuses）
 * - loot_bundle：地下城宝箱/Boss 批量掉落包（一次同时包含多件 equips / items / skills / statuses！）
 * - grant_skill：领悟/习得技能（支持 skillId 引用库，或 data 临时新建，并可附带 statuses）
 * - grant_status：剧情触发异常/祝福状态（支持 statusId 引用库或 data 临时新建，支持 remove:true 解除）
 * - level_up：剧情修炼突破升级（提升指定角色等级并自动发放自由属性点）
 * - start_combat：剧情遇敌开战（支持 enemyIds 引用敌人图鉴，和/或 enemies 临时新建，完整保留 spi/mdef/level/aiStrategy）
 * - add_enemy：战斗中敌方增援（支持 enemyId 引用敌人图鉴，或 enemy/enemies 临时新建）
 */

import { MAX_UNITS_PER_SIDE, getSTContext, normalizeEquipment, normalizeItem, normalizeSkill, normalizeStatusDef } from './config.js';

const EVENT_TAG_REGEX = /<combat_event>([\s\S]*?)<\/combat_event>/gi;

function normalizeEnemyObj(e, idx = 0) {
    const rawInit = e?.initialGauges && typeof e.initialGauges === 'object' ? e.initialGauges : {};
    return {
        id: String(e?.id || `enemy_ai_0${idx + 1}`),
        enabled: true,
        name: String(e?.name || `敌方目标${idx + 1}`),
        description: String(e?.description || ''),
        level: Math.max(1, Math.round(Number(e?.level ?? 1) || 1)),
        maxHp: Math.max(1, Math.round(Number(e?.maxHp ?? 100) || 100)),
        maxMp: Math.max(0, Math.round(Number(e?.maxMp ?? 50) || 0)),
        atk: Math.max(0, Math.round(Number(e?.atk ?? 18) || 0)),
        spi: Math.max(0, Math.round(Number(e?.spi ?? 15) || 0)),
        def: Math.max(0, Math.round(Number(e?.def ?? 6) || 0)),
        mdef: Math.max(0, Math.round(Number(e?.mdef ?? 5) || 0)),
        initialGaugeA: Number.isFinite(Number(rawInit.gauge_a ?? e?.initialGaugeA)) ? Number(rawInit.gauge_a ?? e?.initialGaugeA) : 0,
        initialGaugeB: Number.isFinite(Number(rawInit.gauge_b ?? e?.initialGaugeB)) ? Number(rawInit.gauge_b ?? e?.initialGaugeB) : 0,
        initialGauges: { ...rawInit },
        skillIds: Array.isArray(e?.skillIds) ? e.skillIds.map(String) : [],
        equipmentIds: Array.isArray(e?.equipmentIds) ? e.equipmentIds.map(String) : [],
        aiStrategy: ['priority', 'weighted', 'random'].includes(e?.aiStrategy) ? e.aiStrategy : 'priority',
    };
}

function extractBundledDeps(raw) {
    const bundledStatuses = Array.isArray(raw?.statuses)
        ? raw.statuses.filter(s => s && typeof s === 'object').map((s, i) => normalizeStatusDef(s, i))
        : [];
    const bundledSkills = Array.isArray(raw?.skills)
        ? raw.skills.filter(s => s && typeof s === 'object').map((s, i) => normalizeSkill(s, i))
        : [];
    return { bundledStatuses, bundledSkills };
}

/**
 * 从任意文本中解析所有合法的 <combat_event> 事件
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseCombatEventsFromText(text) {
    if (!text || typeof text !== 'string') return [];
    const events = [];
    let match;
    EVENT_TAG_REGEX.lastIndex = 0;

    while ((match = EVENT_TAG_REGEX.exec(text)) !== null) {
        const rawJson = (match[1] || '').trim();
        if (!rawJson) continue;
        try {
            const parsed = JSON.parse(rawJson);
            if (!parsed || typeof parsed !== 'object') continue;
            const normalizedList = normalizeParsedEvent(parsed);
            if (Array.isArray(normalizedList)) {
                events.push(...normalizedList);
            } else if (normalizedList) {
                events.push(normalizedList);
            }
        } catch (err) {
            console.warn('[CombatFramework] 解析 <combat_event> JSON 失败，已忽略:', err);
        }
    }
    return events;
}

function normalizeParsedEvent(raw) {
    const type = String(raw.type || '').trim();
    const uid = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { bundledStatuses, bundledSkills } = extractBundledDeps(raw);

    if (type === 'loot_equipment') {
        const equipId = String(raw.equipId || raw.id || '').trim();
        const hasCustomData = Boolean(raw.data && typeof raw.data === 'object') || Boolean(raw.name);
        const equipment = hasCustomData
            ? normalizeEquipment(raw.data || raw, Math.floor(Math.random() * 900) + 100)
            : null;
        if (equipment && !raw.data?.id && !raw.id) {
            equipment.id = `equip_ai_${Date.now().toString(36)}`;
        }
        if (!equipId && !equipment) return null;
        return {
            uid,
            type: 'loot_equipment',
            equipId,
            equipment,
            autoEquipTo: String(raw.autoEquipTo || raw.unitId || ''),
            bundledStatuses,
            bundledSkills,
        };
    }

    if (type === 'loot_item') {
        const itemId = String(raw.itemId || raw.id || '').trim();
        const quantity = Math.max(1, Math.round(Number(raw.quantity ?? raw.data?.quantity ?? 1) || 1));
        const hasCustomData = Boolean(raw.data && typeof raw.data === 'object') || Boolean(raw.name);
        const item = hasCustomData
            ? normalizeItem({ ...(raw.data || raw), quantity }, Math.floor(Math.random() * 900) + 100)
            : null;
        if (item && !raw.data?.id && !raw.id) {
            item.id = `item_ai_${Date.now().toString(36)}`;
        }
        if (!itemId && !item) return null;
        return {
            uid,
            type: 'loot_item',
            itemId,
            quantity,
            item,
            bundledStatuses,
            bundledSkills,
        };
    }

    // v2.0 新增：地下城宝箱/Boss 批量掉落包（一次打包收录装备、道具、技能与配套状态）
    if (type === 'loot_bundle') {
        const title = String(raw.title || raw.source || '地下城战利品').trim();
        const equips = Array.isArray(raw.equipments)
            ? raw.equipments.filter(Boolean).map((entry, idx) => {
                if (typeof entry === 'string') return { equipId: entry.trim(), equipment: null };
                if (entry.equipId && !entry.name) return { equipId: String(entry.equipId).trim(), equipment: null };
                const eq = normalizeEquipment(entry, idx + 100);
                if (!entry.id) eq.id = `equip_dg_${Date.now().toString(36)}_${idx}`;
                return { equipId: '', equipment: eq };
            })
            : [];
        const items = Array.isArray(raw.items)
            ? raw.items.filter(Boolean).map((entry, idx) => {
                if (typeof entry === 'string') return { itemId: entry.trim(), quantity: 1, item: null };
                const qty = Math.max(1, Math.round(Number(entry.quantity ?? 1) || 1));
                if (entry.itemId && !entry.name) return { itemId: String(entry.itemId).trim(), quantity: qty, item: null };
                const it = normalizeItem({ ...entry, quantity: qty }, idx + 100);
                if (!entry.id) it.id = `item_dg_${Date.now().toString(36)}_${idx}`;
                return { itemId: '', quantity: qty, item: it };
            })
            : [];
        const grantSkills = Array.isArray(raw.grantSkills)
            ? raw.grantSkills.filter(Boolean).map((entry, idx) => {
                if (typeof entry === 'string') return { skillId: entry.trim(), skill: null };
                if (entry.skillId && !entry.name) return { skillId: String(entry.skillId).trim(), skill: null };
                const sk = normalizeSkill(entry, idx + 100);
                if (!entry.id) sk.id = `skill_dg_${Date.now().toString(36)}_${idx}`;
                return { skillId: '', skill: sk };
            })
            : [];

        if (equips.length === 0 && items.length === 0 && grantSkills.length === 0 && bundledStatuses.length === 0) {
            return null;
        }
        return {
            uid,
            type: 'loot_bundle',
            title,
            unitId: String(raw.unitId || raw.autoEquipTo || ''),
            equips,
            items,
            grantSkills,
            bundledStatuses,
            bundledSkills,
        };
    }

    if (type === 'grant_skill') {
        const skillId = String(raw.skillId || raw.id || '').trim();
        const hasCustomData = Boolean(raw.data && typeof raw.data === 'object') || Boolean(raw.name);
        const skill = hasCustomData
            ? normalizeSkill(raw.data || raw, Math.floor(Math.random() * 900) + 100)
            : null;
        if (skill && !raw.data?.id && !raw.id) {
            skill.id = `skill_ai_${Date.now().toString(36)}`;
        }
        if (!skillId && !skill) return null;
        return {
            uid,
            type: 'grant_skill',
            skillId,
            skill,
            unitId: String(raw.unitId || ''),
            bundledStatuses,
        };
    }

    if (type === 'grant_status') {
        const statusId = String(raw.statusId || raw.id || '').trim();
        const hasCustomData = Boolean(raw.data && typeof raw.data === 'object') || Boolean(raw.name);
        const status = hasCustomData ? normalizeStatusDef(raw.data || raw, 100) : null;
        if (status && !raw.data?.id && !raw.id) {
            status.id = `st_ai_${Date.now().toString(36)}`;
        }
        if (!statusId && !status) return null;
        return {
            uid,
            type: 'grant_status',
            statusId: statusId || status.id,
            status,
            unitId: String(raw.unitId || ''),
            turns: Number.isFinite(Number(raw.turns)) ? Math.max(1, Math.round(Number(raw.turns))) : null,
            remove: Boolean(raw.remove),
        };
    }

    if (type === 'level_up') {
        return {
            uid,
            type: 'level_up',
            unitId: String(raw.unitId || ''),
            levels: Math.max(1, Math.round(Number(raw.levels ?? raw.delta ?? 1) || 1)),
            reason: String(raw.reason || raw.note || '剧情修炼突破').trim(),
        };
    }

    if (type === 'start_combat') {
        const enemyIds = Array.isArray(raw.enemyIds) ? raw.enemyIds.map(String).filter(Boolean).slice(0, MAX_UNITS_PER_SIDE) : [];
        const rawEnemies = Array.isArray(raw.enemies) ? raw.enemies : [];
        const enemies = rawEnemies.slice(0, MAX_UNITS_PER_SIDE).map((e, idx) => normalizeEnemyObj(e, idx));
        return {
            uid,
            type: 'start_combat',
            enemyIds,
            enemies,
            note: String(raw.note || ''),
            bundledStatuses,
            bundledSkills,
        };
    }

    if (type === 'add_enemy') {
        const enemyIds = [];
        if (raw.enemyId) enemyIds.push(String(raw.enemyId));
        if (Array.isArray(raw.enemyIds)) enemyIds.push(...raw.enemyIds.map(String).filter(Boolean));
        const customList = [];
        if (raw.enemy && typeof raw.enemy === 'object') customList.push(normalizeEnemyObj(raw.enemy, 0));
        if (Array.isArray(raw.enemies)) customList.push(...raw.enemies.map((e, i) => normalizeEnemyObj(e, i)));
        if (raw.name && !raw.enemy) customList.push(normalizeEnemyObj(raw, 0));
        if (enemyIds.length === 0 && customList.length === 0) return null;
        return {
            uid,
            type: 'add_enemy',
            enemyIds: enemyIds.slice(0, MAX_UNITS_PER_SIDE),
            enemies: customList.slice(0, MAX_UNITS_PER_SIDE),
            bundledStatuses,
            bundledSkills,
        };
    }

    return null;
}

/**
 * 扫描当前聊天的最新一条 AI 回复，提取待确认的剧情事件
 * @returns {Array<object>}
 */
export function scanLatestAiMessageForEvents() {
    const ctx = getSTContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;
        const text = typeof msg.mes === 'string' ? msg.mes : '';
        return parseCombatEventsFromText(text);
    }
    return [];
}
