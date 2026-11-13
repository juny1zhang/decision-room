// Goal mode (目标模式) as it reads from a room's saved messages. Participants each propose a plan to reach the
// goal in the question; the moderator merges the proposals into version 1 of one plan; every other
// participant reviews each version and ends with a verdict; the moderator revises the plan until every
// reviewer approves a version (consensus) or the turn reaches its cap on versions. Everything here is derived
// from the messages alone, so that a turn can be resumed, shown and exported from what was saved.
//
// The messages of a goal turn, besides its question, notices and errors:
//   proposal  role: the participant, stage 'proposal'
//   draft     role 'summary', stage 'draft', provider: its author (the moderator, or the participant standing
//             in for it), version: 1, 2…, cap: the most versions allowed when it was written
//   feedback  role: the participant, stage 'feedback', version: the version reviewed, verdict: 'approve' or
//             'revise'
import { DEFAULT_MAX_ROUNDS } from './config.mjs';
import { planVersion, roomMessages } from './messages.mjs';
import { savedConfiguration } from './validation.mjs';

const VERDICT = /结论[:：]\s*(认可|需修改)/g;

/**
 * The verdict a feedback ends with: 'approve' when the last "结论：认可" or "结论：需修改" in `text` (with a
 * full-width or ASCII colon) approves, else 'revise', also when there is none: only an explicit approval
 * counts.
 */
export function parseVerdict(text) {
  const last = [...String(text).matchAll(VERDICT)].at(-1);
  return last?.[1] === '认可' ? 'approve' : 'revise';
}

/**
 * What the goal turn that `question` started in `room` holds for `participants`, whose plan may have
 * `maxRounds` versions unless a version says otherwise:
 *   proposals   Map participant → its latest proposal
 *   rounds      [{ draft, version, feedback }] in order: each version of the plan (a draft by a participant,
 *               with a valid version) and the latest feedback of each reviewer on it (Map participant →
 *               message), counted only after that version and only from participants other than its author
 *   latest      the last of rounds, or null before version 1
 *   reviewers   the participants who review the latest version: all but its author, who approves its own
 *   unreviewed  the reviewers without feedback on it yet
 *   objectors   the reviewers whose feedback on it asks for changes
 *   cap         the most versions in effect: the latest version's cap, or `maxRounds` before version 1
 *   status      'consensus' when every reviewer approved the latest version, 'capped' when every reviewer
 *               answered, someone objects and no version may follow, else 'incomplete' (something is
 *               missing, or the next version is due)
 */
export function goalProgress(room, question, { participants, maxRounds = DEFAULT_MAX_ROUNDS }) {
  const proposals = new Map();
  const rounds = [];
  for (const message of roomMessages(room)) {
    if (message === question || message.turnId !== question.id) continue;
    const version = planVersion(message.version);
    const current = rounds.at(-1);
    if (message.role === 'summary' && message.stage === 'draft') {
      if (version && participants.includes(message.provider))
        rounds.push({ draft: message, version, feedback: new Map() });
    } else if (participants.includes(message.role)) {
      if (message.stage === 'proposal') proposals.set(message.role, message);
      else if (
        message.stage === 'feedback' &&
        version === current?.version &&
        message.role !== current.draft.provider
      )
        current.feedback.set(message.role, message);
    }
  }
  const latest = rounds.at(-1) ?? null;
  if (!latest)
    return {
      proposals,
      rounds,
      latest,
      reviewers: [],
      unreviewed: [],
      objectors: [],
      cap: maxRounds,
      status: 'incomplete'
    };
  const reviewers = participants.filter((agent) => agent !== latest.draft.provider);
  const unreviewed = reviewers.filter((agent) => !latest.feedback.has(agent));
  const objectors = reviewers.filter(
    (agent) => latest.feedback.has(agent) && latest.feedback.get(agent).verdict !== 'approve'
  );
  const cap = planVersion(latest.draft.cap) ?? maxRounds;
  let status = 'incomplete';
  if (!unreviewed.length)
    status = !objectors.length ? 'consensus' : latest.version >= cap ? 'capped' : status;
  return { proposals, rounds, latest, reviewers, unreviewed, objectors, cap, status };
}

/**
 * The goal turns of `room`: a Map from every question asked in goal mode (one that carries its turn id and a
 * readable configuration) to its goalProgress.
 */
export function goalTurns(room) {
  const turns = new Map();
  for (const message of roomMessages(room)) {
    if (message.role !== 'user' || typeof message.id !== 'string' || message.turnId !== message.id) continue;
    const configuration = savedConfiguration(message.configuration);
    if (configuration?.mode === 'goal') turns.set(message, goalProgress(room, message, configuration));
  }
  return turns;
}

/** The versions of the plan in `room` that every reviewer approved: each one ended its goal turn. */
export function finalPlans(room) {
  const finals = new Set();
  for (const progress of goalTurns(room).values())
    if (progress.status === 'consensus') finals.add(progress.latest.draft);
  return finals;
}
