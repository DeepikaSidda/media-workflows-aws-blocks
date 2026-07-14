# Requirements Document

## Introduction

This feature is a standalone media upload-and-processing application built on AWS Blocks. It demonstrates the event-driven workflow pattern by composing four core Blocks — background jobs (AsyncJob), scheduled tasks (CronJob), real-time notifications (Realtime), and transactional email (EmailClient) — into workflows that react to application events.

The anchoring scenario: an authenticated user uploads a file, which is stored in object storage and enqueued for asynchronous processing (thumbnail generation, metadata extraction, transcoding). While processing runs, the user's connected client receives live progress updates over a real-time channel. On completion, the user receives a confirmation email. A nightly scheduled job generates a per-user usage summary and emails it. All workflow activity is logged and measured for observability.

Each Block runs locally for development and testing and deploys to managed AWS compute in production. This document captures the functional and quality requirements for the application, including the local-development versus deployed-production behavior of each Block where relevant.

## Glossary

- **Workflow_Platform**: The overall application system that composes all Blocks and orchestrates the upload-processing workflow.
- **Auth_Service**: The authentication Block (AuthCognito in production, AuthBasic for local development) that verifies user identity and issues session credentials.
- **Upload_Service**: The component that accepts file uploads, validates them, and stores them.
- **File_Bucket**: The object-storage Block (Amazon S3) that stores uploaded files and generated artifacts.
- **Async_Job**: The background-processing Block (Amazon SQS + AWS Lambda) that performs fire-and-forget file processing work.
- **Job_Queue**: The message queue (Amazon SQS) that holds pending processing jobs for the Async_Job.
- **Job_Record**: The persisted state of a single processing job, including its status, timestamps, owner, and result or error.
- **Realtime_Service**: The pub/sub Block (Amazon API Gateway WebSocket) that pushes progress and status messages to connected clients.
- **Email_Client**: The transactional email Block (Amazon SES) that sends confirmation and report emails.
- **Cron_Job**: The scheduled-task Block (Amazon EventBridge + AWS Lambda) that runs the nightly report workflow.
- **Report_Generator**: The component that aggregates processing activity into a per-user usage summary.
- **Logger**: The observability component that records structured audit and diagnostic log entries for workflow events.
- **Metrics**: The observability component that records numeric measurements (counts, durations) for workflow events.
- **User**: An authenticated person who owns uploaded files and receives notifications and reports.
- **Job_Status**: The lifecycle state of a Job_Record, one of: QUEUED, PROCESSING, COMPLETED, FAILED.
- **Local_Development_Mode**: The runtime configuration where Blocks run on the developer machine using local emulation instead of managed AWS services.
- **Production_Mode**: The runtime configuration where Blocks run on managed AWS services.

## Requirements

### Requirement 1: User Authentication

**User Story:** As a user, I want to authenticate before using the platform, so that my uploads, notifications, and reports are scoped to my identity.

#### Acceptance Criteria

1. WHEN a User submits valid credentials, THE Auth_Service SHALL issue a session credential identifying that User that expires after a configured session lifetime of 30 minutes.
2. IF a User submits invalid credentials, THEN THE Auth_Service SHALL reject the request and return an authentication error that does not disclose which credential field was incorrect.
3. IF a request to upload a file arrives with a missing, expired, or otherwise invalid session credential, THEN THE Upload_Service SHALL reject the request, return an authorization error, and not store the file.
4. WHERE the Workflow_Platform runs in Production_Mode, THE Auth_Service SHALL verify credentials using AuthCognito.
5. WHERE the Workflow_Platform runs in Local_Development_Mode, THE Auth_Service SHALL verify credentials using AuthBasic.
6. THE Auth_Service SHALL associate every authenticated request with the identifier of the requesting User.
7. IF a User submits invalid credentials on 5 consecutive attempts, THEN THE Auth_Service SHALL reject further authentication attempts from that User for a lockout period of 15 minutes and return an authentication error indicating the account is temporarily locked.

### Requirement 2: File Upload and Validation

**User Story:** As an authenticated user, I want to upload a file and have it validated and stored, so that it can be processed.

#### Acceptance Criteria

