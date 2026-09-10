# Micro Agent

Micro Agent exposes the work of a small coding agent as a sequence of inspectable activities.

## Language

**Run**:
One lifetime of the Micro Agent CLI process. A run can contain multiple user requests.

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
