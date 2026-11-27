/**
 * AI 剧情标签联动解析模块 (src/ai_event_listener.js)
 * 职责：
 * 1. 从 AI 最新回复中解析统一格式的 <combat_event>{...}</combat_event> 标签
 * 2. 完全独立于各角色卡千差万别的 MVU / MVU Zod 变量结构，换卡零适配
 * 3. 解析结果仅交由 HUD 弹出“一键确认条”，绝不未经用户确认擅自改写数据
 *
 * 支持的事件类型：
 * - loot_equipment：剧情获得装备（含属性加成、附带技能、附带常驻 Buff）
 * - loot_item：剧情获得道具（自动叠加同 ID 数量或新增）
 * - start_combat：剧情遭遇敌人请求开战（支持临时指定敌方列表）
 */

import { getSTContext, normalizeEquipment, normalizeItem } from './config.js';

const EVENT_TAG_REGEX = /<combat_event>([\s\S]*?)<\/combat_event>/gi;

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
            if (normalized) {
                events.push(normalized);
            }
        } catch (err) {
            console.warn('[CombatFramework] 解析 <combat_event> JSON 失败，已忽略:', err);
        }
    }
    return events;
}

/**
 * 校验并规范化单条 AI 事件
 * @param {object} raw
 * @returns {object|null}
 */
function normalizeParsedEvent(raw) {
    const type = String(raw.type || '').trim();
    const uid = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    if (type === 'loot_equipment') {
        const equip = normalizeEquipment(raw.data || raw, Math.floor(Math.random() * 900) + 100);
        // 若 AI 没给 id，按名称生成一个可读唯一 id
        if (!raw.data?.id && !raw.id) {
            equip.id = `equip_ai_${Date.now().toString(36)}`;
        }
        return {
            uid,
            type: 'loot_equipment',
            equipment: equip,
            autoEquipTo: String(raw.autoEquipTo || ''),
        };
    }

    if (type === 'loot_item') {
        const item = normalizeItem(raw.data || raw, Math.floor(Math.random() * 900) + 100);
        if (!raw.data?.id && !raw.id) {
            item.id = `item_ai_${Date.now().toString(36)}`;
        }
        if (item.quantity <= 0) item.quantity = 1;
        return {
            uid,
            type: 'loot_item',
            item,
        };
    }

    if (type === 'start_combat') {
        const rawEnemies = Array.isArray(raw.enemies) ? raw.enemies : [];
        const enemies = rawEnemies.slice(0, 4).map((e, idx) => ({
            id: String(e?.id || `enemy_ai_0${idx + 1}`),
            enabled: true,
            name: String(e?.name || `敌方目标${idx + 1}`),
            maxHp: Math.max(1, Math.round(Number(e?.maxHp ?? 100) || 100)),
            maxMp: Math.max(0, Math.round(Number(e?.maxMp ?? 50) || 0)),
            atk: Math.max(0, Math.round(Number(e?.atk ?? 18) || 0)),
            def: Math.max(0, Math.round(Number(e?.def ?? 6) || 0)),
            initialGaugeA: 0,
            initialGaugeB: 0,
            skillIds: Array.isArray(e?.skillIds) ? e.skillIds.map(String) : [],
            equipmentIds: Array.isArray(e?.equipmentIds) ? e.equipmentIds.map(String) : [],
        }));
        return {
            uid,
            type: 'start_combat',
            enemies,
            note: String(raw.note || ''),
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
