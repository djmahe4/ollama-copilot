/**
 * Shared JSON parsing helpers for agent responses
 */

import { OllamaClient } from '../ollama/client';
import { OllamaMessage } from '../protocol/types';

/**
 * Parse a JSON object from raw model output.
 * Handles markdown code fences and extra surrounding text.
 */
export function parseJsonObject<T>(text: string): T | null {
  try {
    const normalized = stripCodeFences(text).trim();
    const jsonObject = extractFirstJsonObject(normalized);
    if (!jsonObject) {
      return null;
    }
    return JSON.parse(jsonObject) as T;
  } catch (error) {
    console.error('JSON parse error:', error);
    return null;
  }
}

/**
 * Attempt to parse JSON and retry with a fix prompt if it fails.
 */
export async function parseAndRetryJson<T>(
  ollama: OllamaClient,
  messages: OllamaMessage[],
  options?: any,
  onRetry?: (msg: string) => void
): Promise<T> {
  let response = await ollama.chat(messages, options);
  let result = parseJsonObject<T>(response);
  
  if (!result) {
    onRetry?.('Retrying JSON parsing...');
    
    messages.push({ role: 'assistant', content: response });
    messages.push({ 
      role: 'user', 
      content: 'The JSON is invalid. Please output ONLY valid JSON with no markdown or extra text.' 
    });
    
    response = await ollama.chat(messages, options);
    result = parseJsonObject<T>(response);
  }
  
  if (!result) {
    throw new Error('Failed to get valid JSON response after retry');
  }
  
  return result;
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '');
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.substring(start, index + 1);
      }
    }
  }

  return null;
}
