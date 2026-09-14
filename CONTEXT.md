# Micro Agent

Micro Agent exposes the work of a small coding agent as a sequence of inspectable activities.

## Language

**Run**:
One lifetime of the Micro Agent CLI process. A run may create, continue, or switch between conversations, with only one active conversation at a time.
_Avoid_: Session

**Conversation**:
The durable, ordered model-visible exchange between the user and agent. It may span multiple runs and includes every user request, model response, and tool interaction.
_Avoid_: Agent context, chat session

**Active Conversation**:
The conversation that receives the next user request in a run. A run has at most one active conversation at a time.
_Avoid_: Current session

**Conversation State**:
The durable model-visible input and minimal metadata saved so a conversation can continue in a later run.
_Avoid_: Journal, conversation log

**Conversation Checkpoint**:
The last complete conversation state that is safe to restore. An incomplete user request is tracked separately and is never replayed automatically.
_Avoid_: Backup, journal checkpoint

**Conversation Store**:
The local collection of conversation state files and the operations that create, list, load, and persist them. It does not run the agent or execute tools.
_Avoid_: History store, conversation repository

**User Request**:
One user message and the agent activity it starts within a conversation.
_Avoid_: Prompt, standalone context

**Model Step**:
One request to the model and its response within a user request. Tool calls emitted by that response and their results belong to the same model step.
_Avoid_: Turn, iteration

**Journal**:
The detailed, best-effort diagnostic record of agent activity produced during one run. It is not used to restore conversation state.
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
