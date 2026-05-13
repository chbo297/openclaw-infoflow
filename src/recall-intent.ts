/**
 * Lightweight recall-intent detection used by both the prompt-injection path
 * (bot.ts) and the delete action's aggressive guard (actions.ts).
 *
 * Two helpers:
 *  - looksLikeRecallIntent: matches any "撤回/删除/recall/unsend/..." verb.
 *  - looksLikeRecallLatest: requires both a recall verb AND an explicit
 *    "the latest one" qualifier (上一条 / 最后一条 / 刚才那条 / 最近一条 /
 *    last / previous / most recent / ...). Used to decide whether it's safe
 *    to auto-correct `messageId=inbound_user_msg_id` to count=1 (recall most
 *    recent). Standalone "撤回那条" without a temporal qualifier is rejected:
 *    it could refer to a specific quoted message and we'd rather surface
 *    candidates to the LLM than risk recalling the wrong one.
 */

const RECALL_INTENT_REGEX =
  /(撤回|收回|删[掉了除]|取消|清除|recall|unsend|undo\s*send|delete\s+(?:that|those|the\s+(?:last|previous(?:\s+\d+)?)))/i;

const RECALL_LATEST_HINT_REGEX =
  /(上一?条|最后一?条|刚才那?条|最近一?条|last(?:\s+(?:one|message|two|few|reply))?|previous|most\s*recent)/iu;

export function looksLikeRecallIntent(text: string): boolean {
  if (!text) return false;
  return RECALL_INTENT_REGEX.test(text);
}

export function looksLikeRecallLatest(text: string): boolean {
  if (!text) return false;
  return RECALL_INTENT_REGEX.test(text) && RECALL_LATEST_HINT_REGEX.test(text);
}
