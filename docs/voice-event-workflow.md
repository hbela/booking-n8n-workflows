# Voice Agent Pro: Agentic Booking with TTS and Robust Error Handling

**Workflow ID:** `XS1G1gyAzzS1uDAN`
**Webhook Path:** `POST /voice-agent-pro`
**Status:** Inactive (must be activated in n8n)

---

## Overview

This n8n workflow implements a **voice-powered booking assistant** for healthcare appointments. It accepts audio input via a webhook, transcribes the speech, uses an LLM to understand the user's intent, executes the appropriate booking API action, and returns a spoken audio response — all in a single request/response cycle.

The workflow is **agentic**: the LLM decides which action to take at each turn based on the conversation history and current session state, rather than following a fixed script.

---

## Architecture Diagram

```
                                HAPPY PATH
                                ----------
Webhook Trigger
    |
    v
OpenAI Speech-to-Text  (transcribe audio to text)
    |
    v
Context Builder (History)  (build LLM prompt with session state + history)
    |
    v
OpenAI Chat Completion (Agent)  (LLM decides intent + action)
    |
    v
Parse Action & Update History  (extract action type, update conversation history)
    |
    v
Switch Action Type  ──────────────────────────────────────────────────┐
    |           |              |              |              |         |         |
    v           v              v              v              v         v         v
 Search Org  List Depts   List Providers  Query Avail.  Create     auth_req  fallback
    |           |              |              |          Booking       |         |
    └───────────┴──────────────┴──────────────┴────────────┘          |         |
                               |                                      |         |
                               v                                      |         |
                     API Response Handler                             |         |
                               |                                      |         |
                               v                                      |         |
                     LLM: Summarize API Result                        |         |
                               |                                      |         |
                               v                                      |         |
                     Transaction Logger                               |         |
                               |                                      |         |
                               v                                      v         v
                     OpenAI Text-to-Speech  <──────────────────────────┘─────────┘
                               |
                               v
                     Webhook Response (Final)


                              ERROR PATH
                              ----------
                     Error Handler  (catch any node failure)
                               |
                               v
                     Error TTS  (speak the error message)
                               |
                               v
                     Webhook Response (Error)
```

---

## Node-by-Node Reference

### 1. Webhook Trigger

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.webhook` v1.1 |
| **Method** | `POST` |
| **Path** | `/voice-agent-pro` |
| **Response Mode** | `responseNode` (response sent by a downstream Respond to Webhook node) |

**Expected request body:**

| Field | Type | Description |
|---|---|---|
| `audio` | binary | The user's voice recording (sent as form-data or base64) |
| `sessionId` | string | Unique session identifier for multi-turn conversations |
| `sessionState` | string (JSON) | Serialized session state from the previous turn |
| `authToken` | string | Bearer token for authenticated API calls |

---

### 2. OpenAI Speech-to-Text

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.openAi` v1 |
| **Resource** | `audio` |
| **Operation** | `transcribe` |

Takes the binary audio from the webhook and transcribes it to text using OpenAI's Whisper API. Output includes a `text` field with the transcript.

---

### 3. Context Builder (History)

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.code` v2 |

A Function node that assembles the full LLM prompt. It:

1. **Deserializes session state** from the webhook payload (`sessionState` JSON string)
2. **Extracts the transcript** from the STT output
3. **Reconstructs conversation history** from the session state
4. **Builds a system prompt** that instructs the LLM to:
   - Act as a professional voice booking assistant
   - Be aware of the current booking step
   - Respond with a structured JSON object containing `responseText`, `action`, and `sessionUpdate`

**Output shape:**

```json
{
  "systemPrompt": "You are a helpful...",
  "messages": [{ "role": "user", "content": "..." }, ...],
  "sessionId": "abc-123",
  "authToken": "Bearer ...",
  "sessionState": "{...}",
  "originalTranscript": "I'd like to book an appointment"
}
```

---

### 4. OpenAI Chat Completion (Agent)

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.openAi` v1 |
| **Operation** | `chatCompletion` |

Sends the system prompt and message history to OpenAI's Chat API. The LLM returns a structured JSON response specifying what action to take.

