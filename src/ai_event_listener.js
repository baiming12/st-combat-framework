/**
 * AI 剧情标签联动解析模块 (src/ai_event_listener.js) - v1.3
 * 职责：
 * 1. 从 AI 最新回复中解析统一格式的 <combat_event>{...}</combat_event> 标签
 * 2. 支持直接按 ID 引用已配置好的技能库 / 装备库 / 道具库 / 敌人图鉴，也支持 AI 临时自创对象
 * 3. 解析结果全部交由 HUD 弹出“一键确认条”，绝不未经用户确认擅自改写数据
 *
 * 支持的 5 类剧情事件：
 * - loot_equipment：获得装备（支持 equipId 引用库，或 data 临时新建）
 * - loot_item：获得道具（支持 itemId + quantity 引用库，或 data 临时新建）
 * - grant_skill：领悟/习得技能（支持 skillId 引用库，或 data 临时新建）
 * - start_combat：剧情遇敌开战（支持 enemyIds 引用敌人图鉴，和/或 enemies 临时新建）
 * - add_enemy：战斗中敌方增援（支持 enemyId 引用敌人图鉴，或 enemy/enemies 临时新建）
 */

import { getSTContext, normalizeEquipment, normalizeItem, normalizeSkill } from './config.js';

const EVENT_TAG_REGEX = /<combat_event>([\s\S]*?)<\/combat_event>/gi;

function normalizeEnemyObj(e, idx = 0) {
    return {
        id: String(e?.id || `enemy_ai_0${idx + 1}`),
        enabled: true,
        name: String(e?.name || `敌方目标${idx + 1}`),
        description: String(e?.description || ''),
        maxHp: Math.max(1, Math.round(Number(e?.maxHp ?? 100) || 100)),
        maxMp: Math.max(0, Math.round(Number(e?.maxMp ?? 50) || 0)),
        atk: Math.max(0, Math.round(Number(e?.atk ?? 18) || 0)),
        def: Math.max(0, Math.round(Number(e?.def ?? 6) || 0)),
        initialGaugeA: 0,
        initialGaugeB: 0,
        skillIds: Array.isArray(e?.skillIds) ? e.skillIds.map(String) : [],
        equipmentIds: Array.isArray(e?.equipmentIds) ? e.equipmentIds.map(String) : [],
    };
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
            const normalized = normalizeParsedEvent(parsed);
            if (normalized) events.push(normalized);
        } catch (err) {
            console.warn('[CombatFramework] 解析 <combat_event> JSON 失败，已忽略:', err);
        }
    }
    return events;
}

function normalizeParsedEvent(raw) {
    const type = String(raw.type || '').trim();
    const uid = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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
        };
    }

    if (type === 'start_combat') {
        const enemyIds = Array.isArray(raw.enemyIds) ? raw.enemyIds.map(String).filter(Boolean).slice(0, 4) : [];
        const rawEnemies = Array.isArray(raw.enemies) ? raw.enemies : [];
        const enemies = rawEnemies.slice(0, 4).map((e, idx) => normalizeEnemyObj(e, idx));
        return {
            uid,
            type: 'start_combat',
            enemyIds,
            enemies,
            note: String(raw.note || ''),
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
            enemyIds: enemyIds.slice(0, 4),
            enemies: customList.slice(0, 4),
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
