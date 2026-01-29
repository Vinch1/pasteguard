# PasteGuard: PII Masking Technical Guide

## Overview

PasteGuard is a privacy proxy that detects and masks Personally Identifiable Information (PII) before sending requests to LLM providers like OpenAI and Anthropic. This document explains the complete flow of how PII masking works from request to response.

## Architecture

### High-Level Flow

```
User Request
    ↓
┌─────────────────────────────────┐
│  1. Validate Request            │ (Schema validation)
├─────────────────────────────────┤
│  2. Process Secrets             │ (Detect & mask API keys, tokens)
├─────────────────────────────────┤
│  3. Detect PII                  │ (Send to Microsoft Presidio)
├─────────────────────────────────┤
│  4. Mask PII                    │ (Replace with placeholders)
├─────────────────────────────────┤
│  5. Send to LLM Provider        │ (OpenAI/Anthropic)
├─────────────────────────────────┤
│  6. Unmask Response             │ (Restore original values)
└─────────────────────────────────┘
    ↓
User Response (with original data restored)
```

### Two Operating Modes

#### 1. **Mask Mode** (Default)
- Mask all PII before sending to external LLM
- Send masked text to OpenAI/Anthropic
- Unmask the response before returning to user
- Data never leaves your control while unmasked

#### 2. **Route Mode**
- If PII is detected: send request to local LLM (Ollama, vLLM)
- If no PII: send to OpenAI/Anthropic
- Sensitive data never leaves your network

## Detailed Masking Process

### Phase 1: Text Extraction

**File**: [src/masking/extractors/openai.ts](src/masking/extractors/openai.ts)

The system extracts all text content from the request using a `RequestExtractor` interface:

```typescript
interface RequestExtractor<TRequest, TResponse> {
  extractTexts(request: TRequest): TextSpan[];
  applyMasked(request: TRequest, maskedSpans: MaskedSpan[]): TRequest;
  unmaskResponse(response: TResponse, context: PlaceholderContext): TResponse;
}
```

**Example: Extracting text from OpenAI request**

```typescript
// Input: OpenAI chat completion request
{
  "model": "gpt-4",
  "messages": [
    {
      "role": "user",
      "content": "Email Dr. Sarah Chen at sarah@hospital.org"
    }
  ]
}

// Extracted spans:
[
  {
    text: "Email Dr. Sarah Chen at sarah@hospital.org",
    path: "messages[0].content",
    messageIndex: 0,
    partIndex: 0
  }
]
```

**Key Points:**
- Supports both plain text and multimodal content (images, etc.)
- Preserves message indices for later reconstruction
- Each span includes path information for reassembly

### Phase 2: PII Detection

**File**: [src/pii/detect.ts](src/pii/detect.ts)

Text spans are sent to **Microsoft Presidio** service running in Docker to detect PII entities:

```typescript
export interface PIIEntity {
  entity_type: string;  // e.g., "PERSON", "EMAIL_ADDRESS"
  start: number;        // Character position
  end: number;          // Character position
  score: number;        // Confidence (0-1)
}
```

**Detection Process:**

```
Text: "Email Dr. Sarah Chen at sarah@hospital.org"
        ↓
[Send to Presidio /analyze endpoint]
        ↓
[
  {
    entity_type: "PERSON",
    start: 7,
    end: 21,
    score: 0.85
  },
  {
    entity_type: "EMAIL_ADDRESS",
    start: 26,
    end: 47,
    score: 0.95
  }
]
```

**Configuration** (from [src/config.ts](src/config.ts)):

```typescript
pii_detection: {
  enabled: boolean;
  presidio_url: string;        // e.g., "http://localhost:5002"
  entities: string[];          // ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", ...]
  score_threshold: number;     // Minimum confidence (default: 0.5)
  whitelist: string[];         // Values to exclude from masking
  languages: string[];         // Supported language codes
}
```

### Phase 3: Conflict Resolution

**File**: [src/masking/conflict-resolver.ts](src/masking/conflict-resolver.ts)

When PII entities overlap, conflicts must be resolved using Microsoft Presidio's algorithm:

```
Text: "john@john.com"
       ↓
Presidio detects:
  - PERSON: "john" (start:0, end:4)
  - EMAIL_ADDRESS: "john@john.com" (start:0, end:13)
       ↓
Resolve conflicts → Keep highest confidence or largest span
       ↓
Result: EMAIL_ADDRESS wins (covers the whole email)
```

