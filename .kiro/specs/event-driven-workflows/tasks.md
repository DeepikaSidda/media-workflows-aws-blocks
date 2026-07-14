# Implementation Plan: Event-Driven Workflows

## Overview

This plan implements the media upload-and-processing application as a TypeScript AWS Blocks (IFC) project. The strategy is to build pure domain logic first (validation, the Job_Status state machine, auth lockout, progress, report aggregation/serialization), verify it with property-based tests using `fast-check`, then layer the Block-backed I/O services on top and wire everything through the single `JobStore.transition` choke point. Application code stays mode-agnostic; local-vs-production behavior is resolved by Block variant selection at composition time. Integration and smoke tests cover latency bounds, dead-letter redrive, and per-mode wiring.

Each property test uses `fast-check`, runs a minimum of 100 iterations, and is tagged with a comment in the format `// Feature: event-driven-workflows, Property {number}: {property_text}`. Each of Properties 1–35 is implemented by a single property-based test.

## Tasks

- [x] 1. Set up project structure, tooling, and shared types
  - [x] 1.1 Initialize the AWS Blocks TypeScript project and test tooling
    - Create the project structure (`aws-blocks/`, `src/domain/`, `src/services/`, `src/__tests__/`)
    - Add `package.json`, `tsconfig.json`, and configure the test runner (Vitest or Jest) with `fast-check`
    - Create `aws-blocks/config.ts` defining the `AppSetting`-backed configuration constants (`sessionLifetimeMs`, `maxLoginFailures`, `lockoutMs`, `acceptedTypes`, `maxUploadBytes`, `maxProcessingAttempts`, `progressIntervalMs`, `emailMaxRetries`, `nightlyScheduleCron`)
    - _Requirements: 1.1, 1.7, 2.1, 2.3, 3.4, 4.4, 5.3, 6.1_

  - [x] 1.2 Define core data models and shared types
    - Implement `JobRecord`, `Artifact`, `JobStatus`, `Session`, `LockoutState`, `JobMessage`, `ReportingPeriod`, `StoredReport`, `UserSummary`, `AuthenticatedUser`, and result/message DTOs from the design
    - Define the `Observability` interface and service interfaces referenced by later tasks
    - _Requirements: 1.6, 2.1, 3.6, 6.2, 6.8_

- [x] 2. Implement authentication
  - [x] 2.1 Implement the pure session + lockout state machine
    - Implement session issuance (`expiresAt = now + sessionLifetimeMs`) and the lockout tracker (counter keyed by username, lock after `maxLoginFailures`, reset on success)
    - _Requirements: 1.1, 1.2, 1.7_

  - [ ]* 2.2 Write property test for session lifetime
    - **Property 1: Session lifetime is exactly the configured window**
    - **Validates: Requirements 1.1**

  - [ ]* 2.3 Write property test for non-disclosing credential errors
    - **Property 2: Invalid credentials never disclose the failing field**
    - **Validates: Requirements 1.2**

  - [ ]* 2.4 Write property test for lockout behavior
    - **Property 5: Lockout after five consecutive failures, reset on success**
    - **Validates: Requirements 1.7**

  - [x] 2.5 Implement AuthService wrapping the auth Block
    - Implement `login` and `getCurrentUser` over `AuthBasic`/`AuthCognito`, reading the session credential from `BlocksContext` and returning the owning `userId`
    - _Requirements: 1.2, 1.3, 1.6, 1.7_

  - [ ]* 2.6 Write property test for request-to-owner resolution
    - **Property 4: Every authenticated request resolves to its owning user**
    - **Validates: Requirements 1.6**

  - [ ]* 2.7 Write unit tests for AuthService
    - Test invalid-credential and locked-account paths and generic error shape
    - _Requirements: 1.2, 1.7_

