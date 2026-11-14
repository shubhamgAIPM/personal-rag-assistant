# Orbit Notes: Architecture Notes

*Fictional sample document for the public demo. Orbit Notes is not a real product.*

## Overview

Orbit Notes is a web application with three parts: a React frontend, a backend API, and a PostgreSQL database. Notes are stored as plain Markdown text so they can always be exported.

## Technology choices

The frontend uses React with TypeScript. The backend API is written in Node.js. We chose PostgreSQL over a document database because decisions and action items need relational links to notes, people and dates, and because the team already has strong PostgreSQL experience.

## Search design

Search combines two techniques. Keyword search handles exact terms such as names and ticket numbers. Semantic search uses text embeddings so that a question like "why did we drop the calendar feature?" can find a note that never uses the word "drop". Notes are split into chunks of about 300 words before they are embedded.

## Decision extraction

When a note is saved, a background job reads it and proposes decisions and action items. A person must confirm each proposal before it is stored as an official decision. We chose human confirmation because early tests showed that fully automatic extraction made about one mistake in every ten decisions.

## Performance targets

- Opening a note: under 300 milliseconds.
- Search results: under 1.5 seconds for workspaces with up to 10,000 notes.
- Availability target: 99.5 percent per month.

## Security

All data is encrypted in transit and at rest. Each workspace is isolated, and members can only see notes in workspaces they belong to. Notes are never used to train external models.

## Known limitations

Search quality drops for very short notes with little context. Extraction accuracy is lower for notes that are not written in English.

## Data model

The database has five main tables: workspaces, members, notes, decisions and action items. A decision links to the note it came from, the people involved and a date. An action item links to a note, an owner and a due date. Deleting a note marks its decisions as "source removed" instead of deleting them, so the decision history is never silently lost.

## Environments and deployment

There are three environments: development, staging and production. Every change goes through a pull request with at least one reviewer and automated tests. Changes deploy to staging first, and a release to production happens only after the staging checks pass. Production releases happen on Tuesdays and Thursdays, never on Fridays.

Database changes are made with versioned migrations. Every migration must have a tested rollback before it is approved.

## Monitoring and alerts

The team tracks error rate, search latency and extraction job failures. An alert goes to the on-call engineer when the error rate stays above 2 percent for five minutes, or when search takes longer than 3 seconds for more than 5 percent of requests. The on-call rotation changes weekly among four engineers.

## Cost estimate

For the private beta with 20 teams, the estimated monthly infrastructure cost is about 600 dollars: roughly 250 dollars for the database, 150 dollars for application servers, 120 dollars for embeddings and language model usage, and 80 dollars for monitoring and backups. The cost per active member is expected to fall as usage grows.

## Backups and recovery

The database is backed up every night and retained for 30 days. The recovery goal is to restore service within 4 hours and to lose no more than 24 hours of data.