**Algorithm:**
1. Group entities by type
2. Merge overlapping entities of the same type
3. Remove lower-confidence entities that overlap with higher ones

```typescript
export function resolveConflicts<T extends EntityWithScore>(entities: T[]): T[] {
  // 1. Group by entity_type
  // 2. Merge overlapping within groups
  // 3. Remove cross-type conflicts (keep higher score)
  // 4. If same score, keep longer entity
}
```

### Phase 4: Placeholder Generation & Masking

**File**: [src/masking/placeholders.ts](src/masking/placeholders.ts)

Detected PII entities are replaced with placeholders:

```typescript
// Placeholder format for PII
export const PII_PLACEHOLDER_FORMAT = "[[{TYPE}_{N}]]";

// Example generations:
// - PERSON_1, PERSON_2
// - EMAIL_ADDRESS_1
// - PHONE_NUMBER_1
```

**Context Structure:**

```typescript
interface PlaceholderContext {
  mapping: Record<string, string>;           // [[PERSON_1]] → "Sarah Chen"
  reverseMapping: Record<string, string>;    // "Sarah Chen" → [[PERSON_1]]
  counters: Record<string, number>;          // { PERSON: 1, EMAIL_ADDRESS: 1 }
}
```

**Masking Example:**

```
Original text: "Email Dr. Sarah Chen at sarah@hospital.org"
                    ↓
PII entities:
  - PERSON (7-21): "Dr. Sarah Chen"
  - EMAIL_ADDRESS (26-47): "sarah@hospital.org"
                    ↓
Generate placeholders:
  - [[PERSON_1]] for "Dr. Sarah Chen"
  - [[EMAIL_ADDRESS_1]] for "sarah@hospital.org"
                    ↓
Masked text: "Email [[PERSON_1]] at [[EMAIL_ADDRESS_1]]"
                    ↓
Context mapping:
  {
    "[[PERSON_1]]": "Dr. Sarah Chen",
    "[[EMAIL_ADDRESS_1]]": "sarah@hospital.org"
  }
```

**Core Masking Function** ([src/pii/mask.ts](src/pii/mask.ts)):

```typescript
export function mask(
  text: string,
  entities: PIIEntity[],
  context?: PlaceholderContext
): MaskResult {
  return {
    masked: string;              // Text with placeholders
    context: PlaceholderContext; // Mapping for unmasking
  }
}
```

### Phase 5: Request Transformation

**File**: [src/masking/extractors/openai.ts](src/masking/extractors/openai.ts)

Masked spans are reassembled back into the original request structure:

```typescript
// Step 1: Extract spans
const spans = openaiExtractor.extractTexts(originalRequest);
// [{ text: "Email Dr. Sarah Chen...", messageIndex: 0, partIndex: 0 }]

// Step 2: Mask each span
const maskedSpans = maskSpans(spans, entities, ...);
// [{ maskedText: "Email [[PERSON_1]] at [[EMAIL_ADDRESS_1]]", messageIndex: 0, partIndex: 0 }]

// Step 3: Apply masked spans back to request
const maskedRequest = openaiExtractor.applyMasked(originalRequest, maskedSpans);

// Result:
{
  "model": "gpt-4",
  "messages": [
    {
      "role": "user",
      "content": "Email [[PERSON_1]] at [[EMAIL_ADDRESS_1]]"
    }
  ]
}
```

### Phase 6: Sending to LLM Provider

**File**: [src/routes/openai.ts](src/routes/openai.ts)

The masked request is sent to the LLM provider (OpenAI/Anthropic):

```typescript
// Masked request goes to OpenAI
const response = await callOpenAI(maskedRequest, config, authHeader);

// OpenAI sees:
// "Email [[PERSON_1]] at [[EMAIL_ADDRESS_1]]"

// OpenAI's response:
{
  "choices": [{
    "message": {
      "content": "I'll email [[PERSON_1]] at [[EMAIL_ADDRESS_1]] with the information."
    }
  }]
}
```

### Phase 7: Response Unmasking

**File**: [src/pii/mask.ts](src/pii/mask.ts)

The response is unmasked by replacing placeholders with original values:

```typescript
export function unmask(
  text: string,
  context: PlaceholderContext,
  config: MaskingConfig
): string {
  // Replace all [[PLACEHOLDER]] with original values
  // Result: "I'll email Dr. Sarah Chen at sarah@hospital.org..."
}
```