- [x] 3. Implement the Job_Status state machine and JobStore
  - [x] 3.1 Implement the pure `nextStatus` state machine
    - Implement the legal transition table with `transition` / `noop` (terminal) / `illegal` results
    - _Requirements: 3.1, 3.7_

  - [ ]* 3.2 Write property test for the state machine
    - **Property 12: Job_Status transitions follow the state machine and terminal states are immutable**
    - **Validates: Requirements 3.1, 3.7**

  - [x] 3.3 Implement JobStore over `DistributedTable`
    - Implement `create` (QUEUED), `get`, `transition` (the single choke point that validates via `nextStatus`, persists timestamps, and invokes injected observability/notification hooks), and the reporting queries `findByUserAndCompletionWindow` and `listUsersWithActivity` with `byUser` and `byCompletion` secondary indexes
    - Accept an injected `Observability` dependency so status changes route through one place
    - _Requirements: 2.4, 3.1, 3.6, 3.7, 6.2, 6.4_

  - [ ]* 3.4 Write unit tests for JobStore transition choke point
    - Test create/get and that transitions persist ordered timestamps and reject illegal transitions
    - _Requirements: 2.4, 3.6_

- [x] 4. Implement upload validation and Upload_Service
  - [x] 4.1 Implement the pure `validateUpload` function
    - Validate accepted type and size range `(0, maxUploadBytes]`; return typed `UNSUPPORTED_TYPE` / `INVALID_SIZE` results
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 4.2 Write property test for valid, owner-namespaced uploads
    - **Property 6: Valid uploads are stored under the owning user**
    - **Validates: Requirements 2.1**

  - [ ]* 4.3 Write property test for unsupported-type rejection
    - **Property 7: Unsupported types are rejected and store nothing**
    - **Validates: Requirements 2.2**

  - [ ]* 4.4 Write property test for invalid-size rejection
    - **Property 8: Invalid sizes are rejected and store nothing**
    - Generators must cover size boundaries `{0, 1, maxUploadBytes, maxUploadBytes+1}`
    - **Validates: Requirements 2.3**

  - [x] 4.5 Implement Upload_Service orchestration and FileStore wrapper
    - Implement the `FileStore` wrapper over `FileBucket` (owner-namespaced keys `{userId}/{jobId}/...`) and the `ApiNamespace` upload method with strict ordering: getCurrentUser → validate → store → create QUEUED record → enqueue, with compensating actions (`STORAGE_FAILED`, `ENQUEUE_FAILED` → `transition(FAIL)`)
    - _Requirements: 1.3, 2.1, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 4.6 Write property test for unauthenticated upload rejection
    - **Property 3: Unauthenticated uploads are rejected and store nothing**
    - **Validates: Requirements 1.3**

  - [ ]* 4.7 Write property test for single record + single message on success
    - **Property 9: A successful store creates exactly one QUEUED record and one message**
    - **Validates: Requirements 2.4**

  - [ ]* 4.8 Write property test for storage-failure cleanup
    - **Property 10: Storage failure leaves no record and no message**
    - **Validates: Requirements 2.6**

  - [ ]* 4.9 Write property test for enqueue-failure handling
    - **Property 11: Enqueue failure after store marks the record FAILED**
    - **Validates: Requirements 2.7**

  - [ ]* 4.10 Write unit test for upload latency bound
    - Assert the job identifier is returned within 5 seconds for a representative input
    - _Requirements: 2.5_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement asynchronous processing
  - [x] 6.1 Implement the pure progress function
    - Compute a monotonically non-decreasing completion percentage in `[0, 100]` from processing stage
    - _Requirements: 4.4_

  - [ ]* 6.2 Write property test for progress bounds and monotonicity
    - **Property 16: Progress is bounded and monotonically non-decreasing**
    - **Validates: Requirements 4.4**

  - [x] 6.3 Implement the ProcessingHandler
    - Implement idempotent load (discard terminal jobs), `transition(START)` with start timestamp, progress publishing, artifact generation (thumbnail → metadata → transcode) stored via FileStore, `transition(COMPLETE)` with completion timestamp, and error → `transition(FAIL)` with sanitized description; configure the `AsyncJob` Block with `maxReceiveCount = maxProcessingAttempts` and a dead-letter destination
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 6.4 Write property test for successful processing
    - **Property 13: Successful processing stores all artifacts, completes, and records ordered timestamps**
    - **Validates: Requirements 3.2, 3.6**

  - [ ]* 6.5 Write property test for processing-error handling
    - **Property 14: Processing errors produce FAILED with a human-readable description**
    - Generators must cover non-ASCII/special characters in error descriptions
    - **Validates: Requirements 3.3**

  - [ ]* 6.6 Write property test for the retry attempt limit
    - **Property 15: Failing jobs fail only after the configured attempt limit**
    - **Validates: Requirements 3.4**

