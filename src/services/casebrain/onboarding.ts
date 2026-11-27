import type { NodeKind, NodeStatus } from "./index.js";

export interface HandoverIntake {
  brief: string;
  caseType: string;
  oppositeParty: string;
  keyDates: Array<{ label: string; date: string }>;
  outcome: string;
  urgency: "routine" | "soon" | "urgent";
  deadline: string;
}

export interface OnboardingMatter {
  title: string;
  client: string;
  court: string;
  intake: HandoverIntake;
}

export interface OnboardingNode {
  section: "Parties" | "Facts" | "Chronology" | "Issues";
  kind: NodeKind;
  title: string;
  body?: string;
  date?: string;
  status: NodeStatus;
}

const clean = (value: string, max: number) => value.trim().slice(0, max);

/**
 * Makes the lawyer's handover brief inspectable: each essential detail becomes a
 * confirmed node under the appropriate branch of the case knowledge tree.
 */
export function buildOnboardingNodes(matter: OnboardingMatter): OnboardingNode[] {
  const intake = matter.intake;
  const nodes: OnboardingNode[] = [];
  const add = (section: OnboardingNode["section"], kind: NodeKind, title: string, extra: Partial<OnboardingNode> = {}) => {
    const value = clean(title, 300);
    if (value) nodes.push({ section, kind, title: value, status: "confirmed", ...extra });
  };

  if (clean(matter.client, 200)) add("Parties", "party", `Client: ${clean(matter.client, 200)}`);
  if (clean(intake.oppositeParty, 200)) add("Parties", "party", `Opposite party: ${clean(intake.oppositeParty, 200)}`);
  if (clean(intake.brief, 5000)) add("Facts", "fact", "Case summary", { body: clean(intake.brief, 5000) });
  if (clean(intake.caseType, 80)) add("Facts", "fact", `Case type: ${clean(intake.caseType, 80)}`);
  if (clean(matter.court, 200)) add("Facts", "fact", `Court / forum: ${clean(matter.court, 200)}`);

  for (const date of intake.keyDates.slice(0, 12)) {
    const title = clean(date.label, 120);
    const value = clean(date.date, 10);
    if (title && /^\d{4}-\d{2}-\d{2}$/.test(value)) add("Chronology", "event", title, { date: value });
  }
  if (clean(intake.outcome, 1000)) add("Issues", "issue", "Objective", { body: clean(intake.outcome, 1000) });
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean(intake.deadline, 10))) add("Chronology", "event", "Deadline", { date: intake.deadline });

  return nodes;
}