**LLM response format:**

```json
{
  "responseText": "I found 3 organizations matching 'Downtown Clinic'...",
  "action": {
    "type": "search_org",
    "parameters": { "query": "Downtown Clinic" }
  },
  "sessionUpdate": {
    "currentStep": "org_search",
    "conversationHistory": [...]
  }
}
```

---

### 5. Parse Action & Update History

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.code` v2 |

Parses the LLM's JSON response and:

1. **Extracts** `actionType`, `actionParams`, and `responseText`
2. **Appends** the current user/assistant exchange to conversation history
3. **Trims history** to the last 5 turns (10 messages) to stay within token limits
4. **Flags** whether the action requires an API call (`requiresApiCall` boolean)

If the LLM returns malformed JSON, it falls back to a `continue_conversation` action with a polite retry prompt.

---

### 6. Switch Action Type

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.switch` v3 |
| **Fallback** | `extra` output (catch-all) |

Routes execution based on `actionType`:

| Output | Action Type | Destination |
|---|---|---|
| 0 | `search_org` | API: Search Organizations |
| 1 | `list_departments` | API: List Departments |
| 2 | `list_providers` | API: List Providers |
| 3 | `query_availability` | API: Query Availability |
| 4 | `create_booking` | API: Create Booking |
| 5 | `auth_required` | OpenAI Text-to-Speech (skip API) |
| fallback | `continue_conversation`, `help`, etc. | OpenAI Text-to-Speech (skip API) |

---

### 7. API Nodes

All API nodes call endpoints on a Fastify backend configured via the `FASTIFY_API_URL` environment variable.

#### API: Search Organizations

| Property | Value |
|---|---|
| **Method** | `GET` |
| **URL** | `{FASTIFY_API_URL}/api/organizations/search` |
| **Auth** | None (public endpoint) |

Searches for organizations by name or keyword.

#### API: List Departments

| Property | Value |
|---|---|
| **Method** | `GET` |
| **URL** | `{FASTIFY_API_URL}/api/client/organizations/{orgId}/departments` |
| **Auth** | Header-based (auth token from session) |

Lists departments within a selected organization.

#### API: List Providers

| Property | Value |
|---|---|
| **Method** | `GET` |
| **URL** | `{FASTIFY_API_URL}/api/client/departments/{deptId}/providers` |
| **Auth** | Header-based |

Lists providers (doctors, specialists) within a department.

#### API: Query Availability

| Property | Value |
|---|---|
| **Method** | `GET` |
| **URL** | `{FASTIFY_API_URL}/api/client/providers/{providerId}/available-events` |
| **Auth** | Header-based |

Retrieves available appointment slots for a specific provider.

#### API: Create Booking

| Property | Value |
|---|---|
| **Method** | `POST` |
| **URL** | `{FASTIFY_API_URL}/api/client/bookings` |
| **Auth** | Header-based |

Creates a new appointment booking.

---

### 8. API Response Handler

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.code` v2 |

Inspects the HTTP status code from any API call:

| Status | Behavior |
|---|---|
| `401` | Returns `auth_required` action with a login prompt |
| `>= 400` | Returns `continue_conversation` with a user-friendly error message |
| `2xx` | Passes the API response through to the summarization LLM |

---

### 9. LLM: Summarize API Result

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.openAi` v1 |
| **Operation** | `chatCompletion` |

Takes the raw API response data and generates a **natural-language summary** suitable for speaking to the user. For example, converting a JSON array of available time slots into "Dr. Smith has openings on Tuesday at 2 PM and Thursday at 10 AM."

---

### 10. Transaction Logger

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.httpRequest` v4.2 |
| **Method** | `POST` |
| **URL** | `{LOGGING_API_URL}/log/voice-agent` |

Logs the complete transaction (transcript, action taken, API response, final reply) to an external logging service for audit and analytics.

---

### 11. OpenAI Text-to-Speech

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.openAi` v1 |
| **Resource** | `audio` |
| **Operation** | `speak` |