- [x] 7. Implement the Realtime_Service
  - [x] 7.1 Implement RealtimeService over the `Realtime` Block
    - Implement `authorizeAndSubscribe` (auth at open, per-user channel), `pushStatus`, `pushProgress`, and `onDisconnect`; enforce owner-scoped delivery and silent drop for absent clients
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7_

  - [ ]* 7.2 Write property test for subscription scoping
    - **Property 17: Real-time subscription is scoped to exactly the connecting user**
    - **Validates: Requirements 4.1, 4.2**

  - [ ]* 7.3 Write property test for status push routing
    - **Property 18: Status changes are pushed to the owning user's channel**
    - **Validates: Requirements 4.3**

  - [ ]* 7.4 Write property test for empty-channel discard
    - **Property 19: Messages to empty channels are silently discarded**
    - Generators must cover empty and single-connection channels
    - **Validates: Requirements 4.5**

  - [ ]* 7.5 Write property test for disconnect handling
    - **Property 20: Disconnection removes channel membership**
    - **Validates: Requirements 4.6**

  - [ ]* 7.6 Write property test for owner-only delivery
    - **Property 21: Messages are delivered only to the owner's connections**
    - **Validates: Requirements 4.7**

  - [ ]* 7.7 Write unit test for realtime latency bounds
    - Assert subscribe/status/disconnect complete within 2 seconds for representative cases
    - _Requirements: 4.1, 4.3, 4.6_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement the Email_Client
  - [x] 9.1 Implement EmailService with retry policy and terminal-notification wiring
    - Implement `sendConfirmation`, `sendFailureNotice`, `sendReport` over `EmailClient` with a bounded retry loop (1–10, default 3), permanent-failure handling, and hookup so terminal Job_Record transitions send exactly one addressed email with required content
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 9.2 Write property test for terminal-status emails
    - **Property 22: Terminal status sends exactly one correctly-addressed email with required content**
    - **Validates: Requirements 5.1, 5.2**

  - [ ]* 9.3 Write property test for email retry bound
    - **Property 23: Email sends retry up to the configured maximum**
    - **Validates: Requirements 5.3**

  - [ ]* 9.4 Write property test for retry exhaustion
    - **Property 24: Retry exhaustion logs exactly one permanent failure and stops**
    - **Validates: Requirements 5.4**

  - [ ]* 9.5 Write unit test for email latency bound
    - Assert emails are dispatched within 60 seconds of a terminal status change for a representative case
    - _Requirements: 5.1, 5.2_

- [x] 10. Implement the Cron_Job and Report_Generator
  - [x] 10.1 Implement pure report aggregation and serialization
    - Implement `aggregate` (per-user, per-status counts over the window; exclude inactive users), the reporting-period computation, and `serializeSummary` / `deserializeSummary`
    - _Requirements: 6.1, 6.2, 6.4, 6.8_

  - [ ]* 10.2 Write property test for the reporting period window
    - **Property 25: Reporting period is the 24-hour window ending at the scheduled time**
    - **Validates: Requirements 6.1**

  - [ ]* 10.3 Write property test for report aggregation
    - **Property 26: Report aggregation counts in-window records per user per status and excludes inactive users**
    - Generators must cover empty datasets and out-of-window timestamps
    - **Validates: Requirements 6.2, 6.4**

  - [ ]* 10.4 Write property test for summary serialization round-trip
    - **Property 29: Report summary serialization round-trips**
    - **Validates: Requirements 6.8**

  - [x] 10.5 Implement ReportGenerator.run and CronJob wiring
    - Implement `run(scheduledAt)` reading Job_Records via JobStore queries, storing each summary as a `StoredReport`, and delivering per-user summaries via EmailService with isolated per-user retry scopes; wire the `CronJob` Block trigger
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.8_

  - [ ]* 10.6 Write property test for per-summary email delivery
    - **Property 27: Each produced summary is emailed to its user with the per-status counts**
    - **Validates: Requirements 6.3**

  - [ ]* 10.7 Write property test for delivery isolation
    - **Property 28: One user's report failure does not block delivery to other users**
    - **Validates: Requirements 6.5**