1. WHEN an authenticated User submits a file whose type is in the configured set of accepted types and whose size is greater than 0 bytes and at or below the configured maximum size of 104,857,600 bytes (100 MB), THE Upload_Service SHALL store the file in the File_Bucket under the owning User identifier.
2. IF an authenticated User submits a file whose type is not in the configured set of accepted types, THEN THE Upload_Service SHALL reject the upload, retain no stored file, and return a validation error identifying the unsupported type.
3. IF an authenticated User submits a file whose size exceeds the configured maximum size of 104,857,600 bytes (100 MB) or whose size is 0 bytes, THEN THE Upload_Service SHALL reject the upload, retain no stored file, and return a validation error identifying the accepted size range.
4. WHEN the Upload_Service successfully stores a file in the File_Bucket, THE Upload_Service SHALL create exactly one Job_Record with Job_Status set to QUEUED and enqueue one processing message on the Job_Queue.
5. WHEN the Upload_Service creates the Job_Record and enqueues the processing message, THE Upload_Service SHALL return the corresponding job identifier to the User within 5 seconds of the successful store operation.
6. IF the Upload_Service fails to store the file in the File_Bucket, THEN THE Upload_Service SHALL reject the upload, create no Job_Record, enqueue no processing message, and return an error indicating that storage did not complete.
7. IF the Upload_Service stores the file but fails to enqueue the processing message on the Job_Queue, THEN THE Upload_Service SHALL set the corresponding Job_Record Job_Status to FAILED and return an error indicating that the file was stored but not queued for processing.

### Requirement 3: Asynchronous Processing Lifecycle

**User Story:** As a user, I want my uploaded file processed in the background, so that I do not have to wait synchronously for thumbnails, metadata, and transcoding.

#### Acceptance Criteria

1. WHILE the corresponding Job_Record Job_Status is QUEUED, WHEN a processing message is available on the Job_Queue, THE Async_Job SHALL consume the message and set the corresponding Job_Record Job_Status to PROCESSING.
2. WHEN the Async_Job completes thumbnail generation, metadata extraction, and transcoding for a file, THE Async_Job SHALL store the generated artifacts in the File_Bucket and set the corresponding Job_Record Job_Status to COMPLETED.
3. IF a processing step raises an error, THEN THE Async_Job SHALL set the corresponding Job_Record Job_Status to FAILED and record a human-readable error description in the Job_Record.
4. IF a processing attempt fails, THEN THE Async_Job SHALL retry the message up to 3 attempts before setting the Job_Record Job_Status to FAILED.
5. WHEN a processing message exceeds 3 attempts, THE Async_Job SHALL move the message to the configured dead-letter destination.
6. THE Async_Job SHALL record the processing start timestamp and the processing completion timestamp on the Job_Record.
7. IF a consumed message references a Job_Record whose Job_Status is already COMPLETED or FAILED, THEN THE Async_Job SHALL discard the message without reprocessing it and without changing the Job_Record Job_Status.
8. WHERE the Workflow_Platform runs in Local_Development_Mode, THE Async_Job SHALL consume messages from a local queue emulation.
9. WHERE the Workflow_Platform runs in Production_Mode, THE Async_Job SHALL consume messages from Amazon SQS and run on AWS Lambda.

### Requirement 4: Real-Time Progress Notifications

**User Story:** As a user, I want live progress updates while my file is processing, so that I can see status without refreshing.

#### Acceptance Criteria

1. WHEN an authenticated User opens a real-time connection, THE Realtime_Service SHALL subscribe that connection to the channel scoped to the requesting User within 2 seconds of the connection request.
2. IF a client attempts to open a real-time connection without a valid session credential, THEN THE Realtime_Service SHALL reject the connection attempt and return an authorization error without creating a channel subscription.
3. WHEN a Job_Record Job_Status changes, THE Realtime_Service SHALL push a status message containing the job identifier and the new Job_Status to the owning User channel within 2 seconds of the change.
4. WHILE a job is in Job_Status PROCESSING, THE Async_Job SHALL publish, at least once every 15 seconds, a progress message containing a completion percentage in the inclusive range 0 to 100 to the owning User channel, where each successive percentage for the same job is greater than or equal to the previous percentage.
5. IF a status message or progress message targets a User channel with no connected client, THEN THE Realtime_Service SHALL discard the message and take no further delivery action without raising an error.
6. WHEN a client disconnects, THE Realtime_Service SHALL remove that connection from its subscribed channel within 2 seconds of detecting the disconnection.
7. THE Realtime_Service SHALL deliver status messages and progress messages only to connections owned by the User associated with the job, and SHALL deliver no message for a job to any connection owned by a different User.

### Requirement 5: Completion Confirmation Email