**Process:**
1. Find all placeholders in response (regex: `\[\[.*?\]\]`)
2. Look up each placeholder in context mapping
3. Replace with original value

## Streaming Support

**File**: [src/providers/openai/stream-transformer.ts](src/providers/openai/stream-transformer.ts)

For streaming responses, unmasking happens in real-time as chunks arrive:

```typescript
// Stream of SSE events from OpenAI
data: {"choices":[{"delta":{"content":"I'll"}}]}
data: {"choices":[{"delta":{"content":" email"}}]}
data: {"choices":[{"delta":{"content":" [[PERSON"}}]}
data: {"choices":[{"delta":{"content":"_1]]"}}]}
data: [DONE]
         ↓
       [Unmask transformer]
         ↓
// Stream sent to client with original data
data: {"choices":[{"delta":{"content":"I'll"}}]}
data: {"choices":[{"delta":{"content":" email"}}]}
data: {"choices":[{"delta":{"content":" Dr. Sarah Chen"}}]}
data: [DONE]
```

**Key Challenge: Partial Placeholders**

Placeholders like `[[PERSON_1]]` can be split across chunk boundaries:

```
Chunk 1: "...[[PERSO"
Chunk 2: "N_1]] is here"
```

**Solution: Buffering**

```typescript
let buffer = "";
let output = "";

for (const chunk of streamChunks) {
  const combined = buffer + chunk;
  
  // Find safe unmask position
  const partialStart = findPartialPlaceholderStart(combined);
  
  if (partialStart === -1) {
    // All placeholders complete - safe to unmask
    output = unmask(combined);
    buffer = "";
  } else {
    // Keep incomplete placeholder in buffer
    output = unmask(combined.slice(0, partialStart));
    buffer = combined.slice(partialStart);
  }
  
  yield output;
}

// Final flush at end of stream
yield unmask(buffer);
```

## Combining Multiple Masking Layers

PasteGuard can mask both **PII and Secrets** simultaneously:

```
Original: "My API key is sk_live_12345 and email is john@example.com"
                  ↓
         [Secrets masking]
         "My API key is [[API_KEY_1]] and email is john@example.com"
                  ↓
         [PII masking]
         "My API key is [[API_KEY_1]] and email is [[EMAIL_ADDRESS_1]]"
                  ↓
         [Context]
         {
           "[[API_KEY_1]]": "sk_live_12345",
           "[[EMAIL_ADDRESS_1]]": "john@example.com"
         }
```

**Single Context for Both:**

```typescript
// PII masking
const piiResult = maskPII(request, detection, extractor);

// Secrets masking (reuses PII context)
const secretsResult = maskSecrets(piiResult.request, piiResult.context);

// Single unified context for both
const unifiedContext = {
  ...piiResult.maskingContext,
  ...secretsResult.maskingContext
};
```

## Error Handling

### PII Detection Errors

If Presidio is unavailable, responses fail gracefully:

```typescript
if (!config.pii_detection.enabled) {
  // Skip detection entirely
  return { hasPII: false, allEntities: [] };
}

try {
  return await detectPII(request);
} catch (error) {
  console.error("PII detection error:", error);
  return respondDetectionError(c);
}
```

### Whitelisting

Prevent false positives by whitelisting common phrases:

```yaml
pii_detection:
  whitelist:
    - "You are Claude Code, Anthropic's official CLI for Claude."
```

Example: "Claude" won't be masked as a PERSON if it matches a whitelist entry.

## Configuration Example

**config.yaml**

```yaml
pii_detection:
  enabled: true
  presidio_url: http://presidio:5002
  score_threshold: 0.5
  entities:
    - PERSON
    - EMAIL_ADDRESS
    - PHONE_NUMBER
    - CREDIT_CARD
    - IBAN
    - IP_ADDRESS
  languages:
    - en
    - de
    - fr
  whitelist:
    - "Claude Code"

masking:
  show_markers: false          # Show [[...]] or just original text?
  marker_text: "[protected]"   # Prefix for show_markers: true

mode: mask                      # "mask" or "route"

providers:
  openai:
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}
```

## Performance Considerations

### Detection Latency
- **Presidio analysis**: ~100-500ms per request (depends on text length)
- **Conflict resolution**: ~1-5ms (typically <10 entities)
- **Placeholder replacement**: ~1-10ms