- [x] 11. Implement observability (Logger and Metrics)
  - [x] 11.1 Implement Logger, Metrics, and the `recordTransition` helper
    - Implement structured JSON logging, count/duration metrics, redaction of file contents and credentials, and the helper invoked from `JobStore.transition` and from EmailService/ReportGenerator
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ]* 11.2 Write property test for status-change logging
    - **Property 30: Every status change emits a complete structured log entry**
    - **Validates: Requirements 7.1**

  - [ ]* 11.3 Write property test for processing-duration metric
    - **Property 31: Completion records duration equal to the timestamp difference**
    - **Validates: Requirements 7.2**

  - [ ]* 11.4 Write property test for the failed-job metric
    - **Property 32: Each failure increments the failed-job metric by one**
    - **Validates: Requirements 7.3**

  - [ ]* 11.5 Write property test for email-outcome logging
    - **Property 33: Email-outcome logs match the actual result with required fields**
    - **Validates: Requirements 7.4, 7.5**

  - [ ]* 11.6 Write property test for report-run logging
    - **Property 34: Report runs emit a complete structured log entry**
    - **Validates: Requirements 7.6**

  - [ ]* 11.7 Write property test for log redaction
    - **Property 35: Log entries never contain file contents or credentials**
    - Generators must cover secret/file-content marker strings
    - **Validates: Requirements 7.7**

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Integration and wiring
  - [x] 13.1 Wire all Blocks in the IFC entry point
    - Instantiate all Blocks in one `Scope` in `aws-blocks/index.ts`, expose the upload `ApiNamespace`, inject observability/notification dependencies into JobStore, and select the auth variant (`AuthBasic`/`AuthCognito`) by mode flag while leaving all other Blocks to resolve through conditional exports
    - _Requirements: 1.4, 1.5, 3.8, 3.9, 5.5, 5.6, 6.6, 6.7_

  - [ ]* 13.2 Write smoke/configuration tests for per-mode wiring
    - Assert (via `cdk synth` template assertions and a local-mode boot check) that auth, async processing, email, and cron resolve to the correct Block variant per mode
    - _Requirements: 1.4, 1.5, 3.8, 3.9, 5.5, 5.6, 6.6, 6.7_

  - [ ]* 13.3 Write integration test for dead-letter redrive
    - Verify a message exceeding the attempt limit is routed to the dead-letter destination (SQS sandbox)
    - _Requirements: 3.5_

  - [ ]* 13.4 Write end-to-end integration test
    - Exercise upload → queue → processing → artifact stored → confirmation email in a sandbox deployment, and realtime delivery over a WebSocket connection
    - _Requirements: 2.1, 3.2, 4.3, 5.1_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP.
- Each task references specific requirements (or a design property) for traceability.
- Checkpoints ensure incremental validation.
- Property tests validate the 35 universal correctness properties from the design using `fast-check` (minimum 100 iterations each, one test per property, tagged with the property comment).
- Unit tests cover latency bounds; integration tests cover dead-letter redrive and end-to-end wiring; smoke tests cover per-mode Block selection.
- Application handlers remain mode-agnostic; only the auth variant is selected explicitly in the IFC layer.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "4.1", "6.1", "10.1", "11.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "3.3", "4.2", "4.3", "4.4", "6.2", "10.2", "10.3", "10.4", "11.7"] },
    { "id": 4, "tasks": ["2.6", "2.7", "3.4", "4.5", "7.1", "9.1", "11.2", "11.3", "11.4"] },
    { "id": 5, "tasks": ["4.6", "4.7", "4.8", "4.9", "4.10", "6.3", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "9.2", "9.3", "9.4", "9.5", "10.5", "11.5"] },
    { "id": 6, "tasks": ["6.4", "6.5", "6.6", "10.6", "10.7", "11.6", "13.1"] },
    { "id": 7, "tasks": ["13.2", "13.3", "13.4"] }
  ]
}
```