**User Story:** As a user, I want an email when my file finishes processing, so that I am notified even when I am not connected.

#### Acceptance Criteria

1. WHEN a Job_Record Job_Status changes to COMPLETED, THE Email_Client SHALL, within 60 seconds of the status change, send exactly one confirmation email to the owning User's registered email address containing the job identifier and a summary listing each generated artifact.
2. WHEN a Job_Record Job_Status changes to FAILED, THE Email_Client SHALL, within 60 seconds of the status change, send exactly one notification email to the owning User's registered email address containing the job identifier and the error description recorded on the Job_Record.
3. IF the Email_Client fails to send an email, THEN THE Email_Client SHALL record the failure through the Logger and retry sending up to a configured maximum retry count between 1 and 10 attempts, defaulting to 3 attempts.
4. IF the Email_Client exhausts the configured maximum retry count without a successful send, THEN THE Email_Client SHALL record a permanent-failure entry through the Logger identifying the job identifier and the owning User, and SHALL stop further retry attempts for that email.
5. WHERE the Workflow_Platform runs in Local_Development_Mode, THE Email_Client SHALL write outbound emails to a local sink instead of dispatching through Amazon SES.
6. WHERE the Workflow_Platform runs in Production_Mode, THE Email_Client SHALL dispatch emails through Amazon SES.

### Requirement 6: Nightly Scheduled Report

**User Story:** As a user, I want a nightly usage summary of my processing activity, so that I can track what was processed.

#### Acceptance Criteria

1. WHEN the configured nightly schedule time is reached, THE Cron_Job SHALL trigger the Report_Generator for the reporting period defined as the 24-hour window ending at that scheduled time.
2. WHEN the Report_Generator runs, THE Report_Generator SHALL aggregate, per User, the count of Job_Records grouped by each Job_Status value (QUEUED, PROCESSING, COMPLETED, FAILED) whose completion timestamp falls within the reporting period.
3. WHEN the Report_Generator produces a per-User summary, THE Email_Client SHALL send that summary, containing the per-Job_Status counts for the reporting period, to the corresponding User.
4. IF a User has zero Job_Records with a completion timestamp within the reporting period, THEN THE Report_Generator SHALL exclude that User from report delivery.
5. IF the Email_Client fails to send a per-User summary, THEN THE Email_Client SHALL record the failure through the Logger and retry up to the configured maximum retry count before discarding that summary without blocking delivery to other Users.
6. WHERE the Workflow_Platform runs in Production_Mode, THE Cron_Job SHALL be triggered by Amazon EventBridge and run on AWS Lambda.
7. WHERE the Workflow_Platform runs in Local_Development_Mode, THE Cron_Job SHALL be triggerable on demand through a local invocation command.
8. THE Report_Generator SHALL serialize each per-User summary to a stored report record, and deserializing a stored report record SHALL reproduce a summary with identical per-User and per-Job_Status counts and reporting period (round-trip property).

### Requirement 7: Observability and Audit Logging

**User Story:** As an operator, I want workflow events logged and measured, so that I can audit activity and diagnose failures.

#### Acceptance Criteria

1. WHEN a Job_Record Job_Status changes, THE Logger SHALL record a structured log entry containing the job identifier, the owning User identifier, the previous Job_Status, the new Job_Status, and a timestamp.
2. WHEN the Async_Job sets a Job_Record Job_Status to COMPLETED, THE Metrics SHALL record the processing duration for that job in milliseconds, computed as the difference between the Job_Record completion timestamp and the Job_Record start timestamp.
3. WHEN the Async_Job sets a Job_Record Job_Status to FAILED, THE Metrics SHALL increment the failed-job count by 1.
4. WHEN the Email_Client sends an email successfully, THE Logger SHALL record a structured log entry containing the recipient User identifier, the email type as one of CONFIRMATION, FAILURE_NOTIFICATION, or REPORT_SUMMARY, an outcome indicator denoting success, and a timestamp.
5. IF the Email_Client fails to send an email, THEN THE Logger SHALL record a structured log entry containing the recipient User identifier, the email type as one of CONFIRMATION, FAILURE_NOTIFICATION, or REPORT_SUMMARY, an outcome indicator denoting failure, and a timestamp.
6. WHEN the Cron_Job triggers the Report_Generator, THE Logger SHALL record a structured log entry containing the reporting period start timestamp, the reporting period end timestamp, the count of Users included in report delivery, and a timestamp.
7. THE Logger SHALL exclude file contents and credentials from all log entries.
