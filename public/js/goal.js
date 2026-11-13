// Goal mode (目标模式) read from the messages the page shows: how far a goal turn got and which version of its
// plan every reviewer approved. Mirrors goalProgress in src/goal.mjs; tests/integration/resilience.test.mjs
// checks that the two agree. Nothing here touches the DOM.
import { isProviderId } from './providers.js';

/** The versions of the plan a goal turn may write unless its configuration says otherwise. */
export const DEFAULT_MAX_ROUNDS = 3;
/** The most versions a configuration may ask for. */
export const MAX_ROUNDS_LIMIT = 6;

/** Whether `value` may cap the versions of a plan: a whole number from 1 to MAX_ROUNDS_LIMIT. */
export const isMaxRounds = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_ROUNDS_LIMIT;

/** The version of the plan a message holds or reviews: a whole number from 1, else null. */
export const planVersion = (value) => (Number.isSafeInteger(value) && value >= 1 ? value : null);

/**
 * How far a goal turn got: `messages` are the turn's own (after its question, with its turnId), `team` its
 * participants and `maxRounds` its configuration's. Resolves to { latest, cap, status }: latest is the last
 * version of the plan (a draft by a participant, with a valid version) or null; cap the most versions in
 * effect (the latest version's own, else maxRounds); status 'consensus' when every participant but the
 * latest version's author approved it, 'capped' when they all answered, someone asks for changes and no
 * version may follow, else 'incomplete'. Only feedback after a version, on that version, counts.
 */
export function goalState(messages, team, maxRounds = DEFAULT_MAX_ROUNDS) {
  let latest = null;
  let feedback = new Map();
  for (const message of messages) {
    const version = planVersion(message?.version);
    if (message?.role === 'summary' && message.stage === 'draft') {
      if (version && team.includes(message.provider)) {
        latest = message;
        feedback = new Map();
      }
    } else if (
      message?.stage === 'feedback' &&
      team.includes(message.role) &&
      latest &&
      version === latest.version &&
      message.role !== latest.provider
    )
      feedback.set(message.role, message);
  }
  const cap = planVersion(latest?.cap) ?? (isMaxRounds(maxRounds) ? maxRounds : DEFAULT_MAX_ROUNDS);
  if (!latest) return { latest, cap, status: 'incomplete' };
  const reviewers = team.filter((id) => id !== latest.provider);
  if (!reviewers.every((id) => feedback.has(id))) return { latest, cap, status: 'incomplete' };
  if (reviewers.every((id) => feedback.get(id).verdict === 'approve'))
    return { latest, cap, status: 'consensus' };
  return { latest, cap, status: latest.version >= cap ? 'capped' : 'incomplete' };
}

/** The participants of a question's saved configuration `config` that look like provider ids. */
export const teamOf = (config) =>
  Array.isArray(config?.participants) ? config.participants.filter(isProviderId) : [];

/**
 * The ids of the versions of a plan in `messages` that every reviewer approved: for each goal-mode question
 * carrying its turn id, the latest version of its turn when the turn reached consensus.
 */
export function finalPlanIds(messages) {
  const finals = new Set();
  messages.forEach((question, index) => {
    const config = question?.configuration;
    if (question?.role !== 'user' || config?.mode !== 'goal') return;
    if (typeof question.id !== 'string' || question.turnId !== question.id) return;
    const turn = messages.slice(index + 1).filter((message) => message?.turnId === question.id);
    const { latest, status } = goalState(turn, teamOf(config), config.maxRounds);
    if (status === 'consensus' && latest.id) finals.add(latest.id);
  });
  return finals;
}