### Memory Usage
- **Placeholder context**: ~100 bytes per PII entity
- **Text spans**: ~200 bytes per message
- **Streaming buffers**: ~1KB (for partial placeholder handling)

### Optimization Tips
1. **Reduce entity types** in config to only needed ones
2. **Increase score_threshold** to 0.7+ (less false positives, faster)
3. **Use language-specific Presidio** image for supported languages
4. **Cache context** for multi-turn conversations (session-based)

## Data Flow Diagram

```
┌─────────────────┐
│  User Request   │
│ (Original PII)  │
└────────┬────────┘
         │
         ▼
    ┌────────────────────┐
    │ Text Extraction    │
    │ (Remove from JSON) │
    └────────┬───────────┘
             │
             ▼
    ┌──────────────────────┐
    │ Presidio Detection   │
    │ (Identify PII spans) │
    └────────┬─────────────┘
             │
             ▼
    ┌──────────────────────┐
    │ Conflict Resolution  │
    │ (Remove overlaps)    │
    └────────┬─────────────┘
             │
             ▼
    ┌──────────────────────┐
    │ Placeholder Gen      │
    │ (Create mapping)     │
    └────────┬─────────────┘
             │
             ▼
    ┌──────────────────────┐
    │ Span Masking         │
    │ (Replace entities)   │
    └────────┬─────────────┘
             │
             ▼
    ┌──────────────────────┐
    │ Request Assembly     │
    │ (Reassemble JSON)    │
    └────────┬─────────────┘
             │
             ▼
    ┌────────────────────────────┐
    │ Send to LLM Provider       │
    │ (Masked PII, Clean secrets)│
    └────────┬───────────────────┘
             │
             ▼ (Response with placeholders)
    ┌──────────────────────┐
    │ Response Unmasking   │
    │ (Restore original)   │
    └────────┬─────────────┘
             │
             ▼
    ┌──────────────────────┐
    │ User Gets Response   │
    │ (Original data back) │
    └──────────────────────┘
```

## Key Files Reference

| File | Purpose |
|------|---------|
| [src/routes/openai.ts](src/routes/openai.ts) | Main request/response flow orchestration |
| [src/pii/detect.ts](src/pii/detect.ts) | Presidio integration for PII detection |
| [src/pii/mask.ts](src/pii/mask.ts) | High-level masking API |
| [src/masking/service.ts](src/masking/service.ts) | Core span-based masking logic |
| [src/masking/placeholders.ts](src/masking/placeholders.ts) | Placeholder generation & formatting |
| [src/masking/context.ts](src/masking/context.ts) | Context management (mapping storage) |
| [src/masking/conflict-resolver.ts](src/masking/conflict-resolver.ts) | Entity overlap resolution |
| [src/masking/extractors/openai.ts](src/masking/extractors/openai.ts) | Request/response transformation |
| [src/providers/openai/stream-transformer.ts](src/providers/openai/stream-transformer.ts) | Streaming response unmasking |
| [src/services/pii.ts](src/services/pii.ts) | High-level service API |

## Extending the System

### Adding a New Provider

Implement the `RequestExtractor` interface:

```typescript
export const customExtractor: RequestExtractor<CustomRequest, CustomResponse> = {
  extractTexts(request: CustomRequest): TextSpan[] {
    // Extract all text content from your format
  },
  
  applyMasked(request: CustomRequest, spans: MaskedSpan[]): CustomRequest {
    // Reassemble masked spans back into request format
  },
  
  unmaskResponse(response: CustomResponse, context: PlaceholderContext): CustomResponse {
    // Restore placeholders in response
  }
};
```

### Custom PII Entities

Add new entity types to Presidio:
1. Update Presidio configuration (see `docker/presidio/languages.yaml`)
2. Add to `config.yaml` entity list
3. Update whitelist if needed

## Testing

Run the masking test suite:

```bash
bun test src/pii/mask.test.ts
bun test src/masking/
```

Run accuracy benchmarks:

```bash
bun run benchmark:accuracy
```

## Security Considerations

1. **Placeholder Format**: Cannot contain sensitive data - just position markers
2. **Context Storage**: PlaceholderContext is short-lived (request scope only)
3. **Logging**: Logs preserve original PII for audit trails (controlled by logging config)
4. **Transport**: Use HTTPS for all communication with external providers
5. **Whitelist**: Review whitelist regularly for overly broad patterns

---

**Last Updated**: January 2026  
**Version**: 0.2.1