Converts the final text response into spoken audio using OpenAI's TTS API. This node receives input from both:
- The **API path** (after summarization and logging)
- The **non-API path** (auth_required, continue_conversation, help — directly from the Switch)

---

### 12. Webhook Response (Final)

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.respondToWebhook` v1.1 |
| **Responds With** | `json` |

Sends the final response back to the calling client, including:
- Audio data (TTS output)
- Updated session state (for the client to send back on the next turn)

---

### 13. Error Handler

| Property | Value |
|---|---|
| **Type** | `n8n-nodes-base.code` v2 |

Catches errors from any node in the workflow (STT failures, LLM timeouts, API errors). Produces a friendly error message: *"I am sorry, I seem to have run into a technical issue..."*

---

### 14. Error TTS + Webhook Response (Error)

The error path mirrors the happy path's final stages: the error message is converted to speech via **Error TTS**, then returned to the client via **Webhook Response (Error)**.

---

## Session State Management

The workflow is **stateless on the server side**. All state is maintained by the client through a serialized `sessionState` JSON object passed in each request. This includes:

| Field | Description |
|---|---|
| `currentStep` | Current position in the booking flow |
| `selectedOrganizationId` | The org chosen by the user |
| `selectedDepartmentId` | The department chosen by the user |
| `selectedProviderId` | The provider chosen by the user |
| `userId` | Authenticated user ID |
| `conversationHistory` | Last 5 turns (10 messages) of conversation |

### Booking Flow Steps

```
org_search  -->  org_selected  -->  auth_required  -->  dept_selection
                                                            |
                                                            v
                                          provider_selection  -->  availability_query
                                                                         |
                                                                         v
                                                                      booking
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `FASTIFY_API_URL` | Base URL for the booking backend API (e.g. `https://api.example.com`) |
| `LOGGING_API_URL` | Base URL for the transaction logging service |

---

## Required Credentials

| Service | Credential Type | Used By |
|---|---|---|
| OpenAI | API Key | Speech-to-Text, Chat Completion (Agent), LLM Summarize, Text-to-Speech, Error TTS |
| Booking API | Header Auth (Bearer token) | List Departments, List Providers, Query Availability, Create Booking |

---

## Action Types Reference

| Action Type | Requires API Call | Description |
|---|---|---|
| `search_org` | Yes | Search for organizations by name/keyword |
| `select_org` | No | User confirms an organization selection (handled conversationally) |
| `list_departments` | Yes | Fetch departments for a selected organization |
| `list_providers` | Yes | Fetch providers for a selected department |
| `query_availability` | Yes | Fetch available time slots for a provider |
| `create_booking` | Yes | Create a new appointment booking |
| `auth_required` | No | Prompt the user to authenticate |
| `continue_conversation` | No | General conversational response (no API action needed) |
| `help` | No | Provide help/guidance to the user |

---

## Error Handling Strategy

1. **LLM JSON parse failure** — The Parse Action node falls back to `continue_conversation` with a polite retry message
2. **API 401 Unauthorized** — The API Response Handler redirects to an `auth_required` flow
3. **API 4xx/5xx errors** — A user-friendly error message is generated without exposing internals
4. **Node-level failures** (STT, LLM, network) — The Error Handler catches the exception, generates a spoken error response via the Error TTS path, and returns it to the client

---

## Typical Request/Response Flow

**Example: User asks to find a clinic**

1. Client sends `POST /voice-agent-pro` with audio: *"Find me a dental clinic near downtown"*
2. **STT** transcribes to text: `"Find me a dental clinic near downtown"`
3. **Context Builder** assembles the prompt with `currentStep: org_search`
4. **LLM** responds: `{ actionType: "search_org", parameters: { query: "dental clinic downtown" } }`
5. **Switch** routes to **API: Search Organizations**
6. **API** returns 3 matching organizations
7. **API Response Handler** confirms success
8. **LLM Summarize** produces: *"I found 3 dental clinics near downtown: Smile Dental on Main Street, Downtown Dental Care, and Bright Teeth Clinic. Which one would you like?"*
9. **Transaction Logger** logs the interaction
10. **TTS** converts the summary to audio
11. **Webhook Response** returns audio + updated session state to the client
