// Count a workflow history's events and its billable actions, from `temporal workflow show -o json`.
//   temporal workflow show -w <id> --address localhost:7300 -o json > h.json; node count-history.mjs h.json
// Billable per docs.temporal.io/evaluate/cloud/actions: workflow start, activity schedule (plus
// retries: attempt - 1 on each ActivityTaskStarted), signal, accepted Update. Queries and activity
// heartbeats are billable too but are not in history, so this is a floor.
import fs from "node:fs";

const { events } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byType = {};
for (const e of events) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
const n = (t) => byType[`EVENT_TYPE_${t}`] ?? 0;
const retries = events
  .map((e) => e.activityTaskStartedEventAttributes?.attempt ?? 1)
  .reduce((s, a) => s + (a - 1), 0);
const named = (attr, key) => {
  const out = {};
  for (const e of events) {
    const a = e[attr];
    if (a) {
      const name = key(a);
      out[name] = (out[name] ?? 0) + 1;
    }
  }
  return out;
};
console.log("events", events.length);
console.log("by type", byType);
console.log("activities", named("activityTaskScheduledEventAttributes", (a) => a.activityType.name));
console.log("signals", named("workflowExecutionSignaledEventAttributes", (a) => a.signalName));
console.log("updates", named("workflowExecutionUpdateAcceptedEventAttributes", (a) => a.acceptedRequest.input.name));
const billable =
  n("WORKFLOW_EXECUTION_STARTED") + n("ACTIVITY_TASK_SCHEDULED") + retries +
  n("WORKFLOW_EXECUTION_SIGNALED") + n("WORKFLOW_EXECUTION_UPDATE_ACCEPTED");
console.log("activity retries", retries);
console.log("billable actions in history (floor)", billable);
