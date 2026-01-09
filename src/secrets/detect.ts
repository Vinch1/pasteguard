import type { SecretsDetectionConfig } from "../config";
import type { ChatCompletionRequest } from "../services/llm-client";

export interface SecretsMatch {
  type: "OPENSSH_PRIVATE_KEY" | "PEM_PRIVATE_KEY";
  count: number;
}

export interface SecretsRedaction {
  start: number;
  end: number;
  type: string;
}

export interface SecretsDetectionResult {
  detected: boolean;
  matches: SecretsMatch[];
  redactions?: SecretsRedaction[];
}

/**
 * Extracts all text content from an OpenAI chat completion request
 *
 * Concatenates content from all messages (system, user, assistant) for secrets scanning.
 * The proxy validation ensures content is always a string, so we can safely access it directly.
 *
 * Returns concatenated text for secrets scanning.
 */
export function extractTextFromRequest(body: ChatCompletionRequest): string {
  return body.messages
    .map((message) => message.content)
    .filter(
      (content): content is string =>
        typeof content === "string" && content.length > 0
    )
    .join("\n");
}

/**
 * Detects secret material (e.g. private keys) in text
 *
 * Scans for:
 * - OpenSSH private keys: -----BEGIN OPENSSH PRIVATE KEY-----
 * - PEM private keys: RSA, PRIVATE KEY, ENCRYPTED PRIVATE KEY
 *
 * Respects max_scan_chars limit for performance.
 */
export function detectSecrets(
  text: string,
  config: SecretsDetectionConfig
): SecretsDetectionResult {
  if (!config.enabled) {
    return { detected: false, matches: [] };
  }

  // Apply max_scan_chars limit
  const textToScan =
    config.max_scan_chars > 0 ? text.slice(0, config.max_scan_chars) : text;

  const matches: SecretsMatch[] = [];
  const redactions: SecretsRedaction[] = [];

  // Track which entities to detect based on config
  const entitiesToDetect = new Set(config.entities);

  // OpenSSH private key pattern
  if (entitiesToDetect.has("OPENSSH_PRIVATE_KEY")) {
    const opensshPattern =
      /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g;
    const opensshMatches = textToScan.matchAll(opensshPattern);
    let count = 0;
    for (const match of opensshMatches) {
      count++;
      if (match.index !== undefined) {
        redactions.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "OPENSSH_PRIVATE_KEY",
        });
      }
    }
    if (count > 0) {
      matches.push({ type: "OPENSSH_PRIVATE_KEY", count });
    }
  }

  // PEM private key patterns
  if (entitiesToDetect.has("PEM_PRIVATE_KEY")) {
    // Track all matched positions to avoid double counting
    const matchedPositions = new Set<number>();

    // RSA PRIVATE KEY
    const rsaPattern =
      /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g;
    let rsaCount = 0;
    for (const match of textToScan.matchAll(rsaPattern)) {
      rsaCount++;
      if (match.index !== undefined) {
        matchedPositions.add(match.index);
        redactions.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "PEM_PRIVATE_KEY",
        });
      }
    }

    // PRIVATE KEY (generic) - exclude RSA matches
    const privateKeyPattern =
      /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g;
    let privateKeyCount = 0;
    for (const match of textToScan.matchAll(privateKeyPattern)) {
      if (match.index !== undefined && !matchedPositions.has(match.index)) {
        privateKeyCount++;
        matchedPositions.add(match.index);
        redactions.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "PEM_PRIVATE_KEY",
        });
      }
    }

    // ENCRYPTED PRIVATE KEY
    const encryptedPattern =
      /-----BEGIN ENCRYPTED PRIVATE KEY-----[\s\S]*?-----END ENCRYPTED PRIVATE KEY-----/g;
    let encryptedCount = 0;
    for (const match of textToScan.matchAll(encryptedPattern)) {
      if (match.index !== undefined && !matchedPositions.has(match.index)) {
        encryptedCount++;
        matchedPositions.add(match.index);
        redactions.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "PEM_PRIVATE_KEY",
        });
      }
    }

    const totalPemCount = rsaCount + privateKeyCount + encryptedCount;
    if (totalPemCount > 0) {
      matches.push({ type: "PEM_PRIVATE_KEY", count: totalPemCount });
    }
  }

  // Sort redactions by start position (descending) for safe replacement
  redactions.sort((a, b) => b.start - a.start);

  return {
    detected: matches.length > 0,
    matches,
    redactions: redactions.length > 0 ? redactions : undefined,
  };
}
