# Apex Quantel Protocol

Versioned contracts shared by the private Signal Engine, Execution Gateway,
installed Execution Engines, and customer dashboard.

## Design Rules

- Every message uses the common envelope in `schemas/envelope.schema.json`.
- `protocol_version` changes only for wire-level breaking changes.
- Event names are namespaced and stable.
- Message IDs make delivery and command handling idempotent.
- Times use UTC ISO 8601 strings.
- Released signals expose execution instructions, not private strategy internals.
- Unknown payload fields are rejected unless a schema explicitly permits them.

## Protocol v1 Events

Gateway to engine:

- `signal.deliver`
- `command.pause`
- `command.resume`
- `command.emergency_stop`

Engine to gateway:

- `activation.request`
- `engine.hello`
- `engine.heartbeat`
- `room.subscribe`
- `room.unsubscribe`
- `telemetry.snapshot`
- `execution.lifecycle`
- `command.completed`
- `command.failed`

`execution.lifecycle` reports only the installed engine's handling state:
`received`, `accepted`, `rejected`, `attempted`, `opened`, or `failed`.
It references a signal by ID but never copies the signal payload or private
strategy data into the Gateway database.

## Native WebSocket Transport

Execution Engine control-plane messages use Nest's native WebSocket
`event`/`data` transport wrapper. This allows the Gateway to route messages
through `@SubscribeMessage()` without manually parsing every socket frame.

The outer `event` selects the Gateway handler. The inner `data` object is the
versioned Apex Quantel message.

## Transport Example

```json
{
  "event": "engine.heartbeat",
  "data": {
    "protocol_version": "1.0",
    "message_id": "01J...",
    "sent_at": "2026-06-06T12:00:00.000Z",
    "payload": {
      "engine_id": "device-id",
      "status": "running",
      "sequence": 42
    }
  }
}
```

The Gateway combines the outer event with the inner data before validating
against `envelope.schema.json` and the event payload schema.

Released `signal.triggered` delivery currently preserves the existing Signal
Engine `{ event, payload }` frame so the current Execution Engine signal parser
remains compatible during migration.

## Validation

All payload schemas are JSON Schema Draft 2020-12 and can be validated by both
the NestJS Gateway and Python Execution Engine.
