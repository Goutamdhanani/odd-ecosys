# ADR 0002: One future owner for workflow state

- **Status:** Proposed, pending S03, S04 and S05 conformance; no engine selected or installed.
- **Date:** 2026-10-24
- **Scope:** S05, with X01/X02/X03 prerequisites.
- **Decision owner:** Architecture and operations owner, to be named before S05 implementation.

## Context

The selected source contains useful persisted job patterns: resumable CSV imports; website discovery; EPCH directory work; lead search/discovery; verification; qualification; and sender execution. These managers each persist their own job/status/progress and recovery behavior. They are SQLite-backed, vertical-specific records and callbacks, not evidence of one platform-wide workflow authority with leases/fencing, durable timers, fairness, replay, or version migration. Sending has an important uncertain-submission recovery rule and must retain its own provider reconciliation facts.

The base blueprint permits retaining the existing worker path only if it passes crash, cancellation, replay and migration tests. Temporal is preferred for a newly built long-running workflow core only if it is justified by measured operations/cost. The extension requires a thin harness around the chosen workflow owner. S03 (tenant identity/storage) precedes S04 (event/outbox semantics), and both precede S05. X01 depends on S05; no harness completion can be claimed before those gates.

## Decision

For a future S05 increment, define exactly one canonical **WorkflowStateAuthority** for each Astra workflow. It owns workflow run state, step/attempt sequence, timers, queue class, leases and fencing generations, cancellation, retry eligibility, checkpoint pointer and resume position. A task/run has one authoritative state stream and one writer at a time. Harness code records context, valid tools, progress and completion evidence as inputs/outputs of that authority; it does not keep a second checkpoint or claim that a checkpoint proves an external provider action occurred.

The proposal is a small adapter around the existing persisted-job foundation, selected only after S03 and S04 identify tenant ownership and event/outbox contracts and after S05 conformance decides whether the current SQLite job implementation can satisfy them. The adapter may initially retain compatible job IDs and call existing vertical managers as domain activities. Those managers remain useful owners of domain calculations and bounded data operations; they must not independently advance the canonical Astra workflow run, issue competing leases, or keep a second authoritative resume/checkpoint state for that same run. During any migration, a run has one writer/owner by phase: old owner before a fenced handoff, new owner after it. There is no dual-owner checkpoint or dual-write period.

The current module state is an implementation candidate, not a committed engine choice. If the conformance matrix or operational cost shows the local persisted-job path cannot meet requirements, S05 may replace the workflow-state boundary with Temporal or another justified engine after documenting the measured gap, a versioned run mapping, replay compatibility, cost/operations review, and rollback. Do not install Temporal, LangGraph, Microsoft Agent Framework, another scheduler, or an additional orchestrator now. Inspect remains an offline evaluation runner and is not a production workflow owner.

## Ownership boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| Future WorkflowStateAuthority | Canonical run/step state, attempts, due timers, lease/fencing, cancellation, retry/resume, workflow version and checkpoint reference. | Evidence truth, customer permission, provider delivery truth or final outcome authority. |
| Existing vertical managers | Domain activities and their durable domain records where required: import chunks/rejections, verification results, discovery outputs, qualification findings, and sender/provider reconciliation. | A competing canonical workflow checkpoint for the same Astra run; tenant authorization inherited only from an untrusted job ID. |
| S04 event/outbox ledger | Immutable state-change facts, idempotent publication, consumer receipts and correction lineage. | Scheduling or retry authority. |
| Harness (X01+) | Valid bounded step inputs, context manifest reference/hash, allowlisted read-tool requests, progress signals and deterministic completion result. | Durable run ownership, mailbox secrets, authorization, side effects or a generated execution ticket. |
| Dispatcher / provider adapter | Recheck suppression, mailbox/campaign policy, exact intent and provider acknowledgement/unknown state at the external boundary. | Treating workflow completion/checkpoint as proof of provider acceptance or safe retry after ambiguity. |

`SUBMISSION_UNKNOWN` and provider-reconciliation facts remain authoritative domain facts. A workflow timeout or retry never changes them to “not sent.” The harness is research/task orchestration; action permission and dispatch are separate services.

## Required S05 conformance tests

The following tests decide whether the current execution path can be adapted or must be replaced. They are a specification and have not been run here.

| Test | Required assertion |
| --- | --- |
| Restart before lease, during activity, after activity commit, and before workflow checkpoint | Run resumes from a reconciled boundary; no lost committed output or duplicated logical side effect. |
| Two workers claim one due run concurrently | One valid lease/fencing generation; stale worker cannot write after lease expiry or reassignment. |
| Replay/retry of deterministic and idempotent read activities | Same versioned inputs produce compatible state; completed reads are deduplicated or safely repeated. |
| Lost model response after provider request | Provider usage may remain unknown/billed; retry consumes existing call/spend budget and cannot claim a missing response as success. |
| External send accepted, response lost; crash before checkpoint | Preserve `SUBMISSION_UNKNOWN`, reconcile provider evidence; never issue a blind duplicate send. |
| Suppression event arrives under queue saturation | High-priority suppression handling receives fair bounded service and cannot starve behind routine research; it is effective before a new lease/send. |
| Routine, urgent, tenant-bounded and low-priority queue classes saturated together | Fairness/aging rules prevent starvation while respecting tenant quotas and urgent safety work. |
| Cancellation before lease, during read activity, between steps, and during external submission | Prevent future work, persist cancellation; report already-started/irreversible operation separately; no false “cancelled means unsent.” |
| Poison job and repeated transient failures | Bounded retries, classified terminal state and inspectable dead-letter/review path; no infinite loop. |
| Due timer across process restart and clock/time-zone edge | Schedule fires once according to stored UTC instant and explicit customer time-zone policy; no timer loss or duplicate activity. |
| Schema/workflow version upgrade with old queued and in-flight runs | Explicit compatibility/migration path; old runs replay safely or pause for reviewed conversion. |
| Tenant context missing, stale, forged, or references another tenant's record | Reauthorize from trusted membership at execution and commit; fail closed with no cross-tenant output. |
| Duplicate/out-of-order S04 outbox event and consumer restart | Consumer receipt makes replay idempotent; projection is rebuildable and workflow scheduling is not duplicated. |
| Conflicting workflow-state writers | Automated assertion detects a second writer/owner for the same run; it cannot advance a parallel checkpoint. |
| Worker/checkpoint says “complete” while required artifact/rubric is missing | Deterministic completion check refuses terminal success. |

## Consequences and open decisions

This makes a thin adapter and existing worker reuse the first option, while setting a clear replacement threshold. S03 must first provide tenant-scoped identifiers and job ownership; S04 must provide durable event and idempotency semantics. S05 still must select concrete workflow storage, lease mechanism, queue fairness/priority policy, retry classes, delivery guarantee per activity, versioning plan, operational SLO/RPO/RTO, and measured cost. Which job manager or shared wrapper is the best initial adapter is not yet decided. No engine conformance test or production installation is claimed. X01/X02/X03 remain not complete and gated on their dependencies.
