# Micro Agent

Micro Agent exposes the work of a small coding agent as a sequence of inspectable activities.

## Language

**Run**:
One lifetime of the Micro Agent CLI process. A run contains exactly one conversation.
_Avoid_: Session

**Conversation**:
The ordered model-visible exchange between the user and agent during one run. It includes every user request, model response, and tool interaction in that run.
_Avoid_: Agent context, chat session

**User Request**:
One user message and the agent activity it starts within a conversation.
_Avoid_: Prompt, standalone context

**Journal**:
The ordered record of agent activity produced during one run.
_Avoid_: Log, trace

**Journal Event**:
One ordered record within a journal, describing a single observable part of agent activity.
_Avoid_: Log line, entry

**Incomplete Journal**:
A journal whose run did not record its normal completion. Its recorded events remain valid for inspection.
_Avoid_: Invalid journal, corrupt journal

**Journal Viewer**:
An interface for selecting journals and inspecting their events.
_Avoid_: Log UI, dashboard
